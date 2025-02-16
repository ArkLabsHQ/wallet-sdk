import type { Coin, Outpoint, VirtualCoin } from "../types/wallet";
import type { UTXO, VTXO } from "../types/internal";
import type { ArkEvent } from "./ark";
import { VtxoTree } from "../core/tree/vtxoTree";
import { TreeNonces, TreePartialSigs } from "../core/signingSession";

export interface OnchainProvider {
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
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
    vtxoTree: VtxoTree;
    connectors: string[];
    minRelayFeeRate: bigint; // Using bigint for int64
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
    unsignedVtxoTree: VtxoTree;
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
    vtxoTreeExpiry: bigint;
    // roundLifetime is the same as vtxoTreeExpiry, only kept for backwards compatibility
    roundLifetime: bigint;
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
    getVirtualCoins(address: string): Promise<VirtualCoin[]>;
    submitVirtualTx(psbtBase64: string): Promise<string>;
    subscribeToEvents(callback: (event: ArkEvent) => void): Promise<() => void>;
    registerInputsForNextRound(inputs: Input[]): Promise<{ requestId: string }>;
    registerOutputsForNextRound(
        requestId: string,
        outputs: Output[],
        vtxoTreeSigningPublicKeys: string[],
        signAll: boolean
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

export abstract class BaseOnchainProvider implements OnchainProvider {
    constructor(protected baseUrl: string) {}

    abstract getCoins(address: string): Promise<Coin[]>;
    abstract getFeeRate(): Promise<number>;
    abstract broadcastTransaction(txHex: string): Promise<string>;

    protected convertUTXOsToCoin(utxos: UTXO[]): Coin[] {
        return utxos.map((utxo) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            status: utxo.status,
        }));
    }
}

export abstract class BaseArkProvider implements ArkProvider {
    constructor(
        protected serverUrl: string,
        protected serverPublicKey: string
    ) {}

    abstract getInfo(): Promise<ArkInfo>;

    abstract getVirtualCoins(address: string): Promise<VirtualCoin[]>;
    abstract submitVirtualTx(psbtBase64: string): Promise<string>;
    abstract subscribeToEvents(
        callback: (event: ArkEvent) => void
    ): Promise<() => void>;

    abstract registerInputsForNextRound(
        inputs: Input[]
    ): Promise<{ requestId: string }>;

    abstract registerOutputsForNextRound(
        requestId: string,
        outputs: Output[],
        vtxoTreeSigningPublicKeys: string[],
        signAll: boolean
    ): Promise<void>;

    abstract submitTreeNonces(
        settlementID: string,
        pubkey: string,
        treeNonces: TreeNonces
    ): Promise<void>;

    abstract submitTreeSignatures(
        settlementID: string,
        pubkey: string,
        treeSignatures: TreePartialSigs
    ): Promise<void>;

    abstract submitSignedForfeitTxs(
        signedForfeitTxs: string[],
        signedRoundTx?: string
    ): Promise<void>;

    abstract ping(requestId: string): Promise<void>;

    abstract getEventStream(): AsyncIterableIterator<SettlementEvent>;

    protected convertVTXOsToVirtualCoin(vtxos: VTXO[]): VirtualCoin[] {
        return vtxos.map((vtxo) => ({
            txid: vtxo.txid,
            vout: vtxo.vout,
            value: vtxo.value,
            status: {
                confirmed:
                    vtxo.status.state === "settled" &&
                    !!vtxo.status.batchOutpoint,
                block_height: undefined,
                block_hash: undefined,
                block_time: undefined,
            },
            virtualStatus: {
                state: vtxo.status.state,
                batchTxID: vtxo.status.batchOutpoint?.txid,
                batchExpiry: vtxo.status.batchExpiry,
            },
        }));
    }

    get url(): string {
        return this.serverUrl;
    }

    get pubkey(): string {
        return this.serverPublicKey;
    }
}
