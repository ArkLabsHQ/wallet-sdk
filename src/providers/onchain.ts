import type { NetworkName } from "../networks";
import { Coin } from "../wallet";

export const ESPLORA_URL: Record<NetworkName, string> = {
    bitcoin: "https://mempool.space/api",
    testnet: "https://mempool.space/testnet/api",
    signet: "https://mempool.space/signet/api",
    mutinynet: "https://mutinynet.com/api",
    regtest: "http://localhost:3000",
};

export type ExplorerTransaction = {
    txid: string;
    vout: {
        scriptpubkey_address: string;
        value: string;
    }[];
    status: {
        confirmed: boolean;
        block_time: number;
    };
};

const isExplorerTransaction = (tx: any): tx is ExplorerTransaction => {
    return (
        typeof tx.txid === "string" &&
        Array.isArray(tx.vout) &&
        tx.vout.every(
            (vout: any) =>
                typeof vout.scriptpubkey_address === "string" &&
                typeof vout.value === "string"
        ) &&
        typeof tx.status === "object" &&
        typeof tx.status.confirmed === "boolean" &&
        typeof tx.status.block_time === "number"
    );
};

export interface SubscribeMessage {
    "track-addresses": string[];
}

export interface WebSocketMessage {
    "multi-address-transactions"?: Record<
        string,
        {
            mempool: ExplorerTransaction[];
            confirmed: ExplorerTransaction[];
            removed: ExplorerTransaction[];
        }
    >;
}

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
    getTxOutspends(txid: string): Promise<{ spent: boolean; txid: string }[]>;
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    getTxStatus(txid: string): Promise<{
        confirmed: boolean;
        blockTime?: number;
        blockHeight?: number;
    }>;
    watchAddresses(
        addresses: string[],
        eventCallback: (
            txs: ExplorerTransaction[],
            stopFunc: () => void
        ) => void
    ): Promise<WebSocket>;
}

export class EsploraProvider implements OnchainProvider {
    constructor(private baseUrl: string) {}

    async getCoins(address: string): Promise<Coin[]> {
        const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);
        if (!response.ok) {
            throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
        }
        return response.json();
    }

    async getFeeRate(): Promise<number> {
        const response = await fetch(`${this.baseUrl}/v1/fees/recommended`);
        if (!response.ok) {
            throw new Error(`Failed to fetch fee rate: ${response.statusText}`);
        }
        const fees = await response.json();
        return fees.halfHourFee; // Return the "medium" priority fee rate
    }

    async broadcastTransaction(txHex: string): Promise<string> {
        const response = await fetch(`${this.baseUrl}/tx`, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
            },
            body: txHex,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to broadcast transaction: ${error}`);
        }

        return response.text(); // Returns the txid
    }

    async getTxOutspends(
        txid: string
    ): Promise<{ spent: boolean; txid: string }[]> {
        const response = await fetch(`${this.baseUrl}/tx/${txid}/outspends`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transaction outspends: ${error}`);
        }

        return response.json();
    }

    async getTransactions(address: string): Promise<ExplorerTransaction[]> {
        const response = await fetch(`${this.baseUrl}/address/${address}/txs`);
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to get transactions: ${error}`);
        }

        return response.json();
    }

    async getTxStatus(txid: string): Promise<{
        confirmed: boolean;
        blockTime?: number;
        blockHeight?: number;
    }> {
        const response = await fetch(`${this.baseUrl}/tx/${txid}/status`);
        if (!response.ok) {
            throw new Error(
                `Failed to get transaction status: ${response.statusText}`
            );
        }

        const data = await response.json();
        return {
            confirmed: data.confirmed,
            blockTime: data.block_time,
            blockHeight: data.block_height,
        };
    }

    async watchAddresses(
        addresses: string[],
        callback: (txs: ExplorerTransaction[], stopFunc: () => void) => void
    ): Promise<WebSocket> {
        // returns WebSocket instance for testing
        const wsUrl =
            this.baseUrl.replace(/^http(s)?:\/\//, "ws$1://") + "/v1/ws";
        const ws = new WebSocket(wsUrl);

        ws.addEventListener("open", () => {
            // subscribe to address updates
            const subscribeMsg: SubscribeMessage = {
                "track-addresses": addresses,
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.addEventListener("message", (event: MessageEvent) => {
            try {
                const newTxs: ExplorerTransaction[] = [];
                const message: WebSocketMessage = JSON.parse(
                    event.data.toString()
                );
                if (!message["multi-address-transactions"]) return;
                const aux = message["multi-address-transactions"];

                for (const address in aux) {
                    for (const type of [
                        "mempool",
                        "confirmed",
                        "removed",
                    ] as const) {
                        if (!aux[address][type]) continue;
                        newTxs.push(
                            ...aux[address][type].filter(isExplorerTransaction)
                        );
                    }
                }
                // callback with new transactions
                if (newTxs.length > 0) callback(newTxs, ws.close.bind(ws));
            } catch (error) {
                console.error("Failed to process WebSocket message:", error);
            }
        });

        ws.addEventListener("error", async () => {
            // websocket is not reliable, so we will fallback to polling
            const pollingInterval = 5_000; // 5 seconds

            const getAllTxs = () => {
                return Promise.all(
                    addresses.map((address) => this.getTransactions(address))
                ).then((txArrays) => txArrays.flat());
            };

            // initial fetch to get existing transactions
            const initialTxs = await getAllTxs();

            // we use block_time in key to also notify when a transaction is confirmed
            const txKey = (tx: ExplorerTransaction) =>
                `${tx.txid}_${tx.status.block_time}`;

            // polling for new transactions
            const intervalId = setInterval(async () => {
                try {
                    // get current transactions
                    // we will compare with initialTxs to find new ones
                    const currentTxs = await getAllTxs();

                    // if current transactions differ from initial, we have new transactions
                    if (
                        JSON.stringify(currentTxs) !==
                        JSON.stringify(initialTxs)
                    ) {
                        // create a set of existing transactions to avoid duplicates
                        const existingTxs = new Set(initialTxs.map(txKey));

                        // filter out transactions that are already in initialTxs
                        const newTxs = currentTxs.filter(
                            (tx) => !existingTxs.has(txKey(tx))
                        );

                        if (newTxs.length > 0) {
                            initialTxs.push(...newTxs);
                            const stopFunc = () => clearInterval(intervalId);
                            callback(newTxs, stopFunc);
                        }
                    }
                } catch (error) {
                    console.error("Error in polling mechanism:", error);
                }
            }, pollingInterval);
        });

        return ws;
    }
}
