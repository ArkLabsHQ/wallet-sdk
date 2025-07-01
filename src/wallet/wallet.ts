import { base64, hex } from "@scure/base";
import * as bip68 from "bip68";
import {
    Address,
    OutScript,
    P2TR,
    p2tr,
    tapLeafHash,
} from "@scure/btc-signer/payment";
import { Transaction } from "@scure/btc-signer";
import {
    TaprootControlBlock,
    TransactionInput,
    TransactionOutput,
} from "@scure/btc-signer/psbt";
import { vtxosToTxs } from "../utils/transactionHistory";
import { BIP21 } from "../utils/bip21";
import { ArkAddress } from "../script/address";
import { DefaultVtxo } from "../script/default";
import { selectCoins, selectVirtualCoins } from "../utils/coinselect";
import { getNetwork, Network, NetworkName } from "../networks";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "../providers/onchain";
import {
    BatchFinalizationEvent,
    SettlementEvent,
    SettlementEventType,
    TreeNoncesAggregatedEvent,
    TreeSigningStartedEvent,
    ArkProvider,
    RestArkProvider,
    BatchStartedEvent,
    Intent,
} from "../providers/ark";
import { SignerSession } from "../tree/signingSession";
import { buildForfeitTx } from "../forfeit";
import { validateConnectorsTree, validateVtxoTree } from "../tree/validation";
import { Identity } from "../identity";
import {
    Addresses,
    AddressInfo,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    isRecoverable,
    isSpendable,
    isSubdust,
    IWallet,
    Outpoint,
    SendBitcoinParams,
    SettleParams,
    TxType,
    VirtualCoin,
    WalletBalance,
    WalletConfig,
} from ".";
import { Bytes, sha256 } from "@scure/btc-signer/utils";
import { VtxoScript } from "../script/base";
import { CSVMultisigTapscript, RelativeTimelock } from "../script/tapscript";
import { buildOffchainTx } from "../utils/psbt";
import { ArkNote } from "../arknote";
import { TxTree } from "../tree/vtxoTree";
import { BIP322 } from "../bip322";
import { IndexerProvider, RestIndexerProvider } from "../providers/indexer";

// Wallet does not store any data and rely on the Ark and onchain providers to fetch utxos and vtxos
export class Wallet implements IWallet {
    // TODO get dust from ark server?
    static DUST_AMOUNT = BigInt(546); // Bitcoin dust limit in satoshis = 546
    static FEE_RATE = 1; // sats/vbyte

    private constructor(
        private identity: Identity,
        private network: Network,
        private onchainProvider: OnchainProvider,
        private onchainP2TR: P2TR,
        private arkProvider?: ArkProvider,
        private indexerProvider?: IndexerProvider,
        private arkServerPublicKey?: Bytes,
        readonly offchainTapscript?: DefaultVtxo.Script,
        readonly boardingTapscript?: DefaultVtxo.Script,
        readonly serverUnrollScript?: CSVMultisigTapscript.Type,
        readonly forfeitOutputScript?: Bytes
    ) {}

    static async create(config: WalletConfig): Promise<Wallet> {
        const network = getNetwork(config.network as NetworkName);
        const onchainProvider = new EsploraProvider(
            config.esploraUrl || ESPLORA_URL[config.network as NetworkName]
        );

        // Derive onchain address
        const pubkey = config.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        let arkProvider: ArkProvider | undefined;
        if (config.arkServerUrl) {
            arkProvider = new RestArkProvider(config.arkServerUrl);
        }

        let indexerProvider: IndexerProvider | undefined;
        if (config.arkServerUrl) {
            indexerProvider = new RestIndexerProvider(config.arkServerUrl);
        }

        // Save onchain Taproot address key-path only
        const onchainP2TR = p2tr(pubkey, undefined, network);

        if (arkProvider) {
            const info = await arkProvider.getInfo();
            if (info.network !== config.network) {
                throw new Error(
                    `The Ark Server URL expects ${info.network} but ${config.network} was configured`
                );
            }
            const exitTimelock: RelativeTimelock = {
                value: info.unilateralExitDelay,
                type: info.unilateralExitDelay < 512n ? "blocks" : "seconds",
            };
            const boardingTimelock: RelativeTimelock = {
                value: info.boardingExitDelay,
                type: info.boardingExitDelay < 512n ? "blocks" : "seconds",
            };
            // Generate tapscripts for offchain and boarding address
            const serverPubKey = hex.decode(info.pubkey).slice(1);
            const bareVtxoTapscript = new DefaultVtxo.Script({
                pubKey: pubkey,
                serverPubKey,
                csvTimelock: exitTimelock,
            });
            const boardingTapscript = new DefaultVtxo.Script({
                pubKey: pubkey,
                serverPubKey,
                csvTimelock: boardingTimelock,
            });

            // Save tapscripts
            const offchainTapscript = bareVtxoTapscript;

            // the serverUnrollScript is the one used to create output scripts of the checkpoint transactions
            const serverUnrollScript = CSVMultisigTapscript.encode({
                timelock: exitTimelock,
                pubkeys: [serverPubKey],
            });

            // parse the server forfeit address
            // server is expecting funds to be sent to this address
            const forfeitAddress = Address(network).decode(info.forfeitAddress);
            const forfeitOutputScript = OutScript.encode(forfeitAddress);

            return new Wallet(
                config.identity,
                network,
                onchainProvider,
                onchainP2TR,
                arkProvider,
                indexerProvider,
                serverPubKey,
                offchainTapscript,
                boardingTapscript,
                serverUnrollScript,
                forfeitOutputScript
            );
        }

        return new Wallet(
            config.identity,
            network,
            onchainProvider,
            onchainP2TR
        );
    }

