import { TreeNode, TxTree } from "../tree/vtxoTree";
import { Outpoint, VirtualCoin } from "../wallet";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
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

export type VtxoInput = {
    outpoint: Outpoint;
    tapscripts: string[];
};

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
    BatchStarted = "batch_started",
    BatchTree = "batch_tree",
    BatchTreeSignature = "batch_tree_signature",
}

export type FinalizationEvent = {
    type: SettlementEventType.Finalization;
    id: string;
    roundTx: string;
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
    unsignedSettlementTx: string;
};

export type SigningNoncesGeneratedEvent = {
    type: SettlementEventType.SigningNoncesGenerated;
    id: string;
    treeNonces: TreeNonces;
};

export type BatchStartedEvent = {
    type: SettlementEventType.BatchStarted;
    id: string;
    intentIdHashes: string[];
    batchExpiry: bigint;
    forfeitAddress: string;
};

export type BatchTreeEvent = {
    type: SettlementEventType.BatchTree;
    id: string;
    topic: string[];
    batchIndex: number;
    treeTx: TreeNode;
};

export type BatchTreeSignatureEvent = {
    type: SettlementEventType.BatchTreeSignature;
    id: string;
    topic: string[];
    batchIndex: number;
    level: number;
    levelIndex: number;
    signature: string;
};

export type SettlementEvent =
    | FinalizationEvent
    | FinalizedEvent
    | FailedEvent
    | SigningStartEvent
    | SigningNoncesGeneratedEvent
    | BatchStartedEvent
    | BatchTreeEvent
    | BatchTreeSignatureEvent;

export interface ArkInfo {
    pubkey: string;
    batchExpiry: bigint;
    unilateralExitDelay: bigint;
    boardingExitDelay: bigint;
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

export interface Round {
    id: string;
    start: Date;
    end: Date;
    vtxoTree: TxTree;
    forfeitTxs: string[];
    connectors: TxTree;
}

export interface ArkProvider {
    getInfo(): Promise<ArkInfo>;
    submitVirtualTx(psbtBase64: string): Promise<string>;
    subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void>;
    registerInputsForNextRound(
        inputs: VtxoInput[]
    ): Promise<{ requestId: string }>;
    confirmRegistration(intentId: string): Promise<void>;
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
    getEventStream(signal: AbortSignal): AsyncIterableIterator<SettlementEvent>;
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
            unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
            batchExpiry: BigInt(fromServer.vtxoTreeExpiry ?? 0),
            boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
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
        inputs: VtxoInput[]
    ): Promise<{ requestId: string }> {
        const url = `${this.serverUrl}/v1/round/registerInputs`;
        const vtxoInputs: ProtoTypes.Input[] = [];

        for (const input of inputs) {
            vtxoInputs.push({
                outpoint: {
                    txid: input.outpoint.txid,
                    vout: input.outpoint.vout,
                },
                taprootTree: {
                    scripts: input.tapscripts,
                },
            });
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                inputs: vtxoInputs,
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

    async confirmRegistration(intentId: string): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/ack`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intentId,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to confirm registration: ${errorText}`);
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

    async *getEventStream(
        signal: AbortSignal
    ): AsyncIterableIterator<SettlementEvent> {
        const url = `${this.serverUrl}/v1/events`;

        while (!signal?.aborted) {
            try {
                const response = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                    signal,
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

                while (!signal?.aborted) {
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
                if (error instanceof Error && error.name === "AbortError") {
                    break;
                }
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

    private parseSettlementEvent(
        data: ProtoTypes.EventData
    ): SettlementEvent | null {
        // Check for BatchStarted event
        if (data.batchStarted) {
            return {
                type: SettlementEventType.BatchStarted,
                id: data.batchStarted.id,
                intentIdHashes: data.batchStarted.intentIdHashes,
                batchExpiry: BigInt(data.batchStarted.batchExpiry),
                forfeitAddress: data.batchStarted.forfeitAddress,
            };
        }

        // Check for Finalization event
        if (data.roundFinalization) {
            return {
                type: SettlementEventType.Finalization,
                id: data.roundFinalization.id,
                roundTx: data.roundFinalization.roundTx,
                connectorsIndex: this.toConnectorsIndex(
                    data.roundFinalization.connectorsIndex
                ),
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

        // Check for BatchTree event
        if (data.batchTree) {
            return {
                type: SettlementEventType.BatchTree,
                id: data.batchTree.id,
                topic: data.batchTree.topic,
                batchIndex: data.batchTree.batchIndex,
                treeTx: data.batchTree.treeTx,
            };
        }

        if (data.batchTreeSignature) {
            return {
                type: SettlementEventType.BatchTreeSignature,
                id: data.batchTreeSignature.id,
                topic: data.batchTreeSignature.topic,
                batchIndex: data.batchTreeSignature.batchIndex,
                level: data.batchTreeSignature.level,
                levelIndex: data.batchTreeSignature.levelIndex,
                signature: data.batchTreeSignature.signature,
            };
        }

        console.warn("Unknown event type:", data);
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
export namespace ProtoTypes {
    export interface Node {
        txid: string;
        tx: string;
        parentTxid: string;
        level: number;
        levelIndex: number;
        leaf: boolean;
    }
    interface TreeLevel {
        nodes: Node[];
    }
    export interface Tree {
        levels: TreeLevel[];
    }

    interface BatchStartedEvent {
        id: string;
        intentIdHashes: string[];
        batchExpiry: string;
        forfeitAddress: string;
    }

    interface RoundFailed {
        id: string;
        reason: string;
    }

    export interface RoundFinalizationEvent {
        id: string;
        roundTx: string;
        connectorsIndex: {
            [key: string]: {
                txid: string;
                vout: number;
            };
        };
    }

    interface RoundFinalizedEvent {
        id: string;
        roundTxid: string;
    }

    interface RoundSigningEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedRoundTx: string;
    }

    interface RoundSigningNoncesGeneratedEvent {
        id: string;
        treeNonces: string;
    }

    interface BatchTreeEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        treeTx: Node;
    }

    interface BatchTreeSignatureEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        level: number;
        levelIndex: number;
        signature: string;
    }

    // Update the EventData interface to match the Golang structure
    export interface EventData {
        batchStarted?: BatchStartedEvent;
        roundFailed?: RoundFailed;
        roundFinalization?: RoundFinalizationEvent;
        roundFinalized?: RoundFinalizedEvent;
        roundSigning?: RoundSigningEvent;
        roundSigningNoncesGenerated?: RoundSigningNoncesGeneratedEvent;
        batchTree?: BatchTreeEvent;
        batchTreeSignature?: BatchTreeSignatureEvent;
    }

    export interface Input {
        outpoint: {
            txid: string;
            vout: number;
        };
        taprootTree: {
            scripts: string[];
        };
    }

    export interface Output {
        address: string;
        amount: string;
    }

    export interface Round {
        id: string;
        start: string; // int64 as string
        end: string; // int64 as string
        roundTx: string;
        vtxoTree: Tree;
        forfeitTxs: string[];
        connectors: Tree;
        stage: string; // RoundStage as string
    }
}
