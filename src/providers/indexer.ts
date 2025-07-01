import { ArkTransaction, TxType, Outpoint, VirtualCoin } from "../wallet";

type PaginationOptions = {
    pageIndex?: number;
    pageSize?: number;
};

export enum IndexerTxType {
    INDEXER_TX_TYPE_UNSPECIFIED = 0,
    INDEXER_TX_TYPE_RECEIVED = 1,
    INDEXER_TX_TYPE_SENT = 2,
}

export enum ChainedTxType {
    INDEXER_CHAINED_TX_TYPE_UNSPECIFIED = 0,
    INDEXER_CHAINED_TX_TYPE_VIRTUAL = 1,
    INDEXER_CHAINED_TX_TYPE_COMMITMENT = 2,
}

export interface PageResponse {
    current: number;
    next: number;
    total: number;
}

export interface Batch {
    totalOutputAmount: string;
    totalOutputVtxos: number;
    expiresAt: string;
    swept: boolean;
}

export interface Chain {
    txid: string;
    spends: ChainedTx[];
    expiresAt: string;
}

export interface ChainedTx {
    txid: string;
    type: ChainedTxType;
}

export interface CommitmentTx {
    startedAt: string;
    endedAt: string;
    batches: { [key: string]: Batch };
    totalInputAmount: string;
    totalInputVtxos: number;
    totalOutputAmount: string;
    totalOutputVtxos: number;
}

export interface Node {
    txid: string;
    parentTxid: string;
    level: number;
    levelIndex: number;
}

export interface TxHistoryRecord {
    commitmentTxid?: string;
    virtualTxid?: string;

    type: IndexerTxType;
    amount: string;
    createdAt: string;
    isSettled: boolean;
    settledBy: string;
}

export interface Vtxo {
    outpoint: Outpoint;
    createdAt: string;
    expiresAt: string | null;
    amount: string;
    script: string;
    isPreconfirmed: boolean;
    isSwept: boolean;
    isRedeemed: boolean;
    isSpent: boolean;
    spentBy: string | null;
    commitmentTxid: string;
}

export interface VtxoChain {
    chain: Chain[];
    depth: number;
    rootCommitmentTxid: string;
}