    get onchainAddress(): string {
        return this.onchainP2TR.address || "";
    }

    get boardingAddress(): ArkAddress {
        if (!this.boardingTapscript || !this.arkServerPublicKey) {
            throw new Error("Boarding address not configured");
        }
        return this.boardingTapscript.address(
            this.network.hrp,
            this.arkServerPublicKey
        );
    }

    get boardingOnchainAddress(): string {
        if (!this.boardingTapscript) {
            throw new Error("Boarding address not configured");
        }
        return this.boardingTapscript.onchainAddress(this.network);
    }

    get offchainAddress(): ArkAddress {
        if (!this.offchainTapscript || !this.arkServerPublicKey) {
            throw new Error("Offchain address not configured");
        }
        return this.offchainTapscript.address(
            this.network.hrp,
            this.arkServerPublicKey
        );
    }

    getAddress(): Promise<Addresses> {
        const addressInfo: Addresses = {
            onchain: this.onchainAddress,
            bip21: BIP21.create({
                address: this.onchainAddress,
            }),
        };

        // Only include Ark-related fields if Ark provider is configured and address is available
        if (
            this.arkProvider &&
            this.offchainTapscript &&
            this.boardingTapscript &&
            this.arkServerPublicKey
        ) {
            const offchainAddress = this.offchainAddress.encode();
            addressInfo.offchain = offchainAddress;
            addressInfo.bip21 = BIP21.create({
                address: this.onchainP2TR.address,
                ark: offchainAddress,
            });
            addressInfo.boarding = this.boardingOnchainAddress;
        }

        return Promise.resolve(addressInfo);
    }

    getAddressInfo(): Promise<AddressInfo> {
        if (
            !this.arkProvider ||
            !this.offchainTapscript ||
            !this.boardingTapscript ||
            !this.arkServerPublicKey
        ) {
            throw new Error("Ark provider not configured");
        }

        const offchainAddress = this.offchainAddress.encode();
        const boardingAddress = this.boardingOnchainAddress;

        return Promise.resolve({
            offchain: {
                address: offchainAddress,
                scripts: {
                    exit: [this.offchainTapscript.exitScript],
                    forfeit: [this.offchainTapscript.forfeitScript],
                },
            },
            boarding: {
                address: boardingAddress,
                scripts: {
                    exit: [this.boardingTapscript.exitScript],
                    forfeit: [this.boardingTapscript.forfeitScript],
                },
            },
        });
    }

    async getBalance(): Promise<WalletBalance> {
        // Get onchain coins
        const coins = await this.getCoins();
        const onchainConfirmed = coins
            .filter((coin) => coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainUnconfirmed = coins
            .filter((coin) => !coin.status.confirmed)
            .reduce((sum, coin) => sum + coin.value, 0);
        const onchainTotal = onchainConfirmed + onchainUnconfirmed;

        // Get offchain coins if Indexer provider is configured
        let offchainSettled = 0;
        let offchainPending = 0;
        let offchainSwept = 0;
        if (this.indexerProvider) {
            const vtxos = await this.getVtxos();
            offchainSettled = vtxos
                .filter((coin) => coin.virtualStatus.state === "settled")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainPending = vtxos
                .filter((coin) => coin.virtualStatus.state === "preconfirmed")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainSwept = vtxos
                .filter(
                    (coin) =>
                        isSpendable(coin) &&
                        coin.virtualStatus.state === "swept"
                )
                .reduce((sum, coin) => sum + coin.value, 0);
        }
        const offchainTotal = offchainSettled + offchainPending + offchainSwept;

        return {
            onchain: {
                confirmed: onchainConfirmed,
                unconfirmed: onchainUnconfirmed,
                total: onchainTotal,
            },
            offchain: {
                swept: offchainSwept,
                settled: offchainSettled,
                pending: offchainPending,
                total: offchainTotal,
            },
            total: onchainTotal + offchainTotal,
        };
    }

    async getCoins(): Promise<Coin[]> {
        // TODO: add caching logic to lower the number of requests to provider
        const address = await this.getAddress();
        return this.onchainProvider.getCoins(address.onchain);
    }

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        if (
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.offchainTapscript
        ) {
            return [];
        }

        const address = await this.getAddress();
        if (!address.offchain) {
            return [];
        }

        const spendableVtxos = await this.getVirtualCoins(filter);
        const encodedOffchainTapscript = this.offchainTapscript.encode();
        const forfeit = this.offchainTapscript.forfeit();
        const exit = this.offchainTapscript.exit();

        return spendableVtxos.map((vtxo) => ({
            ...vtxo,
            forfeitTapLeafScript: forfeit,
            intentTapLeafScript: exit,
            tapTree: encodedOffchainTapscript,
        }));
    }

