import { TxTree } from "../core/tree/vtxoTree";
import { Outpoint, VirtualCoin } from "../core/wallet";
import { TreeNonces, TreePartialSigs } from "../core/signingSession";
import { hex } from "@scure/base";

// Define event types
export interface ArkEvent {
    type: "vtxo_created" | "vtxo_spent" | "vtxo_swept" | "vtxo_expired";
    data: {
        txid?: string;
        address?: string;
        amount?: number;
        roundTxid?: string;
        expireAt?: number;
    };
}

export type NoteInput = string;

export type VtxoInput = {
    outpoint: Outpoint;
    tapscripts: string[];
};

export type Input = NoteInput | VtxoInput;

export type Output = {
    address: string; // onchain or off-chain
    amount: bigint; // Amount to send in satoshis
};

export enum SettlementEventType {
    Finalization = "finalization",
    Finalized = "finalized",
    Failed = "failed",
    SigningStart = "signing_start",
    SigningNoncesGenerated = "signing_nonces_generated",
}

export type FinalizationEvent = {
    type: SettlementEventType.Finalization;
    id: string;
    roundTx: string;
    vtxoTree: TxTree;
    connectors: TxTree;
    minRelayFeeRate: bigint; // Using bigint for int64
    connectorsIndex: Map<string, Outpoint>; // `vtxoTxid:vtxoIndex` -> connectorOutpoint
};

export type FinalizedEvent = {
    type: SettlementEventType.Finalized;
    id: string;
    roundTxid: string;
};

export type FailedEvent = {
    type: SettlementEventType.Failed;
    id: string;
    reason: string;
};

export type SigningStartEvent = {
    type: SettlementEventType.SigningStart;
    id: string;
    cosignersPublicKeys: string[];
    unsignedVtxoTree: TxTree;
    unsignedSettlementTx: string;
};

export type SigningNoncesGeneratedEvent = {
    type: SettlementEventType.SigningNoncesGenerated;
    id: string;
    treeNonces: TreeNonces;
};

export type SettlementEvent =
    | FinalizationEvent
    | FinalizedEvent
    | FailedEvent
    | SigningStartEvent
    | SigningNoncesGeneratedEvent;

export interface ArkInfo {
    pubkey: string;
    batchExpiry: bigint;
    unilateralExitDelay: bigint;
    roundInterval: bigint;
    network: string;
    dust: bigint;
    boardingDescriptorTemplate: string;
    vtxoDescriptorTemplates: string[];
    forfeitAddress: string;
    marketHour?: {
        start: number;
        end: number;
    };
}

export interface ArkProvider {
    getInfo(): Promise<ArkInfo>;
    getVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    submitVirtualTx(psbtBase64: string): Promise<string>;
    subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void>;
    registerInputsForNextRound(inputs: Input[]): Promise<{ requestId: string }>;
    registerOutputsForNextRound(
        requestId: string,
        outputs: Output[],
        vtxoTreeSigningPublicKeys: string[],
        signAll?: boolean
    ): Promise<void>;
    submitTreeNonces(
        settlementID: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void>;
    submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void>;
    submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void>;
    ping(paymentID: string): Promise<void>;
    getEventStream(): AsyncIterableIterator<SettlementEvent>;
}

export class RestArkProvider implements ArkProvider {
    constructor(public serverUrl: string) {}

