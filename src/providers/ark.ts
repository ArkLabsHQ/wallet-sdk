import { TreeNode, TxTree } from "../tree/vtxoTree";
import { Outpoint } from "../wallet";
import { TreeNonces, TreePartialSigs } from "../tree/signingSession";
import { hex } from "@scure/base";

export type VtxoInput = {
    outpoint: Outpoint;
    tapscripts: string[];
};

export type Output = {
    address: string; // onchain or off-chain
    amount: bigint; // Amount to send in satoshis
};

export enum SettlementEventType {
    BatchStarted = "batch_started",
    BatchFinalization = "batch_finalization",
    BatchFinalized = "batch_finalized",
    BatchFailed = "batch_failed",
    TreeSigningStarted = "tree_signing_started",
    TreeNoncesAggregated = "tree_nonces_aggregated",
    TreeTx = "tree_tx",
    TreeSignature = "tree_signature",
}

export type BatchFinalizationEvent = {
    type: SettlementEventType.BatchFinalization;
    id: string;
    commitmentTx: string;
    connectorsIndex: Map<string, Outpoint>; // `vtxoTxid:vtxoIndex` -> connectorOutpoint
};

export type BatchFinalizedEvent = {
    type: SettlementEventType.BatchFinalized;
    id: string;
    commitmentTxid: string;
};

export type BatchFailedEvent = {
    type: SettlementEventType.BatchFailed;
    id: string;
    reason: string;
};

export type TreeSigningStartedEvent = {
    type: SettlementEventType.TreeSigningStarted;
    id: string;
    cosignersPublicKeys: string[];
    unsignedCommitmentTx: string;
};

export type TreeNoncesAggregatedEvent = {
    type: SettlementEventType.TreeNoncesAggregated;
    id: string;
    treeNonces: TreeNonces;
};

export type BatchStartedEvent = {
    type: SettlementEventType.BatchStarted;
    id: string;
    intentIdHashes: string[];
    batchExpiry: bigint;
};

export type TreeTxEvent = {
    type: SettlementEventType.TreeTx;
    id: string;
    topic: string[];
    batchIndex: number;
    treeTx: TreeNode;
};

export type TreeSignatureEvent = {
    type: SettlementEventType.TreeSignature;
    id: string;
    topic: string[];
    batchIndex: number;
    level: number;
    levelIndex: number;
    signature: string;
};

export type SettlementEvent =
    | BatchFinalizationEvent
    | BatchFinalizedEvent
    | BatchFailedEvent
    | TreeSigningStartedEvent
    | TreeNoncesAggregatedEvent
    | BatchStartedEvent
    | TreeTxEvent
    | TreeSignatureEvent;

export interface ArkInfo {
    pubkey: string;
    vtxoTreeExpiry: bigint;
    unilateralExitDelay: bigint;
    roundInterval: bigint;
    network: string;
    dust: bigint;
    forfeitAddress: string;
    marketHour?: {
        start: number;
        end: number;
    };
    version: string;
    utxoMinAmount: bigint;
    utxoMaxAmount: bigint; // -1 means no limit (default), 0 means boarding not allowed
    vtxoMinAmount: bigint;
    vtxoMaxAmount: bigint; // -1 means no limit (default)
    boardingExitDelay: bigint;
}

export interface Round {
    id: string;
    start: Date;
    end: Date;
    vtxoTree: TxTree;
    forfeitTxs: string[];
    connectors: TxTree;
}

export interface Intent {
    signature: string;
    message: string;
}

export interface TxNotification {
    txid: string;
    spentVtxos: Vtxo[];
    spendableVtxos: Vtxo[];
    hex: string;
}

export interface Vtxo {
    outpoint: Outpoint;
    amount: bigint;
    script: string;
    createdAt: bigint;
    expiresAt: bigint;
    commitmentTxid: string;
    preconfirmed: boolean;
    swept: boolean;
    redeemed: boolean;
    spent: boolean;
    spentBy: string;
}

