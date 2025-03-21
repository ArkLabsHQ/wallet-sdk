import {
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    AddressInfo,
    Coin,
    VirtualCoin,
    ArkTransaction,
    WalletConfig,
} from "..";
import { Request } from "./request";
import { Response } from "./response";
import { SettlementEvent } from "../../providers/ark";
import { EncodedVtxoScript } from "../../script/base";
import { TaprootLeaf } from "@scure/btc-signer/payment";

// ServiceWorkerWallet is a wallet that uses a service worker as "backend" to handle the wallet logic
export class ServiceWorkerWallet implements IWallet {
    private serviceWorker?: ServiceWorker;

    static async create(svcWorkerPath: string): Promise<ServiceWorkerWallet> {
        try {
            const wallet = new ServiceWorkerWallet();
            await wallet.setupServiceWorker(svcWorkerPath);
            return wallet;
        } catch (error) {
            throw new Error(
                `Failed to initialize service worker wallet: ${error}`
            );
        }
    }

    async init(
        config: Omit<WalletConfig, "identity"> & { privateKey: string },
        failIfInitialized = false
    ): Promise<void> {
        // Check if wallet is already initialized
        const statusMessage: Request.GetStatus = {
            type: "GET_STATUS",
        };
        const response = await this.sendMessage(statusMessage);

        if (
            Response.isWalletStatus(response) &&
            response.status.walletInitialized
        ) {
            if (failIfInitialized) {
                throw new Error("Wallet already initialized");
            }
            return;
        }

        // If not initialized, proceed with initialization
        const message: Request.InitWallet = {
            type: "INIT_WALLET",
            privateKey: config.privateKey,
            network: config.network,
            arkServerUrl: config.arkServerUrl || "",
            arkServerPublicKey: config.arkServerPublicKey,
        };

        await this.sendMessage(message);
    }

    // register the service worker
    private async setupServiceWorker(path: string): Promise<void> {
        // check if service workers are supported
        if (!("serviceWorker" in navigator)) {
            throw new Error(
                "Service workers are not supported in this browser"
            );
        }

        try {
            // check for existing registration
            const existingRegistration =
                await navigator.serviceWorker.getRegistration(path);
            let registration: ServiceWorkerRegistration;

            if (existingRegistration) {
                registration = existingRegistration;
            } else {
                registration = await navigator.serviceWorker.register(path);
            }

            const sw =
                registration.active ||
                registration.waiting ||
                registration.installing;
            if (!sw) {
                throw new Error("Failed to get service worker instance");
            }
            this.serviceWorker = sw;

            // wait for the service worker to be ready
            if (this.serviceWorker?.state !== "activated") {
                await new Promise<void>((resolve) => {
                    if (!this.serviceWorker) return resolve();
                    this.serviceWorker.addEventListener("statechange", () => {
                        if (this.serviceWorker?.state === "activated") {
                            resolve();
                        }
                    });
                });
            }
        } catch (error) {
            throw new Error(`Failed to setup service worker: ${error}`);
        }
    }

    // send a message and wait for a response
    private async sendMessage<T extends Request.Base>(
        message: T
    ): Promise<Response.Base> {
        if (!this.serviceWorker) {
            throw new Error("Service worker not initialized");
        }

        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data as Response.Base;
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );

                if (!response.success) {
                    reject(new Error((response as Response.Error).message));
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            if (this.serviceWorker) {
                this.serviceWorker.postMessage(message);
            } else {
                reject(new Error("Service worker not initialized"));
            }
        });
    }

    async getAddress(): Promise<AddressInfo> {
        const message: Request.GetAddress = {
            type: "GET_ADDRESS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isAddress(response)) {
                return response.address;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get address: ${error}`);
        }
    }

    async getBalance(): Promise<WalletBalance> {
        const message: Request.GetBalance = {
            type: "GET_BALANCE",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBalance(response)) {
                return response.balance;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get balance: ${error}`);
        }
    }

    async getCoins(): Promise<Coin[]> {
        const message: Request.GetCoins = {
            type: "GET_COINS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isCoins(response)) {
                return response.coins;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get coins: ${error}`);
        }
    }

    async getVtxos(): Promise<
        (TaprootLeaf & EncodedVtxoScript & VirtualCoin)[]
    > {
        const message: Request.GetVtxos = {
            type: "GET_VTXOS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isVtxos(response)) {
                return response.vtxos;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get vtxos: ${error}`);
        }
    }

    async getBoardingUtxos(): Promise<
        (TaprootLeaf & EncodedVtxoScript & Coin)[]
    > {
        const message: Request.GetBoardingUtxos = {
            type: "GET_BOARDING_UTXOS",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isBoardingUtxos(response)) {
                return response.boardingUtxos;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get boarding UTXOs: ${error}`);
        }
    }

    async sendBitcoin(
        params: SendBitcoinParams,
        zeroFee?: boolean
    ): Promise<string> {
        const message: Request.SendBitcoin = {
            type: "SEND_BITCOIN",
            params,
            zeroFee,
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isSendBitcoinSuccess(response)) {
                return response.txid;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to send bitcoin: ${error}`);
        }
    }

    async settle(
        params?: SettleParams,
        callback?: (event: SettlementEvent) => void
    ): Promise<string> {
        const message: Request.Settle = {
            type: "SETTLE",
            params,
        };

        try {
            return new Promise((resolve, reject) => {
                const messageHandler = (event: MessageEvent) => {
                    const response = event.data as Response.Base;

                    if (!response.success) {
                        navigator.serviceWorker.removeEventListener(
                            "message",
                            messageHandler
                        );
                        reject(new Error((response as Response.Error).message));
                        return;
                    }

                    switch (response.type) {
                        case "SETTLE_EVENT":
                            if (callback) {
                                callback(
                                    (response as Response.SettleEvent).event
                                );
                            }
                            break;
                        case "SETTLE_SUCCESS":
                            navigator.serviceWorker.removeEventListener(
                                "message",
                                messageHandler
                            );
                            resolve((response as Response.SettleSuccess).txid);
                            break;
                        default:
                            break;
                    }
                };

                navigator.serviceWorker.addEventListener(
                    "message",
                    messageHandler
                );
                if (this.serviceWorker) {
                    this.serviceWorker.postMessage(message);
                } else {
                    reject(new Error("Service worker not initialized"));
                }
            });
        } catch (error) {
            throw new Error(`Settlement failed: ${error}`);
        }
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        const message: Request.GetTransactionHistory = {
            type: "GET_TRANSACTION_HISTORY",
        };

        try {
            const response = await this.sendMessage(message);
            if (Response.isTransactionHistory(response)) {
                return response.transactions;
            }
            throw new Error("Unexpected response type");
        } catch (error) {
            throw new Error(`Failed to get transaction history: ${error}`);
        }
    }
}