    private async getVirtualCoins(
        filter: GetVtxosFilter = { withSpendableInSettlement: true }
    ): Promise<VirtualCoin[]> {
        if (!this.indexerProvider) {
            return [];
        }

        const address = await this.getAddress();
        if (!address.offchain) {
            return [];
        }

        const getVtxosArgs = {
            addresses: [address.offchain],
            spendableOnly: !filter.withSpendableInSettlement,
        };

        let vtxos = await this.indexerProvider.getVtxos(getVtxosArgs);

        if (filter.withSpendableInSettlement) {
            vtxos = vtxos.filter((v) => isSpendable(v));
        }

        return vtxos;
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        if (!this.indexerProvider) {
            return [];
        }

        const vtxos = await this.indexerProvider.getVtxos({
            addresses: [this.offchainAddress.encode()],
        });

        const { boardingTxs, commitmentsToIgnore } =
            await this.getBoardingTxs();

        const spendableVtxos = [];
        const spentVtxos = [];

        for (const vtxo of vtxos) {
            if (isSpendable(vtxo)) {
                spendableVtxos.push(vtxo);
            } else {
                spentVtxos.push(vtxo);
            }
        }

        // convert VTXOs to offchain transactions
        const offchainTxs = vtxosToTxs(
            spendableVtxos,
            spentVtxos,
            commitmentsToIgnore
        );

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

        return txs;
    }