export interface ArkProvider {
    getInfo(): Promise<ArkInfo>;
    submitTx(
        signedArkTx: string,
        checkpointTxs: string[]
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
    registerIntent(intent: Intent): Promise<string>;
    deleteIntent(intent: Intent): Promise<void>;
    confirmRegistration(intentId: string): Promise<{ blindedCreds: string }>;
    submitTreeNonces(
        batchId: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void>;
    submitTreeSignatures(
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void>;
    submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedCommitmentTx?: string
    ): Promise<void>;
    getEventStream(signal: AbortSignal): AsyncIterableIterator<SettlementEvent>;
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
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
            vtxoTreeExpiry: BigInt(fromServer.vtxoTreeExpiry ?? 0),
            unilateralExitDelay: BigInt(fromServer.unilateralExitDelay ?? 0),
            roundInterval: BigInt(fromServer.roundInterval ?? 0),
            dust: BigInt(fromServer.dust ?? 0),
            utxoMinAmount: BigInt(fromServer.utxoMinAmount ?? 0),
            utxoMaxAmount: BigInt(fromServer.utxoMaxAmount ?? -1),
            vtxoMinAmount: BigInt(fromServer.vtxoMinAmount ?? 0),
            vtxoMaxAmount: BigInt(fromServer.vtxoMaxAmount ?? -1),
            boardingExitDelay: BigInt(fromServer.boardingExitDelay ?? 0),
        };
    }

