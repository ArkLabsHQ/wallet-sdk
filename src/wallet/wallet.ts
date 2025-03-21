import { base64, hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import {
    TAP_LEAF_VERSION,
    tapLeafHash,
    TaprootLeaf,
} from "@scure/btc-signer/payment";
import { TransactionOutput } from "@scure/btc-signer/psbt";
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
    ArkInfo,
    FinalizationEvent,
    SettlementEvent,
    SettlementEventType,
    SigningNoncesGeneratedEvent,
    SigningStartEvent,
    ArkProvider,
    RestArkProvider,
} from "../providers/ark";
import { SignerSession } from "../tree/signingSession";
import { buildForfeitTx } from "../forfeit";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { validateConnectorsTree, validateVtxoTree } from "../tree/validation";
import { Identity } from "../identity";
import {
    AddressInfo,
    ArkTransaction,
    Coin,
    IWallet,
    SendBitcoinParams,
    SettleParams,
    TxType,
    VirtualCoin,
    WalletBalance,
    WalletConfig,
} from ".";
import { Bytes } from "@scure/btc-signer/utils";
import { EncodedVtxoScript, VtxoScript } from "../script/base";
import { CSVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import { makeVirtualTx } from "../utils/psbt";

// Wallet does not store any data and rely on the Ark and onchain providers to fetch utxos and vtxos
export class Wallet implements IWallet {
    // TODO get dust from ark server?
    static DUST_AMOUNT = BigInt(546); // Bitcoin dust limit in satoshis = 546
    static FEE_RATE = 1; // sats/vbyte

    private constructor(
        private identity: Identity,
        private network: Network,
        private onchainProvider: OnchainProvider,
        private onchainP2TR: ReturnType<typeof btc.p2tr>,
        private arkProvider?: ArkProvider,
        private arkServerPublicKey?: Bytes,
        private offchainTapscript?: DefaultVtxo.Script,
        private boardingTapscript?: DefaultVtxo.Script
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

        // Save onchain Taproot address key-path only
        const onchainP2TR = btc.p2tr(pubkey, undefined, network);

        if (arkProvider) {
            let serverPubKeyHex = config.arkServerPublicKey;
            let boardingTimelock = config.boardingTimelock;
            if (!serverPubKeyHex || !boardingTimelock) {
                const info = await arkProvider.getInfo();
                serverPubKeyHex = info.pubkey;
                boardingTimelock = {
                    value: info.unilateralExitDelay,
                    type: info.unilateralExitDelay < 512 ? "blocks" : "seconds",
                };
            }
            // Generate tapscripts for offchain and boarding address
            const serverPubKey = hex.decode(serverPubKeyHex).slice(1);
            const bareVtxoTapscript = new DefaultVtxo.Script({
                pubKey: pubkey,
                serverPubKey,
                csvTimelock: boardingTimelock,
            });
            const boardingTapscript = new DefaultVtxo.Script({
                pubKey: pubkey,
                serverPubKey,
                csvTimelock: boardingTimelock,
            });

            // Save tapscripts
            const offchainTapscript = bareVtxoTapscript;

            return new Wallet(
                config.identity,
                network,
                onchainProvider,
                onchainP2TR,
                arkProvider,
                serverPubKey,
                offchainTapscript,
                boardingTapscript
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
            this.network.ark,
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
            this.network.ark,
            this.arkServerPublicKey
        );
    }

    getAddress(): Promise<AddressInfo> {
        const addressInfo: AddressInfo = {
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
            const encodedOffchainAddress = this.offchainAddress.encode();
            addressInfo.offchain = {
                address: encodedOffchainAddress,
                scripts: {
                    exit: [this.offchainTapscript.exitScript],
                    forfeit: [this.offchainTapscript.forfeitScript],
                },
            };
            addressInfo.bip21 = BIP21.create({
                address: this.onchainP2TR.address,
                ark: encodedOffchainAddress,
            });
            addressInfo.boarding = {
                address: this.boardingOnchainAddress,
                scripts: {
                    exit: [this.boardingTapscript.exitScript],
                    forfeit: [this.boardingTapscript.forfeitScript],
                },
            };
        }

        return Promise.resolve(addressInfo);
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

        // Get offchain coins if Ark provider is configured
        let offchainSettled = 0;
        let offchainPending = 0;
        let offchainSwept = 0;
        if (this.arkProvider) {
            const vtxos = await this.getVirtualCoins();
            offchainSettled = vtxos
                .filter((coin) => coin.virtualStatus.state === "settled")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainPending = vtxos
                .filter((coin) => coin.virtualStatus.state === "pending")
                .reduce((sum, coin) => sum + coin.value, 0);
            offchainSwept = vtxos
                .filter((coin) => coin.virtualStatus.state === "swept")
                .reduce((sum, coin) => sum + coin.value, 0);
        }
        const offchainTotal = offchainSettled + offchainPending;

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

    async getVtxos(): Promise<
        (TaprootLeaf & EncodedVtxoScript & VirtualCoin)[]
    > {
        if (!this.arkProvider || !this.offchainTapscript) {
            return [];
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = await this.getAddress();
        if (!address.offchain) {
            return [];
        }

        const { spendableVtxos } = await this.arkProvider.getVirtualCoins(
            address.offchain.address
        );

        const encodedOffchainTapscript = this.offchainTapscript.encode();
        const forfeit = this.offchainTapscript.forfeit();

        return spendableVtxos.map((vtxo) => ({
            ...vtxo,
            ...forfeit,
            scripts: encodedOffchainTapscript,
        }));
    }

    private async getVirtualCoins(): Promise<VirtualCoin[]> {
        if (!this.arkProvider) {
            return [];
        }

        const address = await this.getAddress();
        if (!address.offchain) {
            return [];
        }

        return this.arkProvider
            .getVirtualCoins(address.offchain.address)
            .then(({ spendableVtxos }) => spendableVtxos);
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        if (!this.arkProvider) {
            return [];
        }

        const { spendableVtxos, spentVtxos } =
            await this.arkProvider.getVirtualCoins(
                this.offchainAddress.encode()
            );
        const { boardingTxs, roundsToIgnore } = await this.getBoardingTxs();

        // convert VTXOs to offchain transactions
        const offchainTxs = vtxosToTxs(
            spendableVtxos,
            spentVtxos,
            roundsToIgnore
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

    private async getBoardingTxs(): Promise<{
        boardingTxs: ArkTransaction[];
        roundsToIgnore: Set<string>;
    }> {
        if (!this.boardingAddress) {
            return { boardingTxs: [], roundsToIgnore: new Set() };
        }

        const boardingAddress = this.boardingOnchainAddress;
        const txs = await this.onchainProvider.getTransactions(boardingAddress);
        const utxos: VirtualCoin[] = [];
        const roundsToIgnore = new Set<string>();

        for (const tx of txs) {
            for (let i = 0; i < tx.vout.length; i++) {
                const vout = tx.vout[i];
                if (vout.scriptpubkey_address === boardingAddress) {
                    const spentStatuses =
                        await this.onchainProvider.getTxOutspends(tx.txid);
                    const spentStatus = spentStatuses[i];

                    if (spentStatus?.spent) {
                        roundsToIgnore.add(spentStatus.txid);
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
                            state: spentStatus?.spent ? "swept" : "pending",
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
                    roundTxid: "",
                    redeemTxid: "",
                },
                amount: utxo.value,
                type: TxType.TxReceived,
                settled: utxo.virtualStatus.state === "swept",
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
            roundsToIgnore,
        };
    }

    async getBoardingUtxos(): Promise<
        (TaprootLeaf & EncodedVtxoScript & Coin)[]
    > {
        if (!this.boardingAddress || !this.boardingTapscript) {
            throw new Error("Boarding address not configured");
        }

        const boardingUtxos = await this.onchainProvider.getCoins(
            this.boardingOnchainAddress
        );

        const encodedBoardingTapscript = this.boardingTapscript.encode();
        const forfeit = this.boardingTapscript.forfeit();

        return boardingUtxos.map((utxo) => ({
            ...utxo,
            ...forfeit,
            scripts: encodedBoardingTapscript,
        }));
    }

    async sendBitcoin(
        params: SendBitcoinParams,
        zeroFee: boolean = true
    ): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (params.amount < Wallet.DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        // If Ark is configured and amount is suitable, send via offchain
        if (this.arkProvider && this.isOffchainSuitable(params.address)) {
            return this.sendOffchain(params, zeroFee);
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
        let tx = new btc.Transaction();

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
                tapMerkleRoot: this.onchainP2TR.tapMerkleRoot,
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

    private async sendOffchain(
        params: SendBitcoinParams,
        zeroFee: boolean = true
    ): Promise<string> {
        if (
            !this.arkProvider ||
            !this.offchainAddress ||
            !this.offchainTapscript
        ) {
            throw new Error("wallet not initialized");
        }

        const virtualCoins = await this.getVirtualCoins();

        const estimatedFee = zeroFee
            ? 0
            : Math.ceil(174 * (params.feeRate || Wallet.FEE_RATE));
        const totalNeeded = params.amount + estimatedFee;

        const selected = selectVirtualCoins(virtualCoins, totalNeeded);

        if (!selected || !selected.inputs) {
            throw new Error("Insufficient funds");
        }

        const selectedLeaf = this.offchainTapscript.forfeit();
        if (!selectedLeaf) {
            throw new Error("Selected leaf not found");
        }

        const outputs = [
            {
                address: params.address,
                amount: BigInt(params.amount),
            },
        ];

        // add change output if needed
        if (selected.changeAmount > 0) {
            outputs.push({
                address: this.offchainAddress.encode(),
                amount: BigInt(selected.changeAmount),
            });
        }

        let tx = makeVirtualTx(
            selected.inputs.map((input) => ({
                ...input,
                ...selectedLeaf,
                scripts: this.offchainTapscript!.encode(),
            })),
            outputs
        );

        tx = await this.identity.sign(tx);
        const psbt = base64.encode(tx.toPSBT());

        return this.arkProvider.submitVirtualTx(psbt);
    }

    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
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
            const boardingUtxosInputs = boardingUtxos.map((utxo) => ({
                ...utxo,
                ...this.boardingTapscript!.forfeit(),
            }));

            const vtxos = await this.getVtxos();
            amount += vtxos.reduce((sum, input) => sum + input.value, 0);
            const vtxosInputs = vtxos.map((utxo) => ({
                ...utxo,
                ...this.offchainTapscript!.forfeit(),
            }));

            const inputs = [...boardingUtxosInputs, ...vtxosInputs];

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

        // register inputs
        const { requestId } = await this.arkProvider.registerInputsForNextRound(
            params.inputs.map((input) => {
                if (typeof input === "string") {
                    return input;
                }
                return {
                    outpoint: input,
                    tapscripts: input.scripts,
                };
            })
        );

        const hasOffchainOutputs = params.outputs.some((output) =>
            this.isOffchainSuitable(output.address)
        );

        // session holds the state of the musig2 signing process of the vtxo tree
        let session: SignerSession | undefined;
        const signingPublicKeys: string[] = [];
        if (hasOffchainOutputs) {
            session = this.identity.signerSession();
            signingPublicKeys.push(hex.encode(session.getPublicKey()));
        }

        // register outputs
        await this.arkProvider.registerOutputsForNextRound(
            requestId,
            params.outputs,
            signingPublicKeys
        );

        // start pinging every seconds
        const interval = setInterval(() => {
            this.arkProvider?.ping(requestId).catch(stopPing);
        }, 1000);
        let pingRunning = true;
        const stopPing = () => {
            if (pingRunning) {
                pingRunning = false;
                clearInterval(interval);
            }
        };

        // listen to settlement events
        const settlementStream = this.arkProvider.getEventStream();
        let step: SettlementEventType | undefined;
        if (!hasOffchainOutputs) {
            // if there are no offchain outputs, we don't have to handle musig2 tree signatures
            // we can directly advance to the finalization step
            step = SettlementEventType.SigningNoncesGenerated;
        }

        const info = await this.arkProvider.getInfo();

        const sweepTapscript = CSVMultisigTapscript.encode({
            timelock: {
                value: info.batchExpiry,
                type: info.batchExpiry >= 512n ? "seconds" : "blocks",
            },
            pubkeys: [hex.decode(info.pubkey).slice(1)],
        }).script;

        const sweepTapTreeRoot = tapLeafHash(sweepTapscript);

        for await (const event of settlementStream) {
            if (eventCallback) {
                eventCallback(event);
            }
            switch (event.type) {
                // the settlement failed
                case SettlementEventType.Failed:
                    if (step === undefined) {
                        continue;
                    }
                    stopPing();
                    throw new Error(event.reason);
                // the server has started the signing process of the vtxo tree transactions
                // the server expects the partial musig2 nonces for each tx
                case SettlementEventType.SigningStart:
                    if (step !== undefined) {
                        continue;
                    }
                    stopPing();
                    if (hasOffchainOutputs) {
                        if (!session) {
                            throw new Error("Signing session not found");
                        }
                        await this.handleSettlementSigningEvent(
                            event,
                            sweepTapTreeRoot,
                            session
                        );
                    }
                    break;
                // the musig2 nonces of the vtxo tree transactions are generated
                // the server expects now the partial musig2 signatures
                case SettlementEventType.SigningNoncesGenerated:
                    if (step !== SettlementEventType.SigningStart) {
                        continue;
                    }
                    stopPing();
                    if (hasOffchainOutputs) {
                        if (!session) {
                            throw new Error("Signing session not found");
                        }
                        await this.handleSettlementSigningNoncesGeneratedEvent(
                            event,
                            session
                        );
                    }
                    break;
                // the vtxo tree is signed, craft, sign and submit forfeit transactions
                // if any boarding utxos are involved, the settlement tx is also signed
                case SettlementEventType.Finalization:
                    if (step !== SettlementEventType.SigningNoncesGenerated) {
                        continue;
                    }
                    stopPing();
                    await this.handleSettlementFinalizationEvent(
                        event,
                        params.inputs,
                        info
                    );
                    break;
                // the settlement is done, last event to be received
                case SettlementEventType.Finalized:
                    if (step !== SettlementEventType.Finalization) {
                        continue;
                    }
                    return event.roundTxid;
            }

            step = event.type;
        }

        throw new Error("Settlement failed");
    }

    // validates the vtxo tree, creates a signing session and generates the musig2 nonces
    private async handleSettlementSigningEvent(
        event: SigningStartEvent,
        sweepTapTreeRoot: Uint8Array,
        session: SignerSession
    ) {
        const vtxoTree = event.unsignedVtxoTree;
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // validate the unsigned vtxo tree
        validateVtxoTree(
            event.unsignedSettlementTx,
            vtxoTree,
            sweepTapTreeRoot
        );

        // TODO check if our registered outputs are in the vtxo tree

        const settlementPsbt = base64.decode(event.unsignedSettlementTx);
        const settlementTx = btc.Transaction.fromPSBT(settlementPsbt);
        const sharedOutput = settlementTx.getOutput(0);
        if (!sharedOutput?.amount) {
            throw new Error("Shared output not found");
        }

        session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

        await this.arkProvider.submitTreeNonces(
            event.id,
            hex.encode(session.getPublicKey()),
            session.getNonces()
        );
    }

    private async handleSettlementSigningNoncesGeneratedEvent(
        event: SigningNoncesGeneratedEvent,
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
        event: FinalizationEvent,
        inputs: SettleParams["inputs"],
        infos: ArkInfo
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // parse the server forfeit address
        // server is expecting funds to be sent to this address
        const forfeitAddress = btc
            .Address(this.network)
            .decode(infos.forfeitAddress);
        const serverPkScript = btc.OutScript.encode(forfeitAddress);

        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const vtxos = await this.getVirtualCoins();
        let settlementPsbt = btc.Transaction.fromPSBT(
            base64.decode(event.roundTx)
        );
        let hasBoardingUtxos = false;
        let connectorsTreeValid = false;

        for (const input of inputs) {
            if (typeof input === "string") continue; // skip notes

            // check if the input is an offchain "virtual" coin
            const vtxo = vtxos.find(
                (vtxo) => vtxo.txid === input.txid && vtxo.vout === input.vout
            );
            const forfeitTapLeafScript: [any, any] = [
                {
                    version: TAP_LEAF_VERSION,
                    internalKey: btc.TAPROOT_UNSPENDABLE_KEY,
                    merklePath: input.path,
                },
                new Uint8Array([...input.script, TAP_LEAF_VERSION]),
            ];

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
                        tapLeafScript: [forfeitTapLeafScript],
                    });
                    inputIndexes.push(i);
                }
                settlementPsbt = await this.identity.sign(
                    settlementPsbt,
                    inputIndexes
                );

                continue;
            }

            if (!connectorsTreeValid) {
                // validate that the connectors tree is valid and contains our expected connectors
                validateConnectorsTree(event.roundTx, event.connectors);
                connectorsTreeValid = true;
            }

            const forfeitControlBlock = btc.TaprootControlBlock.encode(
                forfeitTapLeafScript[0]
            );

            const tapscript = decodeTapscript(input.script);

            const fees = TxWeightEstimator.create()
                .addKeySpendInput() // connector
                .addTapscriptInput(
                    tapscript.witnessSize(100), // TODO: handle conditional script
                    forfeitTapLeafScript[1].length,
                    forfeitControlBlock.length
                )
                .addP2WKHOutput()
                .vsize()
                .fee(event.minRelayFeeRate);

            const connectorsLeaves = event.connectors.leaves();
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
                        const connectorTx = btc.Transaction.fromPSBT(
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
                feeAmount: fees,
                serverPkScript,
                connectorPkScript: connectorOutput.script,
                vtxoAmount: BigInt(vtxo.value),
                vtxoInput: input,
                vtxoPkScript: VtxoScript.decode(input.scripts).pkScript,
            });

            // add the tapscript
            forfeitTx.updateInput(1, {
                tapLeafScript: [forfeitTapLeafScript],
            });

            // do not sign the connector input
            forfeitTx = await this.identity.sign(forfeitTx, [1]);

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        await this.arkProvider.submitSignedForfeitTxs(
            signedForfeits,
            hasBoardingUtxos
                ? base64.encode(settlementPsbt.toPSBT())
                : undefined
        );
    }
}