    async getInfo(): Promise<ArkInfo> {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to get server info: ${response.statusText}`
            );
        }
        const fromServer = await response.json();
        return {
            ...fromServer,
            batchExpiry: fromServer.vtxoTreeExpiry,
        };
    }

    async getVirtualCoins(address: string): Promise<{
        spendableVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }> {
        const url = `${this.serverUrl}/v1/vtxos/${address}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VTXOs: ${response.statusText}`);
        }
        const data = await response.json();

        // Convert from server format to our internal VTXO format and only return spendable coins (settled or pending)
        const convert = (vtxo: any): VirtualCoin => ({
            txid: vtxo.outpoint.txid,
            vout: vtxo.outpoint.vout,
            value: Number(vtxo.amount),
            status: {
                confirmed: !!vtxo.roundTxid,
            },
            virtualStatus: {
                state: vtxo.isPending ? "pending" : "settled",
                batchTxID: vtxo.roundTxid,
                batchExpiry: vtxo.expireAt ? Number(vtxo.expireAt) : undefined,
            },
            spentBy: vtxo.spentBy,
            createdAt: new Date(vtxo.createdAt * 1000),
        });

        return {
            spendableVtxos: [...(data.spendableVtxos || [])].map(convert),
            spentVtxos: [...(data.spentVtxos || [])].map(convert),
        };
    }

    async submitVirtualTx(psbtBase64: string): Promise<string> {
        const url = `${this.serverUrl}/v1/redeem-tx`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                redeem_tx: psbtBase64,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const grpcError = JSON.parse(errorText);
                // gRPC errors usually have a message and code field
                throw new Error(
                    `Failed to submit virtual transaction: ${grpcError.message || grpcError.error || errorText}`
                );
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_) {
                // If JSON parse fails, use the raw error text
                throw new Error(
                    `Failed to submit virtual transaction: ${errorText}`
                );
            }
        }

        const data = await response.json();
        // Handle both current and future response formats
        return data.txid || data.signedRedeemTx;
    }

    async subscribeToEvents(
        callback: (event: ArkEvent) => void
    ): Promise<() => void> {
        const url = `${this.serverUrl}/v1/events`;
        let abortController = new AbortController();

        (async () => {
            while (!abortController.signal.aborted) {
                try {
                    const response = await fetch(url, {
                        headers: {
                            Accept: "application/json",
                        },
                        signal: abortController.signal,
                    });

                    if (!response.ok) {
                        throw new Error(
                            `Unexpected status ${response.status} when fetching event stream`
                        );
                    }

                    if (!response.body) {
                        throw new Error("Response body is null");
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";

                    while (!abortController.signal.aborted) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        // Append new data to buffer and split by newlines
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n");

                        // Process all complete lines
                        for (let i = 0; i < lines.length - 1; i++) {
                            const line = lines[i].trim();
                            if (!line) continue;

                            try {
                                const data = JSON.parse(line);
                                callback(data);
                            } catch (err) {
                                console.error("Failed to parse event:", err);
                            }
                        }

                        // Keep the last partial line in the buffer
                        buffer = lines[lines.length - 1];
                    }
                } catch (error) {
                    if (!abortController.signal.aborted) {
                        console.error("Event stream error:", error);
                    }
                }
            }
        })();

        // Return unsubscribe function
        return () => {
            abortController.abort();
            // Create a new controller for potential future subscriptions
            abortController = new AbortController();
        };
    }

    async registerInputsForNextRound(
        inputs: Input[]
    ): Promise<{ requestId: string }> {
        const url = `${this.serverUrl}/v1/round/registerInputs`;
        const vtxoInputs: ProtoTypes.Input[] = [];
        const noteInputs: string[] = [];

        for (const input of inputs) {
            if (typeof input === "string") {
                noteInputs.push(input);
            } else {
                vtxoInputs.push({
                    outpoint: {
                        txid: input.outpoint.txid,
                        vout: input.outpoint.vout,
                    },
                    tapscripts: {
                        scripts: input.tapscripts,
                    },
                });
            }
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                inputs: vtxoInputs,
                notes: noteInputs,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to register inputs: ${errorText}`);
        }

