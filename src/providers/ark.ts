import {
    BaseArkProvider,
    SettlementEventType,
    Input,
    Output,
    SettlementEvent,
    ArkInfo,
} from "./base";
import type { VirtualCoin } from "../types/wallet";
import { VtxoTree } from "../core/vtxoTree";

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

    interface RoundFinalizationEvent {
        id: string;
        roundTx: string;
        vtxoTree: Tree;
        connectors: string[];
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

export class ArkProvider extends BaseArkProvider {
    async getInfo(): Promise<ArkInfo> {
        const url = `${this.serverUrl}/v1/info`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `Failed to get server info: ${response.statusText}`
            );
        }
        return response.json();
    }

    async getVirtualCoins(address: string): Promise<VirtualCoin[]> {
        const url = `${this.serverUrl}/v1/vtxos/${address}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch VTXOs: ${response.statusText}`);
        }
        const data = await response.json();

        // Convert from server format to our internal VTXO format
        return [...(data.spendableVtxos || []), ...(data.spentVtxos || [])].map(
            (vtxo) => ({
                txid: vtxo.outpoint.txid,
                vout: vtxo.outpoint.vout,
                value: Number(vtxo.amount),
                status: {
                    confirmed: !!vtxo.roundTxid,
                },
                virtualStatus: {
                    state: vtxo.spent
                        ? "spent"
                        : vtxo.swept
                          ? "swept"
                          : vtxo.isPending
                            ? "pending"
                            : "settled",
                    batchTxID: vtxo.roundTxid,
                    batchExpiry: vtxo.expireAt
                        ? Number(vtxo.expireAt)
                        : undefined,
                },
            })
        );
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
        return data.txid;
    }

    async subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void> {
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
                        throw new Error(`Unexpected status ${response.status} when fetching event stream`);
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
        inputs: Input[],
        vtxoTreeSigningPublicKey: string
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
                ephemeralPubkey: vtxoTreeSigningPublicKey,
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
        outputs: Output[]
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
        nonces: string
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
                treeNonces: nonces,
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
        signatures: string
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
                treeSignatures: signatures,
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

    private toVtxoTree(t: ProtoTypes.Tree): VtxoTree {
        // collect the parent txids to determine later if a node is a leaf
        const parentTxids = new Set<string>();
        t.levels.forEach((level) =>
            level.nodes.forEach((node) => {
                if (node.parentTxid) {
                    parentTxids.add(node.parentTxid);
                }
            })
        );

        return new VtxoTree(
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
                vtxoTree: this.toVtxoTree(data.roundFinalization.vtxoTree),
                connectors: data.roundFinalization.connectors,
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
                unsignedVtxoTree: this.toVtxoTree(
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
                treeNonces: data.roundSigningNoncesGenerated.treeNonces,
            };
        }

        console.warn("Unknown event structure:", data);
        return null;
    }
}
