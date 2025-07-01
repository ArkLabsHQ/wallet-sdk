import { Output, SettlementEvent } from "../providers/ark";
import { Identity } from "../identity";
import { NetworkName } from "../networks";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { Bytes } from "@scure/btc-signer/utils";

export interface WalletConfig {
    network: NetworkName;
    identity: Identity;
    esploraUrl?: string;
    arkServerUrl?: string;
    arkServerPublicKey?: string;
    boardingTimelock?: RelativeTimelock;
    exitTimelock?: RelativeTimelock;
}

export interface WalletBalance {
    onchain: {
        confirmed: number;
        unconfirmed: number;
        total: number;
    };
    offchain: {
        swept: number;
        settled: number;
        pending: number;
        total: number;
    };
    total: number;
}

export interface SendBitcoinParams {
    address: string;
    amount: number;
    feeRate?: number;
    memo?: string;
}

export interface Recipient {
    address: string;
    amount: number;
}

export interface SettleParams {
    inputs: ExtendedCoin[];
    outputs: Output[];
}

// VtxoTaprootAddress embed the tapscripts composing the address
// it admits the internal key is the unspendable x-only public key
export interface VtxoTaprootAddress {
    address: string;
    scripts: {
        exit: string[];
        forfeit: string[];
    };
}

export interface AddressInfo {
    offchain: VtxoTaprootAddress;
    boarding: VtxoTaprootAddress;
}

export interface Addresses {
    onchain: string;
    offchain?: string;
    boarding?: string;
    bip21: string;
}

export interface TapscriptInfo {
    offchain?: string[];
    boarding?: string[];
}

export interface Status {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
}

export interface VirtualStatus {
    state: "preconfirmed" | "settled" | "swept" | "spent";
    batchTxID?: string;
    batchExpiry?: number;
}

export interface Outpoint {
    txid: string;
    vout: number;
}

export interface Coin extends Outpoint {
    value: number;
    status: Status;
}

export interface VirtualCoin extends Coin {
    virtualStatus: VirtualStatus;
    spentBy?: string;
    createdAt: Date;
}

export enum TxType {
    TxSent = "SENT",
    TxReceived = "RECEIVED",
}

export interface TxKey {
    boardingTxid: string;
    commitmentTxid: string;
    arkTxid: string;
}

export interface ArkTransaction {
    key: TxKey;
    type: TxType;
    amount: number;
    settled: boolean;
    createdAt: number;
}

// ExtendedCoin and ExtendedVirtualCoin contains the utxo/vtxo data along with the vtxo script locking it
type tapLeaves = {
    forfeitTapLeafScript: TapLeafScript;
    intentTapLeafScript: TapLeafScript;
};

export type ExtendedCoin = tapLeaves &
    EncodedVtxoScript &
    Coin & { extraWitness?: Bytes[] };
export type ExtendedVirtualCoin = tapLeaves &
    EncodedVtxoScript &
    VirtualCoin & { extraWitness?: Bytes[] };

export function isSpendable(vtxo: VirtualCoin): boolean {
    return vtxo.spentBy === undefined || vtxo.spentBy === "";
}

export function isRecoverable(vtxo: VirtualCoin): boolean {
    return vtxo.virtualStatus.state === "swept" && isSpendable(vtxo);
}

export function isSubdust(vtxo: VirtualCoin, dust: bigint): boolean {
    return vtxo.value < dust;
}

export type GetVtxosFilter = {
    withSpendableInSettlement?: boolean; // include the swept but unspent
};

export interface IWallet {
    // Address and balance management
    getAddress(): Promise<Addresses>;
    getAddressInfo(): Promise<AddressInfo>;
    getBalance(): Promise<WalletBalance>;
    getCoins(): Promise<Coin[]>;
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;

    // Transaction operations
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;
    exit(outpoints?: Outpoint[]): Promise<void>;
}