export interface IndexerProvider {
    getVtxoTree(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<Node[]>;
    getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<Outpoint[]>;
    getCommitmentTx(txid: string): Promise<CommitmentTx>;
    getCommitmentTxConnectors(
        txid: string,
        opts?: PaginationOptions
    ): Promise<Node[]>;
    getCommitmentTxForfeitTxs(
        txid: string,
        opts?: PaginationOptions
    ): Promise<string[]>;
    getCommitmentTxLeaves(
        txid: string,
        opts?: PaginationOptions
    ): Promise<Outpoint[]>;
    getCommitmentTxSwept(txid: string): Promise<string[]>;
    getTransactionHistory(
        address: string,
        opts?: PaginationOptions & {
            startTime?: number;
            endTime?: number;
        }
    ): Promise<ArkTransaction[]>;
    getSubscription(
        subscriptionId: string,
        abortSignal: AbortSignal
    ): AsyncIterableIterator<{
        scripts: string[];
        newVtxos: VirtualCoin[];
        spentVtxos: VirtualCoin[];
    }>;
    getVirtualTxs(txids: string[], opts?: PaginationOptions): Promise<string[]>;
    getVtxoChain(
        vtxoOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<VtxoChain>;
    getVtxos(
        opts?: PaginationOptions & {
            addresses?: string[];
            outpoints?: Outpoint[];
            spendableOnly?: boolean;
            spentOnly?: boolean;
        }
    ): Promise<VirtualCoin[]>;
    subscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string>;
    unsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void>;
}

export class RestIndexerProvider implements IndexerProvider {
    constructor(public serverUrl: string) {}

    async getVtxoTree(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<Node[]> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo tree: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isNodeArray(data.vtxoTree)) {
            throw new Error("Invalid vtxo tree data received");
        }
        return data.vtxoTree;
    }

    async getVtxoTreeLeaves(
        batchOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<Outpoint[]> {
        let url = `${this.serverUrl}/v1/batch/${batchOutpoint.txid}/${batchOutpoint.vout}/tree/leaves`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch vtxo tree leaves: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isOutpointArray(data.leaves)) {
            throw new Error("Invalid vtxos tree leaves data received");
        }
        return data.leaves;
    }

    async getCommitmentTx(txid: string): Promise<CommitmentTx> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch commitment tx: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isCommitmentTx(data)) {
            throw new Error("Invalid commitment tx data received");
        }
        return data;
    }

    async getCommitmentTxConnectors(
        txid: string,
        opts?: PaginationOptions
    ): Promise<Node[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/connectors`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx connectors: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isNodeArray(data.connectors)) {
            throw new Error("Invalid commitment tx connectors data received");
        }
        return data.connectors;
    }

    async getCommitmentTxForfeitTxs(
        txid: string,
        opts?: PaginationOptions
    ): Promise<string[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/forfeitTxs`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx forfeitTxs: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isTxidArray(data.txids)) {
            throw new Error("Invalid commitment tx forfeitTxs data received");
        }
        return data.txids;
    }

    async getCommitmentTxLeaves(
        txid: string,
        opts?: PaginationOptions
    ): Promise<Outpoint[]> {
        let url = `${this.serverUrl}/v1/commitmentTx/${txid}/leaves`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx leaves: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isOutpointArray(data.leaves)) {
            throw new Error("Invalid commitment tx leaves data received");
        }
        return data.leaves;
    }

    async getCommitmentTxSwept(txid: string): Promise<string[]> {
        const url = `${this.serverUrl}/v1/commitmentTx/${txid}/swept`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `Failed to fetch commitment tx swept: ${res.statusText}`
            );
        }
        const data = await res.json();
        if (!Response.isTxidArray(data.sweptBy)) {
            throw new Error("Invalid commitment tx swept data received");
        }
        return data.sweptBy;
    }

    async *getSubscription(subscriptionId: string, abortSignal: AbortSignal) {
        const url = `${this.serverUrl}/v1/script/subscription/${subscriptionId}`;

        while (!abortSignal.aborted) {
            try {
                const res = await fetch(url, {
                    headers: {
                        Accept: "application/json",
                    },
                });

                if (!res.ok) {
                    throw new Error(
                        `Unexpected status ${res.status} when subscribing to address updates`
                    );
                }

                if (!res.body) {
                    throw new Error("Response body is null");
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (!abortSignal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");

                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;

                        try {
                            const data = JSON.parse(line);
                            if ("result" in data) {
                                yield {
                                    scripts: data.result.scripts || [],
                                    newVtxos: (data.result.newVtxos || []).map(
                                        convertVtxo
                                    ),
                                    spentVtxos: (
                                        data.result.spentVtxos || []
                                    ).map(convertVtxo),
                                };
                            }
                        } catch (err) {
                            console.error(
                                "Failed to parse address update:",
                                err
                            );
                            throw err;
                        }
                    }

                    buffer = lines[lines.length - 1];
                }
            } catch (error) {
                console.error("Address subscription error:", error);
                throw error;
            }
        }
    }

    async getTransactionHistory(
        address: string,
        opts?: PaginationOptions & {
            startTime?: number;
            endTime?: number;
        }
    ): Promise<ArkTransaction[]> {
        let url = `${this.serverUrl}/v1/history/${address}`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.startTime !== undefined)
                params.append("startTime", opts.startTime.toString());
            if (opts.endTime !== undefined)
                params.append("endTime", opts.endTime.toString());
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch tx history: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isTxHistoryRecordArray(data.history)) {
            throw new Error("Invalid transaction history data received");
        }
        return data.history.map(convertTransaction);
    }

    async getVirtualTxs(
        txids: string[],
        opts?: PaginationOptions
    ): Promise<string[]> {
        let url = `${this.serverUrl}/v1/virtualTx/${txids.join(",")}`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch virtual txs: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isTxidArray(data.txs)) {
            throw new Error("Invalid virtual txs data received");
        }
        return data.txs;
    }

    async getVtxoChain(
        vtxoOutpoint: Outpoint,
        opts?: PaginationOptions
    ): Promise<VtxoChain> {
        let url = `${this.serverUrl}/v1/vtxo/${vtxoOutpoint.txid}/${vtxoOutpoint.vout}/chain`;
        const params = new URLSearchParams();
        if (opts) {
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxo chain: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxoChain(data)) {
            throw new Error("Invalid vtxo chain data received");
        }
        return data;
    }

    async getVtxos(
        opts?: PaginationOptions & {
            addresses?: string[];
            outpoints?: Outpoint[];
            spendableOnly?: boolean;
            spentOnly?: boolean;
        }
    ): Promise<VirtualCoin[]> {
        let url = `${this.serverUrl}/v1/vtxos`;
        const params = new URLSearchParams();
        if (opts?.addresses && opts.addresses.length > 0) {
            params.append("addresses", opts.addresses.join(","));
        }
        if (opts?.outpoints && opts.outpoints.length > 0) {
            const outpointStrings = opts.outpoints.map(
                (op) => `${op.txid}:${op.vout}`
            );
            params.append("outpoints", outpointStrings.join(","));
        }
        if (opts) {
            if (opts.spendableOnly !== undefined)
                params.append("spendableOnly", opts.spendableOnly.toString());
            if (opts.spentOnly !== undefined)
                params.append("spentOnly", opts.spentOnly.toString());
            if (opts.pageIndex !== undefined)
                params.append("page.index", opts.pageIndex.toString());
            if (opts.pageSize !== undefined)
                params.append("page.size", opts.pageSize.toString());
        }
        if (params.toString()) {
            url += "?" + params.toString();
        }
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch vtxos: ${res.statusText}`);
        }
        const data = await res.json();
        if (!Response.isVtxoArray(data.vtxos)) {
            console.error("Invalid vtxos data received:", data);
            throw new Error("Invalid vtxos data received");
        }
        return data.vtxos.map(convertVtxo);
    }

    async subscribeForScripts(
        scripts: string[],
        subscriptionId?: string
    ): Promise<string> {
        const url = `${this.serverUrl}/v1/script/subscribe`;
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
            },
            method: "POST",
            body: JSON.stringify({ scripts, subscriptionId }),
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to subscribe to scripts: ${errorText}`);
        }
        const data = await res.json();
        if (!data.subscriptionId) throw new Error(`Subscription ID not found`);
        return data.subscriptionId;
    }

    async unsubscribeForScripts(
        subscriptionId: string,
        scripts?: string[]
    ): Promise<void> {
        const url = `${this.serverUrl}/v1/script/unsubscribe`;
        const res = await fetch(url, {
            headers: {
                "Content-Type": "application/json",
            },
            method: "POST",
            body: JSON.stringify({ subscriptionId, scripts }),
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to unsubscribe to scripts: ${errorText}`);
        }
    }
}

function convertVtxo(vtxo: Vtxo): VirtualCoin {
    return {
        txid: vtxo.outpoint.txid,
        vout: vtxo.outpoint.vout,
        value: Number(vtxo.amount),
        status: {
            confirmed: !!vtxo.commitmentTxid,
        },
        virtualStatus: {
            state: vtxo.isSwept
                ? "swept"
                : vtxo.isPreconfirmed
                  ? "preconfirmed"
                  : "settled",
            batchTxID: vtxo.commitmentTxid,
            batchExpiry: vtxo.expiresAt
                ? Number(vtxo.expiresAt) * 1000
                : undefined,
        },
        spentBy: vtxo.spentBy ?? "",
        createdAt: new Date(Number(vtxo.createdAt) * 1000),
    };
}

function convertType(type: IndexerTxType): TxType {
    switch (type) {
        case IndexerTxType.INDEXER_TX_TYPE_RECEIVED:
            return TxType.TxReceived;
        case IndexerTxType.INDEXER_TX_TYPE_SENT:
            return TxType.TxSent;
        default:
            throw new Error(`Unknown transaction type: ${type}`);
    }
}

function convertTransaction(tx: TxHistoryRecord): ArkTransaction {
    return {
        key: {
            boardingTxid: "",
            commitmentTxid: tx.commitmentTxid ?? "",
            arkTxid: tx.virtualTxid ?? "",
        },
        amount: Number(tx.amount),
        type: convertType(tx.type),
        settled: tx.isSettled,
        createdAt: Number(tx.createdAt) * 1000,
    };
}

// Unexported namespace for type guards only
namespace Response {
    function isBatch(data: any): data is Batch {
        return (
            typeof data === "object" &&
            typeof data.totalOutputAmount === "string" &&
            typeof data.totalOutputVtxos === "number" &&
            typeof data.expiresAt === "string" &&
            typeof data.swept === "boolean"
        );
    }

    function isChain(data: any): data is Chain {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            Array.isArray(data.spends) &&
            data.spends.every(isChainedTx) &&
            typeof data.expiresAt === "string"
        );
    }

    function isChainedTx(data: any): data is ChainedTx {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            Object.values(ChainedTxType).includes(data.type)
        );
    }

    export function isCommitmentTx(data: any): data is CommitmentTx {
        return (
            typeof data === "object" &&
            typeof data.startedAt === "string" &&
            typeof data.endedAt === "string" &&
            typeof data.totalInputAmount === "string" &&
            typeof data.totalInputVtxos === "number" &&
            typeof data.totalOutputAmount === "string" &&
            typeof data.totalOutputVtxos === "number" &&
            typeof data.batches === "object" &&
            Object.values(data.batches).every(isBatch)
        );
    }

    export function isOutpoint(data: any): data is Outpoint {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.vout === "number"
        );
    }

    export function isOutpointArray(data: any): data is Outpoint[] {
        return Array.isArray(data) && data.every(isOutpoint);
    }

    function isNode(data: any): data is Node {
        return (
            typeof data === "object" &&
            typeof data.txid === "string" &&
            typeof data.parentTxid === "string" &&
            typeof data.level === "number" &&
            typeof data.levelIndex === "number"
        );
    }

    export function isNodeArray(data: any): data is Node[] {
        return Array.isArray(data) && data.every(isNode);
    }

    function isTxHistoryRecord(data: any): data is TxHistoryRecord {
        return (
            typeof data === "object" &&
            typeof data.amount === "string" &&
            typeof data.createdAt === "string" &&
            typeof data.isSettled === "boolean" &&
            typeof data.settledBy === "string" &&
            Object.values(IndexerTxType).includes(data.type) &&
            ((!data.commitmentTxid && typeof data.virtualTxid === "string") ||
                (typeof data.commitmentTxid === "string" && !data.virtualTxid))
        );
    }

    export function isTxHistoryRecordArray(
        data: any
    ): data is TxHistoryRecord[] {
        return Array.isArray(data) && data.every(isTxHistoryRecord);
    }

    function isTxid(data: any): data is string {
        return typeof data === "string";
    }

    export function isTxidArray(data: any): data is string[] {
        return Array.isArray(data) && data.every(isTxid);
    }

    function isVtxo(data: any): data is Vtxo {
        return (
            typeof data === "object" &&
            isOutpoint(data.outpoint) &&
            typeof data.createdAt === "string" &&
            (typeof data.expiresAt === "string" ||
                typeof data.expiresAt === "object") &&
            typeof data.amount === "string" &&
            typeof data.script === "string" &&
            typeof data.isPreconfirmed === "boolean" &&
            typeof data.isSwept === "boolean" &&
            typeof data.isRedeemed === "boolean" &&
            typeof data.isSpent === "boolean" &&
            (typeof data.spentBy === "string" ||
                typeof data.spentBy === "object") &&
            typeof data.commitmentTxid === "string"
        );
    }

    export function isVtxoArray(data: any): data is Vtxo[] {
        return Array.isArray(data) && data.every(isVtxo);
    }

    export function isVtxoChain(data: any): data is VtxoChain {
        return (
            typeof data === "object" &&
            Array.isArray(data.chain) &&
            data.chain.every(isChain) &&
            typeof data.depth === "number" &&
            typeof data.rootCommitmentTxid === "string"
        );
    }
}