    async submitTx(
        signedArkTx: string,
        checkpointTxs: string[]
    ): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }> {
        const url = `${this.serverUrl}/v1/tx/submit`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signedArkTx: signedArkTx,
                checkpointTxs: checkpointTxs,
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
        return {
            arkTxid: data.arkTxid,
            finalArkTx: data.finalArkTx,
            signedCheckpointTxs: data.signedCheckpointTxs,
        };
    }

    async finalizeTx(
        arkTxid: string,
        finalCheckpointTxs: string[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/tx/finalize`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                arkTxid,
                finalCheckpointTxs,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Failed to finalize offchain transaction: ${errorText}`
            );
        }
    }

    async registerIntent(intent: Intent): Promise<string> {
        const url = `${this.serverUrl}/v1/batch/registerIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                intent: {
                    signature: intent.signature,
                    message: intent.message,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to register intent: ${errorText}`);
        }

        const data = await response.json();
        return data.intentId;
    }

    async deleteIntent(intent: Intent): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/deleteIntent`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                proof: {
                    signature: intent.signature,
                    message: intent.message,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to delete intent: ${errorText}`);
        }
    }

    async confirmRegistration(
        intentId: string
    ): Promise<{ blindedCreds: string }> {
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

        const data = await response.json();
        return { blindedCreds: data.blindedCreds };
    }

    async submitTreeNonces(
        batchId: string,
        pubkey: string,
        nonces: TreeNonces
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitNonces`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                batchId,
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
        batchId: string,
        pubkey: string,
        signatures: TreePartialSigs
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/tree/submitSignatures`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                batchId,
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
        signedCommitmentTx?: string
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/batch/submitForfeitTxs`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                signedForfeitTxs: signedForfeitTxs,
                signedCommitmentTx: signedCommitmentTx,
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
        const url = `${this.serverUrl}/v1/batch/events`;

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

    async *getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }> {
        const url = `${this.serverUrl}/v1/txs`;

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
                        `Unexpected status ${response.status} when fetching transaction stream`
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
                            const txNotification =
                                this.parseTransactionNotification(data.result);
                            if (txNotification) {
                                yield txNotification;
                            }
                        } catch (err) {
                            console.error(
                                "Failed to parse transaction notification:",
                                err
                            );
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
                console.error("Transaction stream error:", error);
                throw error;
            }
        }
    }

    private toConnectorsIndex(
        connectorsIndex: ProtoTypes.BatchFinalizationEvent["connectorsIndex"]
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
            };
        }

        // Check for BatchFinalization event
        if (data.batchFinalization) {
            return {
                type: SettlementEventType.BatchFinalization,
                id: data.batchFinalization.id,
                commitmentTx: data.batchFinalization.commitmentTx,
                connectorsIndex: this.toConnectorsIndex(
                    data.batchFinalization.connectorsIndex
                ),
            };
        }

        // Check for BatchFinalized event
        if (data.batchFinalized) {
            return {
                type: SettlementEventType.BatchFinalized,
                id: data.batchFinalized.id,
                commitmentTxid: data.batchFinalized.commitmentTxid,
            };
        }

        // Check for BatchFailed event
        if (data.batchFailed) {
            return {
                type: SettlementEventType.BatchFailed,
                id: data.batchFailed.id,
                reason: data.batchFailed.reason,
            };
        }

        // Check for TreeSigningStarted event
        if (data.treeSigningStarted) {
            return {
                type: SettlementEventType.TreeSigningStarted,
                id: data.treeSigningStarted.id,
                cosignersPublicKeys: data.treeSigningStarted.cosignersPubkeys,
                unsignedCommitmentTx:
                    data.treeSigningStarted.unsignedCommitmentTx,
            };
        }

        // Check for TreeNoncesAggregated event
        if (data.treeNoncesAggregated) {
            return {
                type: SettlementEventType.TreeNoncesAggregated,
                id: data.treeNoncesAggregated.id,
                treeNonces: decodeNoncesMatrix(
                    hex.decode(data.treeNoncesAggregated.treeNonces)
                ),
            };
        }

        // Check for TreeTx event
        if (data.treeTx) {
            return {
                type: SettlementEventType.TreeTx,
                id: data.treeTx.id,
                topic: data.treeTx.topic,
                batchIndex: data.treeTx.batchIndex,
                treeTx: data.treeTx.treeTx,
            };
        }

        if (data.treeSignature) {
            return {
                type: SettlementEventType.TreeSignature,
                id: data.treeSignature.id,
                topic: data.treeSignature.topic,
                batchIndex: data.treeSignature.batchIndex,
                level: data.treeSignature.level,
                levelIndex: data.treeSignature.levelIndex,
                signature: data.treeSignature.signature,
            };
        }

        console.warn("Unknown event type:", data);
        return null;
    }

    private parseTransactionNotification(
        data: ProtoTypes.TransactionData
    ): { commitmentTx?: TxNotification; arkTx?: TxNotification } | null {
        if (data.commitmentTx) {
            return {
                commitmentTx: {
                    txid: data.commitmentTx.txid,
                    spentVtxos: data.commitmentTx.spentVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    spendableVtxos: data.commitmentTx.spendableVtxos.map(
                        (vtxo) => ({
                            outpoint: {
                                txid: vtxo.outpoint.txid,
                                vout: vtxo.outpoint.vout,
                            },
                            amount: BigInt(vtxo.amount),
                            script: vtxo.script,
                            createdAt: BigInt(vtxo.createdAt),
                            expiresAt: BigInt(vtxo.expiresAt),
                            commitmentTxid: vtxo.commitmentTxid,
                            preconfirmed: vtxo.preconfirmed,
                            swept: vtxo.swept,
                            redeemed: vtxo.redeemed,
                            spent: vtxo.spent,
                            spentBy: vtxo.spentBy,
                        })
                    ),
                    hex: data.commitmentTx.hex,
                },
            };
        }

        if (data.arkTx) {
            return {
                arkTx: {
                    txid: data.arkTx.txid,
                    spentVtxos: data.arkTx.spentVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    spendableVtxos: data.arkTx.spendableVtxos.map((vtxo) => ({
                        outpoint: {
                            txid: vtxo.outpoint.txid,
                            vout: vtxo.outpoint.vout,
                        },
                        amount: BigInt(vtxo.amount),
                        script: vtxo.script,
                        createdAt: BigInt(vtxo.createdAt),
                        expiresAt: BigInt(vtxo.expiresAt),
                        commitmentTxid: vtxo.commitmentTxid,
                        preconfirmed: vtxo.preconfirmed,
                        swept: vtxo.swept,
                        redeemed: vtxo.redeemed,
                        spent: vtxo.spent,
                        spentBy: vtxo.spentBy,
                    })),
                    hex: data.arkTx.hex,
                },
            };
        }

        console.warn("Unknown transaction notification type:", data);
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
        level: number;
        levelIndex: number;
        leaf: boolean;
    }

    interface BatchStartedEvent {
        id: string;
        intentIdHashes: string[];
        batchExpiry: string;
        forfeitAddress: string;
    }

    interface BatchFailed {
        id: string;
        reason: string;
    }

    export interface BatchFinalizationEvent {
        id: string;
        commitmentTx: string;
        connectorsIndex: {
            [key: string]: {
                txid: string;
                vout: number;
            };
        };
    }

    interface BatchFinalizedEvent {
        id: string;
        commitmentTxid: string;
    }

    interface TreeSigningStartedEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedCommitmentTx: string;
    }

    interface TreeNoncesAggregatedEvent {
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

    interface VtxoData {
        outpoint: {
            txid: string;
            vout: number;
        };
        amount: string;
        script: string;
        createdAt: string;
        expiresAt: string;
        commitmentTxid: string;
        preconfirmed: boolean;
        swept: boolean;
        redeemed: boolean;
        spent: boolean;
        spentBy: string;
    }

    export interface EventData {
        batchStarted?: BatchStartedEvent;
        batchFailed?: BatchFailed;
        batchFinalization?: BatchFinalizationEvent;
        batchFinalized?: BatchFinalizedEvent;
        treeSigningStarted?: TreeSigningStartedEvent;
        treeNoncesAggregated?: TreeNoncesAggregatedEvent;
        treeTx?: BatchTreeEvent;
        treeSignature?: BatchTreeSignatureEvent;
    }

    export interface TransactionData {
        commitmentTx?: {
            txid: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            hex: string;
        };
        arkTx?: {
            txid: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            hex: string;
        };
    }
}