    async getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        commitmentsToIgnore: Set<string>;
    }> {
        if (!this.boardingAddress) {
            return { boardingTxs: [], commitmentsToIgnore: new Set() };
        }

        const boardingAddress = this.boardingOnchainAddress;
        const txs = await this.onchainProvider.getTransactions(boardingAddress);
        const utxos: VirtualCoin[] = [];
        const commitmentsToIgnore = new Set<string>();

        for (const tx of txs) {
            for (let i = 0; i < tx.vout.length; i++) {
                const vout = tx.vout[i];
                if (vout.scriptpubkey_address === boardingAddress) {
                    const spentStatuses =
                        await this.onchainProvider.getTxOutspends(tx.txid);
                    const spentStatus = spentStatuses[i];

                    if (spentStatus?.spent) {
                        commitmentsToIgnore.add(spentStatus.txid);
                    }

                    utxos.push({
                        txid: tx.txid,
                        vout: i,
                        value: Number(vout.value),
                        status: {
                            confirmed: tx.status.confirmed,
                            block_time: tx.status.block_time,
                        },
                        virtualStatus: {
                            state: spentStatus?.spent
                                ? "spent"
                                : "preconfirmed",
                            batchTxID: spentStatus?.spent
                                ? spentStatus.txid
                                : undefined,
                        },
                        createdAt: tx.status.confirmed
                            ? new Date(tx.status.block_time * 1000)
                            : new Date(0),
                    });
                }
            }
        }

        const unconfirmedTxs: ArkTransaction[] = [];
        const confirmedTxs: ArkTransaction[] = [];

        for (const utxo of utxos) {
            const tx: ArkTransaction = {
                key: {
                    boardingTxid: utxo.txid,
                    commitmentTxid: "",
                    arkTxid: "",
                },
                amount: utxo.value,
                type: TxType.TxReceived,
                settled: utxo.virtualStatus.state === "spent",
                createdAt: utxo.status.block_time
                    ? new Date(utxo.status.block_time * 1000).getTime()
                    : 0,
            };

            if (!utxo.status.block_time) {
                unconfirmedTxs.push(tx);
            } else {
                confirmedTxs.push(tx);
            }
        }

        return {
            boardingTxs: [...unconfirmedTxs, ...confirmedTxs],
            commitmentsToIgnore,
        };
    }

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        if (!this.boardingAddress || !this.boardingTapscript) {
            throw new Error("Boarding address not configured");
        }

        const boardingUtxos = await this.onchainProvider.getCoins(
            this.boardingOnchainAddress
        );

        const encodedBoardingTapscript = this.boardingTapscript.encode();
        const forfeit = this.boardingTapscript.forfeit();
        const exit = this.boardingTapscript.exit();

        return boardingUtxos.map((utxo) => ({
            ...utxo,
            forfeitTapLeafScript: forfeit,
            intentTapLeafScript: exit,
            tapTree: encodedBoardingTapscript,
        }));
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        // If Ark is configured and amount is suitable, send via offchain
        if (this.arkProvider && this.isOffchainSuitable(params.address)) {
            return this.sendOffchain(params);
        }

        if (params.amount < Wallet.DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        // Otherwise, send via onchain
        return this.sendOnchain(params);
    }

    private isOffchainSuitable(address: string): boolean {
        try {
            ArkAddress.decode(address);
            return true;
        } catch (e) {
            return false;
        }
    }

    private async sendOnchain(params: SendBitcoinParams): Promise<string> {
        const coins = await this.getCoins();
        const feeRate = params.feeRate || Wallet.FEE_RATE;

        // Ensure fee is an integer by rounding up
        const estimatedFee = Math.ceil(174 * feeRate);
        const totalNeeded = params.amount + estimatedFee;

        // Select coins
        const selected = selectCoins(coins, totalNeeded);
        if (!selected.inputs) {
            throw new Error("Insufficient funds");
        }

        // Create transaction
        let tx = new Transaction();

        // Add inputs
        for (const input of selected.inputs) {
            tx.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: this.onchainP2TR.script,
                    amount: BigInt(input.value),
                },
                tapInternalKey: this.onchainP2TR.tapInternalKey,
            });
        }

        // Add payment output
        tx.addOutputAddress(
            params.address,
            BigInt(params.amount),
            this.network
        );
        // Add change output if needed
        if (selected.changeAmount > 0) {
            tx.addOutputAddress(
                this.onchainAddress,
                BigInt(selected.changeAmount),
                this.network
            );
        }

        // Sign inputs and Finalize
        tx = await this.identity.sign(tx);
        tx.finalize();

        // Broadcast
        const txid = await this.onchainProvider.broadcastTransaction(tx.hex);
        return txid;
    }

    private async sendOffchain(params: SendBitcoinParams): Promise<string> {
        if (
            !this.arkProvider ||
            !this.indexerProvider ||
            !this.offchainAddress ||
            !this.offchainTapscript ||
            !this.serverUnrollScript
        ) {
            throw new Error("wallet not initialized");
        }

        // recoverable and subdust coins can't be spent in offchain tx
        const virtualCoins = await this.getVirtualCoins({
            withSpendableInSettlement: false,
        });

        const selected = selectVirtualCoins(virtualCoins, params.amount);

        if (!selected || !selected.inputs) {
            throw new Error("Insufficient funds");
        }

        const selectedLeaf = this.offchainTapscript.forfeit();
        if (!selectedLeaf) {
            throw new Error("Selected leaf not found");
        }

        const outputAddress = ArkAddress.decode(params.address);
        const outputScript =
            BigInt(params.amount) < Wallet.DUST_AMOUNT
                ? outputAddress.subdustPkScript
                : outputAddress.pkScript;

        const outputs: TransactionOutput[] = [
            {
                script: outputScript,
                amount: BigInt(params.amount),
            },
        ];

        // add change output if needed
        if (selected.changeAmount > 0) {
            const changeOutputScript =
                BigInt(selected.changeAmount) < Wallet.DUST_AMOUNT
                    ? this.offchainAddress.subdustPkScript
                    : this.offchainAddress.pkScript;

            outputs.push({
                script: changeOutputScript,
                amount: BigInt(selected.changeAmount),
            });
        }

        const tapTree = this.offchainTapscript.encode();
        let offchainTx = buildOffchainTx(
            selected.inputs.map((input) => ({
                ...input,
                tapLeafScript: selectedLeaf,
                tapTree,
            })),
            outputs,
            this.serverUnrollScript
        );

        const signedVirtualTx = await this.identity.sign(offchainTx.virtualTx);

        const { arkTxid, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                base64.encode(signedVirtualTx.toPSBT()),
                offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT()))
            );
        // TODO persist final virtual tx and checkpoints to repository

        // sign the checkpoints
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c));
                const signedCheckpoint = await this.identity.sign(tx);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

        return arkTxid;
    }

    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        if (
            !this.arkProvider ||
            !this.arkServerPublicKey ||
            !this.forfeitOutputScript
        ) {
            throw new Error("Ark provider not configured");
        }

        // validate arknotes inputs
        if (params?.inputs) {
            for (const input of params.inputs) {
                if (typeof input === "string") {
                    try {
                        ArkNote.fromString(input);
                    } catch (e) {
                        throw new Error(`Invalid arknote "${input}"`);
                    }
                }
            }
        }

        // if no params are provided, use all boarding and offchain utxos as inputs
        // and send all to the offchain address
        if (!params) {
            if (!this.offchainAddress) {
                throw new Error("Offchain address not configured");
            }

            let amount = 0;
            const boardingUtxos = await this.getBoardingUtxos();
            amount += boardingUtxos.reduce(
                (sum, input) => sum + input.value,
                0
            );

            const vtxos = await this.getVtxos();
            amount += vtxos.reduce((sum, input) => sum + input.value, 0);

            const inputs = [...boardingUtxos, ...vtxos];

            if (inputs.length === 0) {
                throw new Error("No inputs found");
            }

            params = {
                inputs,
                outputs: [
                    {
                        address: this.offchainAddress.encode(),
                        amount: BigInt(amount),
                    },
                ],
            };
        }

        const onchainOutputIndexes: number[] = [];
        const outputs: TransactionOutput[] = [];
        let hasOffchainOutputs = false;

        for (const [index, output] of params.outputs.entries()) {
            let script: Bytes | undefined;
            try {
                // offchain
                const addr = ArkAddress.decode(output.address);
                script = addr.pkScript;
                hasOffchainOutputs = true;
            } catch {
                // onchain
                const addr = Address(this.network).decode(output.address);
                script = OutScript.encode(addr);
                onchainOutputIndexes.push(index);
            }

            outputs.push({
                amount: output.amount,
                script,
            });
        }

        // session holds the state of the musig2 signing process of the vtxo tree
        let session: SignerSession | undefined;
        const signingPublicKeys: string[] = [];
        if (hasOffchainOutputs) {
            session = this.identity.signerSession();
            signingPublicKeys.push(hex.encode(session.getPublicKey()));
        }

        const [intent, deleteIntent] = await Promise.all([
            this.makeRegisterIntentSignature(
                params.inputs,
                outputs,
                onchainOutputIndexes,
                signingPublicKeys
            ),
            this.makeDeleteIntentSignature(params.inputs),
        ]);

        const intentId = await this.arkProvider.registerIntent(intent);

        const abortController = new AbortController();
        // listen to settlement events
        try {
            let step: SettlementEventType | undefined;

            const settlementStream = this.arkProvider.getEventStream(
                abortController.signal
            );

            // roundId, sweepTapTreeRoot and forfeitOutputScript are set once the BatchStarted event is received
            let roundId: string | undefined;
            let sweepTapTreeRoot: Uint8Array | undefined;
            let forfeitOutputScript: Bytes | undefined;

            const vtxoTree = TxTree.empty();
            const connectorsTree = TxTree.empty();

            for await (const event of settlementStream) {
                if (eventCallback) {
                    eventCallback(event);
                }
                switch (event.type) {
                    // the settlement failed
                    case SettlementEventType.BatchFailed:
                        // fail if the roundId is the one joined
                        if (event.id === roundId) {
                            throw new Error(event.reason);
                        }
                        break;
                    case SettlementEventType.BatchStarted:
                        if (step !== undefined) {
                            continue;
                        }
                        const res = await this.handleBatchStartedEvent(
                            event,
                            intentId,
                            this.arkServerPublicKey,
                            this.forfeitOutputScript
                        );
                        if (!res.skip) {
                            step = event.type;
                            sweepTapTreeRoot = res.sweepTapTreeRoot;
                            forfeitOutputScript = res.forfeitOutputScript;
                            roundId = res.roundId;
                            if (!hasOffchainOutputs) {
                                // if there are no offchain outputs, we don't have to handle musig2 tree signatures
                                // we can directly advance to the finalization step
                                step = SettlementEventType.TreeNoncesAggregated;
                            }
                        }
                        break;
                    case SettlementEventType.TreeTx:
                        if (
                            step !== SettlementEventType.BatchStarted &&
                            step !== SettlementEventType.TreeNoncesAggregated
                        ) {
                            continue;
                        }
                        // index 0 = vtxo tree
                        if (event.batchIndex === 0) {
                            vtxoTree.addNode(event.treeTx);
                            // index 1 = connectors tree
                        } else if (event.batchIndex === 1) {
                            connectorsTree.addNode(event.treeTx);
                        } else {
                            throw new Error(
                                `Invalid batch index: ${event.batchIndex}`
                            );
                        }
                        break;
                    case SettlementEventType.TreeSignature:
                        if (step !== SettlementEventType.TreeNoncesAggregated) {
                            continue;
                        }
                        if (!hasOffchainOutputs) {
                            continue;
                        }
                        // index 0 = vtxo tree
                        if (event.batchIndex === 0) {
                            vtxoTree.addSignature(
                                event.signature,
                                event.level,
                                event.levelIndex
                            );
                            // index 1 = connectors tree
                        } else if (event.batchIndex === 1) {
                            connectorsTree.addSignature(
                                event.signature,
                                event.level,
                                event.levelIndex
                            );
                        } else {
                            throw new Error(
                                `Invalid batch index: ${event.batchIndex}`
                            );
                        }
                        break;
                    // the server has started the signing process of the vtxo tree transactions
                    // the server expects the partial musig2 nonces for each tx
                    case SettlementEventType.TreeSigningStarted:
                        if (step !== SettlementEventType.BatchStarted) {
                            continue;
                        }
                        if (hasOffchainOutputs) {
                            if (!session) {
                                throw new Error("Signing session not set");
                            }
                            if (!sweepTapTreeRoot) {
                                throw new Error("Sweep tap tree root not set");
                            }
                            await this.handleSettlementSigningEvent(
                                event,
                                sweepTapTreeRoot,
                                session,
                                vtxoTree
                            );
                        }
                        step = event.type;
                        break;
                    // the musig2 nonces of the vtxo tree transactions are generated
                    // the server expects now the partial musig2 signatures
                    case SettlementEventType.TreeNoncesAggregated:
                        if (step !== SettlementEventType.TreeSigningStarted) {
                            continue;
                        }
                        if (hasOffchainOutputs) {
                            if (!session) {
                                throw new Error("Signing session not set");
                            }
                            await this.handleSettlementSigningNoncesGeneratedEvent(
                                event,
                                session
                            );
                        }
                        step = event.type;
                        break;
                    // the vtxo tree is signed, craft, sign and submit forfeit transactions
                    // if any boarding utxos are involved, the settlement tx is also signed
                    case SettlementEventType.BatchFinalization:
                        if (step !== SettlementEventType.TreeNoncesAggregated) {
                            continue;
                        }

                        if (!forfeitOutputScript) {
                            throw new Error("Forfeit output script not set");
                        }

                        await this.handleSettlementFinalizationEvent(
                            event,
                            params.inputs,
                            forfeitOutputScript,
                            connectorsTree
                        );
                        step = event.type;
                        break;
                    // the settlement is done, last event to be received
                    case SettlementEventType.BatchFinalized:
                        if (step !== SettlementEventType.BatchFinalization) {
                            continue;
                        }
                        abortController.abort();
                        return event.commitmentTxid;
                }
            }
        } catch (error) {
            // close the stream
            abortController.abort();
            try {
                // delete the intent to not be stuck in the queue
                await this.arkProvider.deleteIntent(deleteIntent);
            } catch {}
            throw error;
        }

        throw new Error("Settlement failed");
    }

    async exit(outpoints?: Outpoint[]): Promise<void> {
        // TODO store the exit branches in repository
        // exit should not depend on the ark provider
        // or on the indexer provider
        if (!this.onchainProvider)
            throw new Error("Onchain provider not configured");

        let vtxos = await this.getVtxos();
        if (outpoints && outpoints.length > 0) {
            vtxos = vtxos.filter((vtxo) =>
                outpoints.some(
                    (outpoint) =>
                        vtxo.txid === outpoint.txid &&
                        vtxo.vout === outpoint.vout
                )
            );
        }

        if (vtxos.length === 0) {
            throw new Error("No vtxos to exit");
        }

        // const trees = new Map<string, TxTree>();
        const transactions: string[] = [];

        // for (const vtxo of vtxos) {
        //     const batchTxid = vtxo.virtualStatus.batchTxID;
        //     if (!batchTxid) continue;
        //     if (!trees.has(batchTxid)) {
        //         const round =
        //             await this.arkProvider?.getRound(batchTxid);
        //         trees.set(batchTxid, round?.vtxoTree);
        //     }
        //
        //     const tree = trees.get(batchTxid);
        //     if (!tree) {
        //         throw new Error("Tree not found");
        //     }
        //     const exitBranch = await tree.exitBranch(
        //         vtxo.txid,
        //         async (txid) => {
        //             const status = await this.onchainProvider.getTxStatus(txid);
        //             return status.confirmed;
        //         }
        //     );
        //     transactions.push(...exitBranch);
        // }

        const broadcastedTxs = new Map<string, boolean>();
        for (const tx of transactions) {
            if (broadcastedTxs.has(tx)) continue;
            const txid = await this.onchainProvider.broadcastTransaction(tx);
            broadcastedTxs.set(txid, true);
        }
    }

    private async handleBatchStartedEvent(
        event: BatchStartedEvent,
        intentId: string,
        serverPubKey: Bytes,
        forfeitOutputScript: Bytes
    ): Promise<
        | { skip: true }
        | {
              roundId: string;
              sweepTapTreeRoot: Uint8Array;
              forfeitOutputScript: Bytes;
              skip: false;
          }
    > {
        const utf8IntentId = new TextEncoder().encode(intentId);
        const intentIdHash = sha256(utf8IntentId);
        const intentIdHashStr = hex.encode(new Uint8Array(intentIdHash));

        let skip = true;

        // check if our intent ID hash matches any in the event
        for (const idHash of event.intentIdHashes) {
            if (idHash === intentIdHashStr) {
                if (!this.arkProvider) {
                    throw new Error("Ark provider not configured");
                }
                await this.arkProvider.confirmRegistration(intentId);
                skip = false;
            }
        }

        if (skip) {
            return { skip };
        }

        const sweepTapscript = CSVMultisigTapscript.encode({
            timelock: {
                value: event.batchExpiry,
                type: event.batchExpiry >= 512n ? "seconds" : "blocks",
            },
            pubkeys: [serverPubKey],
        }).script;

        const sweepTapTreeRoot = tapLeafHash(sweepTapscript);

        return {
            roundId: event.id,
            sweepTapTreeRoot,
            forfeitOutputScript,
            skip: false,
        };
    }

    // validates the vtxo tree, creates a signing session and generates the musig2 nonces
    private async handleSettlementSigningEvent(
        event: TreeSigningStartedEvent,
        sweepTapTreeRoot: Uint8Array,
        session: SignerSession,
        unsignedVtxoTree: TxTree
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // validate the unsigned vtxo tree
        validateVtxoTree(
            event.unsignedCommitmentTx,
            unsignedVtxoTree,
            sweepTapTreeRoot
        );

        // TODO check if our registered outputs are in the vtxo tree

        const settlementPsbt = base64.decode(event.unsignedCommitmentTx);
        const settlementTx = Transaction.fromPSBT(settlementPsbt);
        const sharedOutput = settlementTx.getOutput(0);
        if (!sharedOutput?.amount) {
            throw new Error("Shared output not found");
        }

        session.init(unsignedVtxoTree, sweepTapTreeRoot, sharedOutput.amount);

        await this.arkProvider.submitTreeNonces(
            event.id,
            hex.encode(session.getPublicKey()),
            session.getNonces()
        );
    }

    private async handleSettlementSigningNoncesGeneratedEvent(
        event: TreeNoncesAggregatedEvent,
        session: SignerSession
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        session.setAggregatedNonces(event.treeNonces);
        const signatures = session.sign();

        await this.arkProvider.submitTreeSignatures(
            event.id,
            hex.encode(session.getPublicKey()),
            signatures
        );
    }

    private async handleSettlementFinalizationEvent(
        event: BatchFinalizationEvent,
        inputs: SettleParams["inputs"],
        forfeitOutputScript: Bytes,
        connectors: TxTree
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const vtxos = await this.getVirtualCoins();
        let settlementPsbt = Transaction.fromPSBT(
            base64.decode(event.commitmentTx)
        );
        let hasBoardingUtxos = false;
        let connectorsTreeValid = false;

        for (const input of inputs) {
            // check if the input is an offchain "virtual" coin
            const vtxo = vtxos.find(
                (vtxo) => vtxo.txid === input.txid && vtxo.vout === input.vout
            );

            // boarding utxo, we need to sign the settlement tx
            if (!vtxo) {
                hasBoardingUtxos = true;

                const inputIndexes: number[] = [];
                for (let i = 0; i < settlementPsbt.inputsLength; i++) {
                    const settlementInput = settlementPsbt.getInput(i);

                    if (
                        !settlementInput.txid ||
                        settlementInput.index === undefined
                    ) {
                        throw new Error(
                            "The server returned incomplete data. No settlement input found in the PSBT"
                        );
                    }
                    const inputTxId = hex.encode(settlementInput.txid);
                    if (inputTxId !== input.txid) continue;
                    if (settlementInput.index !== input.vout) continue;
                    // input found in the settlement tx, sign it
                    settlementPsbt.updateInput(i, {
                        tapLeafScript: [input.forfeitTapLeafScript],
                    });
                    inputIndexes.push(i);
                }
                settlementPsbt = await this.identity.sign(
                    settlementPsbt,
                    inputIndexes
                );

                continue;
            }

            if (isRecoverable(vtxo) || isSubdust(vtxo, Wallet.DUST_AMOUNT)) {
                // recoverable or subdust coin, we don't need to create a forfeit tx
                continue;
            }

            if (!connectorsTreeValid) {
                // validate that the connectors tree is valid and contains our expected connectors
                validateConnectorsTree(event.commitmentTx, connectors);
                connectorsTreeValid = true;
            }

            const connectorsLeaves = connectors.leaves();
            const connectorOutpoint = event.connectorsIndex.get(
                `${vtxo.txid}:${vtxo.vout}`
            );
            if (!connectorOutpoint) {
                throw new Error("Connector outpoint not found");
            }

            let connectorOutput: TransactionOutput | undefined;
            for (const leaf of connectorsLeaves) {
                if (leaf.txid === connectorOutpoint.txid) {
                    try {
                        const connectorTx = Transaction.fromPSBT(
                            base64.decode(leaf.tx)
                        );
                        connectorOutput = connectorTx.getOutput(
                            connectorOutpoint.vout
                        );
                        break;
                    } catch {
                        throw new Error("Invalid connector tx");
                    }
                }
            }
            if (
                !connectorOutput ||
                !connectorOutput.amount ||
                !connectorOutput.script
            ) {
                throw new Error("Connector output not found");
            }

            let forfeitTx = buildForfeitTx({
                connectorInput: connectorOutpoint,
                connectorAmount: connectorOutput.amount,
                serverPkScript: forfeitOutputScript,
                connectorPkScript: connectorOutput.script,
                vtxoAmount: BigInt(vtxo.value),
                vtxoInput: input,
                vtxoPkScript: VtxoScript.decode(input.tapTree).pkScript,
            });

            // add the tapscript
            forfeitTx.updateInput(1, {
                tapLeafScript: [input.forfeitTapLeafScript],
            });

            // do not sign the connector input
            forfeitTx = await this.identity.sign(forfeitTx, [1]);

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        if (signedForfeits.length > 0 || hasBoardingUtxos) {
            await this.arkProvider.submitSignedForfeitTxs(
                signedForfeits,
                hasBoardingUtxos
                    ? base64.encode(settlementPsbt.toPSBT())
                    : undefined
            );
        }
    }

    private async makeRegisterIntentSignature(
        bip322Inputs: ExtendedCoin[],
        outputs: TransactionOutput[],
        onchainOutputsIndexes: number[],
        cosignerPubKeys: string[]
    ): Promise<Intent> {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const { inputs, inputTapTrees, finalizer } =
            this.prepareBIP322Inputs(bip322Inputs);

        const message = {
            type: "register",
            input_tap_trees: inputTapTrees,
            onchain_output_indexes: onchainOutputsIndexes,
            valid_at: nowSeconds,
            expire_at: nowSeconds + 2 * 60, // valid for 2 minutes
            cosigners_public_keys: cosignerPubKeys,
        };

        const encodedMessage = JSON.stringify(message, null, 0);
        const signature = await this.makeBIP322Signature(
            encodedMessage,
            inputs,
            finalizer,
            outputs
        );

        return {
            signature,
            message: encodedMessage,
        };
    }

    private async makeDeleteIntentSignature(
        bip322Inputs: ExtendedCoin[]
    ): Promise<{ signature: BIP322.Signature; message: string }> {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const { inputs, finalizer } = this.prepareBIP322Inputs(bip322Inputs);

        const message = {
            type: "delete",
            expire_at: nowSeconds + 2 * 60, // valid for 2 minutes
        };

        const encodedMessage = JSON.stringify(message, null, 0);

        const signature = await this.makeBIP322Signature(
            encodedMessage,
            inputs,
            finalizer
        );

        return {
            signature,
            message: encodedMessage,
        };
    }

    private prepareBIP322Inputs(bip322Inputs: ExtendedCoin[]): {
        inputs: TransactionInput[];
        inputTapTrees: string[];
        finalizer: (tx: BIP322.FullProof) => void;
    } {
        const inputs: TransactionInput[] = [];
        const inputTapTrees: string[] = [];
        const inputExtraWitnesses: Bytes[][] = [];

        for (const bip322Input of bip322Inputs) {
            const vtxoScript = VtxoScript.decode(bip322Input.tapTree);
            const sequence = getSequence(bip322Input);

            inputs.push({
                txid: hex.decode(bip322Input.txid),
                index: bip322Input.vout,
                witnessUtxo: {
                    amount: BigInt(bip322Input.value),
                    script: vtxoScript.pkScript,
                },
                sequence,
                tapLeafScript: [bip322Input.intentTapLeafScript],
            });
            inputTapTrees.push(hex.encode(bip322Input.tapTree));
            inputExtraWitnesses.push(bip322Input.extraWitness || []);
        }

        return {
            inputs,
            inputTapTrees,
            finalizer: finalizeWithExtraWitnesses(inputExtraWitnesses),
        };
    }

    private async makeBIP322Signature(
        message: string,
        inputs: TransactionInput[],
        finalizer: (tx: BIP322.FullProof) => void,
        outputs?: TransactionOutput[]
    ): Promise<BIP322.Signature> {
        const proof = BIP322.create(message, inputs, outputs);
        const signedProof = await this.identity.sign(proof);
        return BIP322.signature(signedProof, finalizer);
    }
}

