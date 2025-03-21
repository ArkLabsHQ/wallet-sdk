import { TaprootLeaf } from "@scure/btc-signer/payment";
import {
    WalletBalance,
    Coin,
    VirtualCoin,
    ArkTransaction,
    AddressInfo,
} from "..";
import { SettlementEvent } from "../../providers/ark";
import { EncodedVtxoScript } from "../../script/base";

export namespace Response {
    export type Type =
        | "WALLET_INITIALIZED"
        | "SETTLE_EVENT"
        | "SETTLE_SUCCESS"
        | "ADDRESS"
        | "BALANCE"
        | "COINS"
        | "VTXOS"
        | "VIRTUAL_COINS"
        | "BOARDING_UTXOS"
        | "SEND_BITCOIN_SUCCESS"
        | "TRANSACTION_HISTORY"
        | "WALLET_STATUS"
        | "ERROR";

    export interface Base {
        type: Type;
        success: boolean;
    }

    export const walletInitialized: Base = {
        type: "WALLET_INITIALIZED",
        success: true,
    };

    export interface Error extends Base {
        type: "ERROR";
        success: false;
        message: string;
    }

    export function error(message: string): Error {
        return {
            type: "ERROR",
            success: false,
            message,
        };
    }

    export interface SettleEvent extends Base {
        type: "SETTLE_EVENT";
        success: true;
        event: SettlementEvent;
    }

    export function settleEvent(event: SettlementEvent): SettleEvent {
        return {
            type: "SETTLE_EVENT",
            success: true,
            event,
        };
    }

    export interface SettleSuccess extends Base {
        type: "SETTLE_SUCCESS";
        success: true;
        txid: string;
    }

    export function settleSuccess(txid: string): SettleSuccess {
        return {
            type: "SETTLE_SUCCESS",
            success: true,
            txid,
        };
    }

    export function isSettleSuccess(response: Base): response is SettleSuccess {
        return response.type === "SETTLE_SUCCESS" && response.success;
    }

    export interface Address extends Base {
        type: "ADDRESS";
        success: true;
        address: AddressInfo;
    }

    export function isAddress(response: Base): response is Address {
        return response.type === "ADDRESS" && response.success === true;
    }

    export function address(address: AddressInfo): Address {
        return {
            type: "ADDRESS",
            success: true,
            address,
        };
    }

    export interface Balance extends Base {
        type: "BALANCE";
        success: true;
        balance: WalletBalance;
    }

    export function isBalance(response: Base): response is Balance {
        return response.type === "BALANCE" && response.success === true;
    }

    export function balance(balance: WalletBalance): Balance {
        return {
            type: "BALANCE",
            success: true,
            balance,
        };
    }

    export interface Coins extends Base {
        type: "COINS";
        success: true;
        coins: Coin[];
    }

    export function isCoins(response: Base): response is Coins {
        return response.type === "COINS" && response.success === true;
    }

    export function coins(coins: Coin[]): Coins {
        return {
            type: "COINS",
            success: true,
            coins,
        };
    }

    export interface Vtxos extends Base {
        type: "VTXOS";
        success: true;
        vtxos: (TaprootLeaf & EncodedVtxoScript & VirtualCoin)[];
    }

    export function isVtxos(response: Base): response is Vtxos {
        return response.type === "VTXOS" && response.success === true;
    }

    export function vtxos(
        vtxos: (TaprootLeaf & EncodedVtxoScript & VirtualCoin)[]
    ): Vtxos {
        return {
            type: "VTXOS",
            success: true,
            vtxos,
        };
    }

    export interface VirtualCoins extends Base {
        type: "VIRTUAL_COINS";
        success: true;
        virtualCoins: VirtualCoin[];
    }

    export function isVirtualCoins(response: Base): response is VirtualCoins {
        return response.type === "VIRTUAL_COINS" && response.success === true;
    }

    export function virtualCoins(virtualCoins: VirtualCoin[]): VirtualCoins {
        return {
            type: "VIRTUAL_COINS",
            success: true,
            virtualCoins,
        };
    }

    export interface BoardingUtxos extends Base {
        type: "BOARDING_UTXOS";
        success: true;
        boardingUtxos: (TaprootLeaf & EncodedVtxoScript & Coin)[];
    }

    export function isBoardingUtxos(response: Base): response is BoardingUtxos {
        return response.type === "BOARDING_UTXOS" && response.success === true;
    }

    export function boardingUtxos(
        boardingUtxos: (TaprootLeaf & EncodedVtxoScript & Coin)[]
    ): BoardingUtxos {
        return {
            type: "BOARDING_UTXOS",
            success: true,
            boardingUtxos,
        };
    }

    export interface SendBitcoinSuccess extends Base {
        type: "SEND_BITCOIN_SUCCESS";
        success: true;
        txid: string;
    }

    export function isSendBitcoinSuccess(
        response: Base
    ): response is SendBitcoinSuccess {
        return (
            response.type === "SEND_BITCOIN_SUCCESS" &&
            response.success === true
        );
    }

    export function sendBitcoinSuccess(txid: string): SendBitcoinSuccess {
        return {
            type: "SEND_BITCOIN_SUCCESS",
            success: true,
            txid,
        };
    }

    export interface TransactionHistory extends Base {
        type: "TRANSACTION_HISTORY";
        success: true;
        transactions: ArkTransaction[];
    }

    export function isTransactionHistory(
        response: Base
    ): response is TransactionHistory {
        return (
            response.type === "TRANSACTION_HISTORY" && response.success === true
        );
    }

    export function transactionHistory(
        transactions: ArkTransaction[]
    ): TransactionHistory {
        return {
            type: "TRANSACTION_HISTORY",
            success: true,
            transactions,
        };
    }

    export interface WalletStatus extends Base {
        type: "WALLET_STATUS";
        success: true;
        status: {
            walletInitialized: boolean;
        };
    }

    export function isWalletStatus(response: Base): response is WalletStatus {
        return response.type === "WALLET_STATUS" && response.success === true;
    }

    export function walletStatus(walletInitialized: boolean): WalletStatus {
        return {
            type: "WALLET_STATUS",
            success: true,
            status: {
                walletInitialized,
            },
        };
    }
}