        const data = await response.json();
        return { requestId: data.requestId };
    }

    async registerOutputsForNextRound(
        requestId: string,
        outputs: Output[],
        cosignersPublicKeys: string[],
        signingAll = false
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/registerOutputs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                requestId,
                outputs: outputs.map(
                    (output): ProtoTypes.Output => ({
                        address: output.address,
                        amount: output.amount.toString(10),
                    })
                ),
                musig2: {
                    cosignersPublicKeys,
                    signingAll,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to register outputs: ${errorText}`);
        }
    }

    async submitTreeNonces(
        settlementID: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/tree/submitNonces`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                roundId: settlementID,
                pubkey,
                treeNonces: encodeNoncesMatrix(nonces),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit tree nonces: ${errorText}`);
        }
    }

    async submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/tree/submitSignatures`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                roundId: settlementID,
                pubkey,
                treeSignatures: encodeSignaturesMatrix(signatures),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to submit tree signatures: ${errorText}`);
        }
    }

    async submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/round/submitForfeitTxs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signedForfeitTxs: signedForfeitTxs,
                signedRoundTx: signedRoundTx,
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to submit forfeit transactions: ${response.statusText}`
            );
        }
    }

    async ping(requestId: string): Promise<void> {
        const url = `${this.serverUrl}/v1/round/ping/${requestId}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Ping failed: ${response.statusText}`);
        }
    }

    async *getEventStream(): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/events`;

        while (true) {
            try {
                const response = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                });

                if (!response.ok) {
                    throw new Error(
                        `Unexpected status ${response.status} when fetching event stream`
                    );
                }

                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    // Append new data to buffer and split by newlines
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    // Process all complete lines
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            const data = JSON.parse(line);
                            const event = this.parseSettlementEvent(
                                data.result
                            );
                            if (event) {
                                yield event;
                            }
                        } catch (err) {
                            console.error("Failed to parse event:", err);
                            throw err;
                        }
                    }

                    // Keep the last partial line in the buffer
                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                console.error("Event stream error:", error);
                throw error;
            }
        }
    }

    private toConnectorsIndex(
        connectorsIndex: ProtoTypes.RoundFinalizationEvent["connectorsIndex"]
    ): Map<string, Outpoint> {
        return new Map(
            Object.entries(connectorsIndex).map(([key, value]) => [
                key,
                { txid: value.txid, vout: value.vout },
            ])
        );
    }
    private toTxTree(t: ProtoTypes.Tree): TxTree {
        // collect the parent txids to determine later if a node is a leaf
        const parentTxids = new Set<string>();
        t.levels.forEach((level) =>
            level.nodes.forEach((node) => {
                if (node.parentTxid) {
                    parentTxids.add(node.parentTxid);
                }
            })
        );

        return new TxTree(
            t.levels.map((level) =>
                level.nodes.map((node) => ({
                    txid: node.txid,
                    tx: node.tx,
                    parentTxid: node.parentTxid,
                    leaf: !parentTxids.has(node.txid),
                }))
            )
        );
    }

    private parseSettlementEvent(
        data: ProtoTypes.EventData
    ): SettlementEvent | null {
        // Check for Finalization event
        if (data.roundFinalization) {
            return {
                type: SettlementEventType.Finalization,
                id: data.roundFinalization.id,
                roundTx: data.roundFinalization.roundTx,
                vtxoTree: this.toTxTree(data.roundFinalization.vtxoTree),
                connectors: this.toTxTree(data.roundFinalization.connectors),
                connectorsIndex: this.toConnectorsIndex(
                    data.roundFinalization.connectorsIndex
                ),
                // divide by 1000 to convert to sat/vbyte
                minRelayFeeRate:
                    BigInt(data.roundFinalization.minRelayFeeRate) /
                    BigInt(1000),
            };
        }

        // Check for Finalized event
        if (data.roundFinalized) {
            return {
                type: SettlementEventType.Finalized,
                id: data.roundFinalized.id,
                roundTxid: data.roundFinalized.roundTxid,
            };
        }

        // Check for Failed event
        if (data.roundFailed) {
            return {
                type: SettlementEventType.Failed,
                id: data.roundFailed.id,
                reason: data.roundFailed.reason,
            };
        }

        // Check for Signing event
        if (data.roundSigning) {
            return {
                type: SettlementEventType.SigningStart,
                id: data.roundSigning.id,
                cosignersPublicKeys: data.roundSigning.cosignersPubkeys,
                unsignedVtxoTree: this.toTxTree(
                    data.roundSigning.unsignedVtxoTree
                ),
                unsignedSettlementTx: data.roundSigning.unsignedRoundTx,
            };
        }

        // Check for SigningNoncesGenerated event
        if (data.roundSigningNoncesGenerated) {
            return {
                type: SettlementEventType.SigningNoncesGenerated,
                id: data.roundSigningNoncesGenerated.id,
                treeNonces: decodeNoncesMatrix(
                    hex.decode(data.roundSigningNoncesGenerated.treeNonces)
                ),
            };
        }

        console.warn("Unknown event structure:", data);
        return null;
    }
}

function encodeMatrix(matrix: Uint8Array[][]): Uint8Array {
    // Calculate total size needed:
    // 4 bytes for number of rows
    // For each row: 4 bytes for length + sum of encoded cell lengths + isNil byte * cell count
    let totalSize = 4;
    for (const row of matrix) {
        totalSize += 4; // row length
        for (const cell of row) {
            totalSize += 1;
            totalSize += cell.length;
        }
    }

    // Create buffer and DataView
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Write number of rows
    view.setUint32(offset, matrix.length, true); // true for little-endian
    offset += 4;

    // Write each row
    for (const row of matrix) {
        // Write row length
        view.setUint32(offset, row.length, true);
        offset += 4;

        // Write each cell
        for (const cell of row) {
            const notNil = cell.length > 0;
            view.setInt8(offset, notNil ? 1 : 0);
            offset += 1;
            if (!notNil) {
                continue;
            }
            new Uint8Array(buffer).set(cell, offset);
            offset += cell.length;
        }
    }

    return new Uint8Array(buffer);
}

function decodeMatrix(matrix: Uint8Array, cellLength: number): Uint8Array[][] {
    // Create DataView to read the buffer
    const view = new DataView(
        matrix.buffer,
        matrix.byteOffset,
        matrix.byteLength
    );
    let offset = 0;

    // Read number of rows
    const numRows = view.getUint32(offset, true); // true for little-endian
    offset += 4;

    // Initialize result matrix
    const result: Uint8Array[][] = [];

    // Read each row
    for (let i = 0; i < numRows; i++) {
        // Read row length
        const rowLength = view.getUint32(offset, true);
        offset += 4;

        const row: Uint8Array[] = [];

        // Read each cell in the row
        for (let j = 0; j < rowLength; j++) {
            const notNil = view.getUint8(offset) === 1;
            offset += 1;
            if (notNil) {
                const cell = new Uint8Array(
                    matrix.buffer,
                    matrix.byteOffset + offset,
                    cellLength
                );
                row.push(new Uint8Array(cell));
                offset += cellLength;
            } else {
                row.push(new Uint8Array());
            }
        }

        result.push(row);
    }

    return result;
}

function decodeNoncesMatrix(matrix: Uint8Array): TreeNonces {
    const decoded = decodeMatrix(matrix, 66);
    return decoded.map((row) => row.map((nonce) => ({ pubNonce: nonce })));
}

function encodeNoncesMatrix(nonces: TreeNonces): string {
    return hex.encode(
        encodeMatrix(
            nonces.map((row) =>
                row.map((nonce) => (nonce ? nonce.pubNonce : new Uint8Array()))
            )
        )
    );
}

function encodeSignaturesMatrix(signatures: TreePartialSigs): string {
    return hex.encode(
        encodeMatrix(
            signatures.map((row) =>
                row.map((s) => (s ? s.encode() : new Uint8Array()))
            )
        )
    );
}

// ProtoTypes namespace defines unexported types representing the raw data received from the server
namespace ProtoTypes {
    interface Node {
        txid: string;
        tx: string;
        parentTxid: string;
    }
    interface TreeLevel {
        nodes: Node[];
    }
    export interface Tree {
        levels: TreeLevel[];
    }

    interface RoundFailed {
        id: string;
        reason: string;
    }

    export interface RoundFinalizationEvent {
        id: string;
        roundTx: string;
        vtxoTree: Tree;
        connectors: Tree;
        connectorsIndex: {
            [key: string]: {
                txid: string;
                vout: number;
            };
        };
        minRelayFeeRate: string;
    }

    interface RoundFinalizedEvent {
        id: string;
        roundTxid: string;
    }

    interface RoundSigningEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedVtxoTree: Tree;
        unsignedRoundTx: string;
    }

    interface RoundSigningNoncesGeneratedEvent {
        id: string;
        treeNonces: string;
    }

    // Update the EventData interface to match the Golang structure
    export interface EventData {
        roundFailed?: RoundFailed;
        roundFinalization?: RoundFinalizationEvent;
        roundFinalized?: RoundFinalizedEvent;
        roundSigning?: RoundSigningEvent;
        roundSigningNoncesGenerated?: RoundSigningNoncesGeneratedEvent;
    }

    export interface Input {
        outpoint: {
            txid: string;
            vout: number;
        };
        tapscripts: {
            scripts: string[];
        };
    }

    export interface Output {
        address: string;
        amount: string;
    }
}
