import { Output, SettlementEvent } from "../providers/ark";
import { Identity } from "../identity";
import { NetworkName } from "../networks";
import { RelativeTimelock } from "../script/tapscript";
import { TaprootLeaf } from "@scure/btc-signer/payment";
import { EncodedVtxoScript } from "../script/base";

export interface WalletConfig {
    network: NetworkName;
    identity: Identity;
    esploraUrl?: string;
    arkServerUrl?: string;
    arkServerPublicKey?: string;
    boardingTimelock?: RelativeTimelock;
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
    inputs: (string | (TaprootLeaf & Outpoint & EncodedVtxoScript))[];
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
    onchain: string;
    offchain?: VtxoTaprootAddress;
    boarding?: VtxoTaprootAddress;
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
    state: "pending" | "settled" | "swept" | "spent";
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
    roundTxid: string;
    redeemTxid: string;
}

export interface ArkTransaction {
    key: TxKey;
    type: TxType;
    amount: number;
    settled: boolean;
    createdAt: number;
}

// ExtendedCoin and ExtendedVirtualCoin contains the utxo/vtxo data along with the vtxo script locking it
export type ExtendedCoin = TaprootLeaf & EncodedVtxoScript & Coin;
export type ExtendedVirtualCoin = TaprootLeaf & EncodedVtxoScript & VirtualCoin;

export interface IWallet {
    // Address and balance management
    getAddress(): Promise<AddressInfo>;
    getBalance(): Promise<WalletBalance>;
    getCoins(): Promise<Coin[]>;
    getVtxos(): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;

    // Transaction operations
    sendBitcoin(params: SendBitcoinParams, zeroFee?: boolean): Promise<string>;
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;
}