function finalizeWithExtraWitnesses(
    inputExtraWitnesses: Bytes[][]
): (tx: BIP322.FullProof) => void {
    return function (tx) {
        for (let i = 0; i < tx.inputsLength; i++) {
            try {
                tx.finalizeIdx(i);
            } catch (e) {
                // handle empty witness error
                if (
                    e instanceof Error &&
                    e.message.includes("finalize/taproot: empty witness")
                ) {
                    const tapLeaves = tx.getInput(i).tapLeafScript;
                    if (!tapLeaves || tapLeaves.length <= 0) throw e;
                    const [cb, s] = tapLeaves[0];
                    const script = s.slice(0, -1);
                    tx.updateInput(i, {
                        finalScriptWitness: [
                            script,
                            TaprootControlBlock.encode(cb),
                        ],
                    });
                }
            }

            const finalScriptWitness = tx.getInput(i).finalScriptWitness;
            if (!finalScriptWitness) throw new Error("input not finalized");

            // input 0 and 1 spend the same pkscript
            const extra = inputExtraWitnesses[i === 0 ? 0 : i - 1];
            if (extra && extra.length > 0) {
                tx.updateInput(i, {
                    finalScriptWitness: [...extra, ...finalScriptWitness],
                });
            }
        }
    };
}

function getSequence(bip322Input: ExtendedCoin): number | undefined {
    let sequence: number | undefined = undefined;

    try {
        const scriptWithLeafVersion = bip322Input.intentTapLeafScript[1];
        const script = scriptWithLeafVersion.subarray(
            0,
            scriptWithLeafVersion.length - 1
        );
        const params = CSVMultisigTapscript.decode(script).params;
        sequence = bip68.encode(
            params.timelock.type === "blocks"
                ? { blocks: Number(params.timelock.value) }
                : { seconds: Number(params.timelock.value) }
        );
    } catch {}

    return sequence;
}
