/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { InMemoryKey } from "../../identity/inMemoryKey";
import { isSpendable, VtxoTaprootAddress } from "..";
import { Wallet } from "../wallet";
import { Request } from "./request";
import { Response } from "./response";
import { ArkProvider, RestArkProvider } from "../../providers/ark";
import { IndexedDBVtxoRepository } from "./db/vtxo/idb";
import { VtxoRepository } from "./db/vtxo";
import { vtxosToTxs } from "../../utils/transactionHistory";
import { IndexerProvider, RestIndexerProvider } from "../../providers/indexer";
import { ArkAddress } from "../../script/address";
import { VtxoScript } from "../../script/base";
import { hex } from "@scure/base";

// Worker is a class letting to interact with ServiceWorkerWallet from the client
// it aims to be run in a service worker context
export class Worker {
    private wallet: Wallet | undefined;
    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private vtxoSubscription: AbortController | undefined;

    constructor(
        private readonly vtxoRepository: VtxoRepository = new IndexedDBVtxoRepository(),
        private readonly messageCallback: (
            message: ExtendableMessageEvent
        ) => void = () => {}
    ) {}

    async start(withServiceWorkerUpdate = true) {
        self.addEventListener(
            "message",
            async (event: ExtendableMessageEvent) => {
                await this.handleMessage(event);
            }
        );
        if (withServiceWorkerUpdate) {
            // activate service worker immediately
            self.addEventListener("install", () => {
                self.skipWaiting();
            });
            // take control of clients immediately
            self.addEventListener("activate", () => {
                self.clients.claim();
            });
        }
    }

    async clear() {
        if (this.vtxoSubscription) {
            this.vtxoSubscription.abort();
        }

        await this.vtxoRepository.close();
        this.wallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
        this.vtxoSubscription = undefined;
    }

    private async onWalletInitialized() {
        if (
            !this.wallet ||
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.wallet.offchainTapscript ||
            !this.wallet.boardingTapscript
        ) {
            return;
        }
        // subscribe to address updates
        const addressInfo = await this.wallet.getAddressInfo();
        if (!addressInfo.offchain) {
            return;
        }

        await this.vtxoRepository.open();

        const encodedOffchainTapscript = this.wallet.offchainTapscript.encode();
        const forfeit = this.wallet.offchainTapscript.forfeit();
        const exit = this.wallet.offchainTapscript.exit();

        // set the initial vtxos state
        const vtxos = (
            await this.indexerProvider.getVtxos({
                addresses: [addressInfo.offchain.address],
            })
        ).map((vtxo) => ({
            ...vtxo,
            forfeitTapLeafScript: forfeit,
            intentTapLeafScript: exit,
            tapTree: encodedOffchainTapscript,
        }));

        await this.vtxoRepository.addOrUpdate(vtxos);

        this.processVtxoSubscription(addressInfo.offchain);
    }

    private async processVtxoSubscription({
        address,
        scripts,
    }: VtxoTaprootAddress) {
        try {
            const addressScripts = [...scripts.exit, ...scripts.forfeit];

            const vtxoScript = new VtxoScript(addressScripts.map(hex.decode));
            const forfeitTapLeafScript = vtxoScript.findLeaf(
                scripts.forfeit[0]
            );
            const intentTapLeafScript = vtxoScript.findLeaf(scripts.exit[0]);

            const abortController = new AbortController();
            const subscriptionId =
                await this.indexerProvider!.subscribeForScripts([
                    hex.encode(ArkAddress.decode(address).pkScript),
                ]);
            const subscription = this.indexerProvider!.getSubscription(
                subscriptionId,
                abortController.signal
            );

            this.vtxoSubscription = abortController;

            const tapTree = vtxoScript.encode();

            for await (const update of subscription) {
                const vtxos = [...update.newVtxos, ...update.spentVtxos];
                if (vtxos.length === 0) {
                    continue;
                }

                const extendedVtxos = vtxos.map((vtxo) => ({
                    ...vtxo,
                    forfeitTapLeafScript,
                    intentTapLeafScript,
                    tapTree,
                }));

                await this.vtxoRepository.addOrUpdate(extendedVtxos);
            }
        } catch (error) {
            console.error("Error processing address updates:", error);
        }
    }

    private async handleClear(event: ExtendableMessageEvent) {
        this.clear();
        if (Request.isBase(event.data)) {
            event.source?.postMessage(
                Response.clearResponse(event.data.id, true)
            );
        }
    }

    private async handleInitWallet(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isInitWallet(message)) {
            console.error("Invalid INIT_WALLET message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid INIT_WALLET message format")
            );
            return;
        }

        try {
            this.arkProvider = new RestArkProvider(message.arkServerUrl);
            this.indexerProvider = new RestIndexerProvider(
                message.arkServerUrl
            );

            this.wallet = await Wallet.create({
                network: message.network,
                identity: InMemoryKey.fromHex(message.privateKey),
                arkServerUrl: message.arkServerUrl,
                arkServerPublicKey: message.arkServerPublicKey,
            });

            event.source?.postMessage(Response.walletInitialized(message.id));
            await this.onWalletInitialized();
        } catch (error: unknown) {
            console.error("Error initializing wallet:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSettle(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSettle(message)) {
            console.error("Invalid SETTLE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid SETTLE message format")
            );
            return;
        }

        try {
            if (!this.wallet) {
                console.error("Wallet not initialized");
                event.source?.postMessage(
                    Response.error(message.id, "Wallet not initialized")
                );
                return;
            }

            const txid = await this.wallet.settle(message.params, (e) => {
                event.source?.postMessage(Response.settleEvent(message.id, e));
            });

            event.source?.postMessage(Response.settleSuccess(message.id, txid));
        } catch (error: unknown) {
            console.error("Error settling:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleSendBitcoin(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isSendBitcoin(message)) {
            console.error("Invalid SEND_BITCOIN message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid SEND_BITCOIN message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const txid = await this.wallet.sendBitcoin(message.params);
            event.source?.postMessage(
                Response.sendBitcoinSuccess(message.id, txid)
            );
        } catch (error: unknown) {
            console.error("Error sending bitcoin:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetAddress(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAddress(message)) {
            console.error("Invalid GET_ADDRESS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_ADDRESS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const addresses = await this.wallet.getAddress();
            event.source?.postMessage(
                Response.addresses(message.id, addresses)
            );
        } catch (error: unknown) {
            console.error("Error getting address:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetAddressInfo(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetAddressInfo(message)) {
            console.error("Invalid GET_ADDRESS_INFO message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_ADDRESS_INFO message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const addressInfo = await this.wallet.getAddressInfo();
            event.source?.postMessage(
                Response.addressInfo(message.id, addressInfo)
            );
        } catch (error: unknown) {
            console.error("Error getting address info:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetBalance(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBalance(message)) {
            console.error("Invalid GET_BALANCE message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_BALANCE message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const coins = await this.wallet.getCoins();
            const onchainConfirmed = coins
                .filter((coin) => coin.status.confirmed)
                .reduce((sum, coin) => sum + coin.value, 0);
            const onchainUnconfirmed = coins
                .filter((coin) => !coin.status.confirmed)
                .reduce((sum, coin) => sum + coin.value, 0);
            const onchainTotal = onchainConfirmed + onchainUnconfirmed;

            const spendableVtxos =
                await this.vtxoRepository.getSpendableVtxos();
            const offchainSettledBalance = spendableVtxos.reduce(
                (sum, vtxo) =>
                    vtxo.virtualStatus.state === "settled"
                        ? sum + vtxo.value
                        : sum,
                0
            );
            const offchainPendingBalance = spendableVtxos.reduce(
                (sum, vtxo) =>
                    vtxo.virtualStatus.state === "preconfirmed"
                        ? sum + vtxo.value
                        : sum,
                0
            );
            const offchainSweptBalance = spendableVtxos.reduce(
                (sum, vtxo) =>
                    vtxo.virtualStatus.state === "swept"
                        ? sum + vtxo.value
                        : sum,
                0
            );

            const offchainTotal =
                offchainSettledBalance +
                offchainPendingBalance +
                offchainSweptBalance;

            event.source?.postMessage(
                Response.balance(message.id, {
                    onchain: {
                        confirmed: onchainConfirmed,
                        unconfirmed: onchainUnconfirmed,
                        total: onchainTotal,
                    },
                    offchain: {
                        swept: offchainSweptBalance,
                        settled: offchainSettledBalance,
                        pending: offchainPendingBalance,
                        total: offchainTotal,
                    },
                    total: onchainTotal + offchainTotal,
                })
            );
        } catch (error: unknown) {
            console.error("Error getting balance:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetCoins(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetCoins(message)) {
            console.error("Invalid GET_COINS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_COINS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const coins = await this.wallet.getCoins();
            event.source?.postMessage(Response.coins(message.id, coins));
        } catch (error: unknown) {
            console.error("Error getting coins:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetVtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetVtxos(message)) {
            console.error("Invalid GET_VTXOS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_VTXOS message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const vtxos = await this.vtxoRepository.getSpendableVtxos();
            if (message.filter?.withSpendableInSettlement) {
                const sweptVtxos = await this.vtxoRepository.getSweptVtxos();
                vtxos.push(...sweptVtxos.filter(isSpendable));
            }
            event.source?.postMessage(Response.vtxos(message.id, vtxos));
        } catch (error: unknown) {
            console.error("Error getting vtxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetBoardingUtxos(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetBoardingUtxos(message)) {
            console.error("Invalid GET_BOARDING_UTXOS message format", message);
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_BOARDING_UTXOS message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const boardingUtxos = await this.wallet.getBoardingUtxos();
            event.source?.postMessage(
                Response.boardingUtxos(message.id, boardingUtxos)
            );
        } catch (error: unknown) {
            console.error("Error getting boarding utxos:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetTransactionHistory(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetTransactionHistory(message)) {
            console.error(
                "Invalid GET_TRANSACTION_HISTORY message format",
                message
            );
            event.source?.postMessage(
                Response.error(
                    message.id,
                    "Invalid GET_TRANSACTION_HISTORY message format"
                )
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            const { boardingTxs, commitmentsToIgnore: roundsToIgnore } =
                await this.wallet.getBoardingTxs();

            const { spendable, spent } =
                await this.vtxoRepository.getAllVtxos();

            // convert VTXOs to offchain transactions
            const offchainTxs = vtxosToTxs(spendable, spent, roundsToIgnore);

            const txs = [...boardingTxs, ...offchainTxs];

            // sort transactions by creation time in descending order (newest first)
            txs.sort(
                // place createdAt = 0 (unconfirmed txs) first, then descending
                (a, b) => {
                    if (a.createdAt === 0) return -1;
                    if (b.createdAt === 0) return 1;
                    return b.createdAt - a.createdAt;
                }
            );

            event.source?.postMessage(
                Response.transactionHistory(message.id, txs)
            );
        } catch (error: unknown) {
            console.error("Error getting transaction history:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleGetStatus(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isGetStatus(message)) {
            console.error("Invalid GET_STATUS message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid GET_STATUS message format")
            );
            return;
        }

        event.source?.postMessage(
            Response.walletStatus(message.id, this.wallet !== undefined)
        );
    }

    private async handleExit(event: ExtendableMessageEvent) {
        const message = event.data;
        if (!Request.isExit(message)) {
            console.error("Invalid EXIT message format", message);
            event.source?.postMessage(
                Response.error(message.id, "Invalid EXIT message format")
            );
            return;
        }

        if (!this.wallet) {
            console.error("Wallet not initialized");
            event.source?.postMessage(
                Response.error(message.id, "Wallet not initialized")
            );
            return;
        }

        try {
            await this.wallet.exit(message.outpoints);
            event.source?.postMessage(Response.exitSuccess(message.id));
        } catch (error: unknown) {
            console.error("Error exiting:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred";
            event.source?.postMessage(Response.error(message.id, errorMessage));
        }
    }

    private async handleMessage(event: ExtendableMessageEvent) {
        this.messageCallback(event);
        const message = event.data;
        if (!Request.isBase(message)) {
            console.warn("Invalid message format", JSON.stringify(message));
            // ignore invalid messages
            return;
        }

        switch (message.type) {
            case "INIT_WALLET": {
                await this.handleInitWallet(event);
                break;
            }
            case "SETTLE": {
                await this.handleSettle(event);
                break;
            }
            case "SEND_BITCOIN": {
                await this.handleSendBitcoin(event);
                break;
            }
            case "GET_ADDRESS": {
                await this.handleGetAddress(event);
                break;
            }
            case "GET_ADDRESS_INFO": {
                await this.handleGetAddressInfo(event);
                break;
            }
            case "GET_BALANCE": {
                await this.handleGetBalance(event);
                break;
            }
            case "GET_COINS": {
                await this.handleGetCoins(event);
                break;
            }
            case "GET_VTXOS": {
                await this.handleGetVtxos(event);
                break;
            }
            case "GET_BOARDING_UTXOS": {
                await this.handleGetBoardingUtxos(event);
                break;
            }
            case "GET_TRANSACTION_HISTORY": {
                await this.handleGetTransactionHistory(event);
                break;
            }
            case "GET_STATUS": {
                await this.handleGetStatus(event);
                break;
            }
            case "EXIT": {
                await this.handleExit(event);
                break;
            }
            case "CLEAR": {
                await this.handleClear(event);
                break;
            }
            default:
                event.source?.postMessage(
                    Response.error(message.id, "Unknown message type")
                );
        }
    }
}
