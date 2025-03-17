import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import * as btc from "@scure/btc-signer";
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment";
import { secp256k1 } from "@noble/curves/secp256k1";

import { BIP21 } from "../utils/bip21";
import { ArkAddress } from "../core/address";
import { checkSequenceVerifyScript, VtxoTapscript } from "../core/tapscript";
import { selectCoins, selectVirtualCoins } from "../utils/coinselect";
import { getNetwork, Network, NetworkName } from "./networks";
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
    Output,
    VtxoInput,
    RestArkProvider,
} from "../providers/ark";
import { TreeSignerSession } from "./signingSession";
import { buildForfeitTx } from "./forfeit";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { validateConnectorsTree, validateVtxoTree } from "./tree/validation";
import { TransactionOutput } from "@scure/btc-signer/psbt";
import { Identity } from "./identity";

const ZERO_32 = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export interface WalletConfig {
    network: NetworkName;
    identity: Identity;
    esploraUrl?: string;
    arkServerUrl?: string;
    arkServerPubKey?: string;
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

// SpendableVtxo embed the forfeit script to use as spending path for the boarding utxo or vtxo
export type SpendableVtxo = VtxoInput & {
    forfeitScript: string;
};

export interface SettleParams {
    inputs: (string | SpendableVtxo)[];
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
}

export interface IWallet {
    // Address and balance management
    getAddress(): Promise<AddressInfo>;
    getBalance(): Promise<WalletBalance>;
    getCoins(): Promise<Coin[]>;
    getVtxos(): Promise<(SpendableVtxo & VirtualCoin)[]>;
    getBoardingUtxos(): Promise<(SpendableVtxo & Coin)[]>;

    // Transaction operations
    sendBitcoin(params: SendBitcoinParams, zeroFee?: boolean): Promise<string>;
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;

    // Message signing and verification
    signMessage(message: string): Promise<string>;
    verifyMessage(
        message: string,
        signature: string,
        address: string
    ): Promise<boolean>;

    // Event handling
    subscribeToEvents(
        message: string,
        signature: string,
        address: string
    ): Promise<void>;
}

// Wallet does not store any data and rely on the Ark and onchain providers to fetch utxos and vtxos
export class Wallet implements IWallet {
    private unsubscribeEvents?: () => void;

    static DUST_AMOUNT = BigInt(546); // Bitcoin dust limit in satoshis = 546
    static FEE_RATE = 1; // sats/vbyte

    private constructor(
        private identity: Identity,
        private network: Network,
        private onchainProvider: OnchainProvider,
        private onchainP2TR: ReturnType<typeof btc.p2tr>,
        private arkProvider?: ArkProvider,
        private offchainAddress?: VtxoTaprootAddress,
        private boardingAddress?: VtxoTaprootAddress,
        private offchainTapscript?: VtxoTapscript
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
            let serverPubKeyHex = config.arkServerPubKey;
            if (!serverPubKeyHex) {
                const info = await arkProvider.getInfo();
                serverPubKeyHex = info.pubkey;
            }
            // Generate tapscripts for offchain and boarding address
            const serverPubKey = hex.decode(serverPubKeyHex).slice(1);
            const bareVtxoTapscript = VtxoTapscript.createBareVtxo(
                pubkey,
                serverPubKey,
                network
            );
            const boardingTapscript = VtxoTapscript.createBoarding(
                pubkey,
                serverPubKey,
                network
            );
            // Save offchain and boarding address
            const offchainAddress = {
                address: new ArkAddress(
                    serverPubKey,
                    bareVtxoTapscript.toP2TR().tweakedPubkey,
                    network
                ).encode(),
                scripts: {
                    exit: [hex.encode(bareVtxoTapscript.getExitScript())],
                    forfeit: [hex.encode(bareVtxoTapscript.getForfeitScript())],
                },
            };
            const boardingAddress = {
                address: boardingTapscript.toP2TR().address!,
                scripts: {
                    exit: [hex.encode(boardingTapscript.getExitScript())],
                    forfeit: [hex.encode(boardingTapscript.getForfeitScript())],
                },
            };
            // Save tapscripts
            const offchainTapscript = bareVtxoTapscript;

            return new Wallet(
                config.identity,
                network,
                onchainProvider,
                onchainP2TR,
                arkProvider,
                offchainAddress,
                boardingAddress,
                offchainTapscript
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

    getAddress(): Promise<AddressInfo> {
        const addressInfo: AddressInfo = {
            onchain: this.onchainAddress,
            bip21: BIP21.create({
                address: this.onchainAddress,
            }),
        };

        // Only include Ark-related fields if Ark provider is configured and address is available
        if (this.arkProvider && this.offchainAddress) {
            addressInfo.offchain = this.offchainAddress;
            addressInfo.bip21 = BIP21.create({
                address: this.onchainP2TR.address,
                ark: this.offchainAddress.address,
            });
            addressInfo.boarding = this.boardingAddress;
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
        if (!this.onchainProvider) {
            throw new Error("wallet not initialized");
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = await this.getAddress();
        return this.onchainProvider.getCoins(address.onchain);
    }

    async getVtxos(): Promise<(SpendableVtxo & VirtualCoin)[]> {
        if (!this.arkProvider) {
            return [];
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = await this.getAddress();
        if (!address.offchain) {
            return [];
        }

        const virtualCoins = await this.arkProvider.getVirtualCoins(
            address.offchain.address
        );
        return virtualCoins.map((vtxo) => ({
            ...vtxo,
            outpoint: {
                txid: vtxo.txid,
                vout: vtxo.vout,
            },
            forfeitScript: address.offchain!.scripts.forfeit[0],
            tapscripts: [
                ...address.offchain!.scripts.forfeit,
                ...address.offchain!.scripts.exit,
            ],
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

        return this.arkProvider.getVirtualCoins(address.offchain.address);
    }

    async getBoardingUtxos(): Promise<(SpendableVtxo & Coin)[]> {
        if (!this.onchainProvider) {
            return [];
        }

        if (!this.boardingAddress) {
            throw new Error("Boarding address not configured");
        }

        const boardingUtxos = await this.onchainProvider.getCoins(
            this.boardingAddress.address
        );

        return boardingUtxos.map((coin) => ({
            ...coin,
            outpoint: {
                txid: coin.txid,
                vout: coin.vout,
            },
            forfeitScript: this.boardingAddress!.scripts.forfeit[0],
            tapscripts: [
                ...this.boardingAddress!.scripts.forfeit,
                ...this.boardingAddress!.scripts.exit,
            ],
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
        if (this.arkProvider && this.isOffchainSuitable(params)) {
            return this.sendOffchain(params, zeroFee);
        }

        // Otherwise, send via onchain
        return this.sendOnchain(params);
    }

    private isOffchainSuitable(params: SendBitcoinParams): boolean {
        // TODO: Add proper logic to determine if transaction is suitable for offchain
        // For now, just check if amount is greater than dust
        return params.amount > Wallet.DUST_AMOUNT;
    }

    private async sendOnchain(params: SendBitcoinParams): Promise<string> {
        if (
            !this.onchainP2TR ||
            !this.onchainAddress ||
            !this.network ||
            !this.identity ||
            !this.onchainProvider
        ) {
            throw new Error("wallet not initialized");
        }

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
        const tx = new btc.Transaction();

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
        tx.sign(this.identity.privateKey());
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
            !this.offchainTapscript ||
            !this.identity
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

        const tx = new btc.Transaction({
            allowUnknownOutputs: true,
            disableScriptCheck: true,
            allowUnknownInputs: true,
        });

        // Add inputs with proper taproot script information
        for (const input of selected.inputs) {
            // Get the first leaf (multisig) since we're using the default tapscript
            const taprootPayment = this.offchainTapscript.toP2TR();
            const scriptHex = hex.encode(
                this.offchainTapscript.getForfeitScript()
            );
            const selectedLeaf = taprootPayment.leaves?.find(
                (l) => hex.encode(l.script) === scriptHex
            );
            if (!selectedLeaf) {
                throw new Error("Selected leaf not found");
            }

            // Add taproot input
            tx.addInput({
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    script: taprootPayment.script,
                    amount: BigInt(input.value),
                },
                tapInternalKey: undefined,
                tapLeafScript: [
                    [
                        {
                            version: TAP_LEAF_VERSION,
                            internalKey: btc.TAPROOT_UNSPENDABLE_KEY,
                            merklePath: selectedLeaf.path,
                        },
                        new Uint8Array([
                            ...selectedLeaf.script,
                            TAP_LEAF_VERSION,
                        ]),
                    ],
                ],
            });
        }

        // Add payment output
        const paymentAddress = ArkAddress.decode(params.address);
        tx.addOutput({
            script: new Uint8Array([
                0x51,
                0x20,
                ...paymentAddress.tweakedPubKey,
            ]),
            amount: BigInt(params.amount),
        });

        // Add change output if needed
        if (selected.changeAmount > 0) {
            tx.addOutput({
                script: this.offchainTapscript.toP2TR().script,
                amount: BigInt(selected.changeAmount),
            });
        }

        // Sign inputs
        tx.sign(this.identity.privateKey(), undefined, new Uint8Array(32));

        const psbt = tx.toPSBT();
        // Broadcast to Ark
        return this.arkProvider.submitVirtualTx(base64.encode(psbt));
    }

    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // generate a vtxo tree signing key
        const vtxoTreeSigningKey = secp256k1.utils.randomPrivateKey();
        const vtxoTreePublicKey = secp256k1.getPublicKey(vtxoTreeSigningKey);

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
                        address: this.offchainAddress.address,
                        amount: BigInt(amount),
                    },
                ],
            };

            console.log("Settling with params", params);
        }

        // register inputs
        const { requestId } =
            await this.arkProvider!.registerInputsForNextRound(params.inputs);

        // register outputs
        await this.arkProvider!.registerOutputsForNextRound(
            requestId,
            params.outputs,
            [hex.encode(vtxoTreePublicKey)]
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

        // the signing session holds the state of the musig2 signing process of the vtxo tree
        // it is created when the vtxo tree is received in Signing event
        let signingSession: TreeSignerSession | undefined;

        const info = await this.arkProvider.getInfo();

        const sweepTapscript = checkSequenceVerifyScript(
            {
                value: info.batchExpiry,
                type: info.batchExpiry >= 512n ? "seconds" : "blocks",
            },
            hex.decode(info.pubkey).slice(1)
        );

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
                    signingSession = await this.handleSettlementSigningEvent(
                        event,
                        sweepTapTreeRoot,
                        vtxoTreeSigningKey
                    );
                    break;
                // the musig2 nonces of the vtxo tree transactions are generated
                // the server expects now the partial musig2 signatures
                case SettlementEventType.SigningNoncesGenerated:
                    if (step !== SettlementEventType.SigningStart) {
                        continue;
                    }
                    stopPing();
                    if (!signingSession) {
                        throw new Error("Signing session not found");
                    }
                    await this.handleSettlementSigningNoncesGeneratedEvent(
                        event,
                        signingSession
                    );
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
        vtxoTreeSigningKey: Uint8Array
    ): Promise<TreeSignerSession> {
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

        const signingSession = new TreeSignerSession(
            vtxoTreeSigningKey,
            vtxoTree,
            sweepTapTreeRoot,
            sharedOutput.amount
        );

        await this.arkProvider.submitTreeNonces(
            event.id,
            hex.encode(signingSession.publicKey),
            signingSession.getNonces()
        );

        return signingSession;
    }

    private async handleSettlementSigningNoncesGeneratedEvent(
        event: SigningNoncesGeneratedEvent,
        signingSession: TreeSignerSession
    ) {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        signingSession.setAggregatedNonces(event.treeNonces);
        const signatures = signingSession.sign();

        await this.arkProvider.submitTreeSignatures(
            event.id,
            hex.encode(signingSession.publicKey),
            signatures
        );
    }

    private async handleSettlementFinalizationEvent(
        event: FinalizationEvent,
        inputs: SettleParams["inputs"],
        infos: ArkInfo
    ) {
        if (!this.arkProvider || !this.network || !this.identity) {
            throw new Error("wallet not initialized");
        }

        // parse the server forfeit address
        // server is expecting funds to be sent to this address
        const forfeitAddress = btc
            .Address(this.network)
            .decode(infos.forfeitAddress);
        const serverScript = btc.OutScript.encode(forfeitAddress);

        // the signed forfeits transactions to submit
        const signedForfeits: string[] = [];

        const vtxos = await this.getVirtualCoins();
        const settlementPsbt = btc.Transaction.fromPSBT(
            base64.decode(event.roundTx)
        );
        let hasBoardingUtxos = false;
        let connectorsTreeValid = false;

        for (const input of inputs) {
            if (typeof input === "string") continue; // skip notes

            // compute the tapLeafScript from the forfeit script
            const forfeitTapLeafScript = getTapLeafScript(input, this.network);

            // check if the input is an offchain "virtual" coin
            const vtxo = vtxos.find(
                (vtxo) =>
                    vtxo.txid === input.outpoint.txid &&
                    vtxo.vout === input.outpoint.vout
            );
            // boarding utxo, we need to sign the settlement tx
            if (!vtxo) {
                hasBoardingUtxos = true;

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
                    if (inputTxId !== input.outpoint.txid) continue;
                    if (settlementInput.index !== input.outpoint.vout) continue;

                    // input found in the settlement tx, sign it
                    settlementPsbt.updateInput(i, {
                        tapLeafScript: [forfeitTapLeafScript],
                    });
                    if (
                        !settlementPsbt.signIdx(
                            this.identity.privateKey(),
                            i,
                            undefined,
                            ZERO_32
                        )
                    ) {
                        throw new Error(
                            "Unable to sign the settlement transaction. Check your private key"
                        );
                    }
                }

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

            const fees = TxWeightEstimator.create()
                .addKeySpendInput() // connector
                .addTapscriptInput(
                    64 * 2, // TODO: handle conditional script
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

            const forfeitTx = buildForfeitTx({
                connectorInput: connectorOutpoint,
                connectorAmount: connectorOutput.amount,
                feeAmount: fees,
                serverScript,
                connectorScript: connectorOutput.script,
                vtxoAmount: BigInt(vtxo.value),
                vtxoInput: input.outpoint,
                vtxoScript: ArkAddress.fromTapscripts(
                    hex.decode(infos.pubkey),
                    input.tapscripts,
                    this.network
                ).script,
            });

            // add the tapscript
            forfeitTx.updateInput(1, {
                tapLeafScript: [forfeitTapLeafScript],
            });

            forfeitTx.signIdx(
                this.identity.privateKey(),
                1,
                undefined,
                ZERO_32
            );

            signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
        }

        await this.arkProvider.submitSignedForfeitTxs(
            signedForfeits,
            hasBoardingUtxos
                ? base64.encode(settlementPsbt.toPSBT())
                : undefined
        );
    }

    async signMessage(message: string): Promise<string> {
        if (!this.identity) {
            throw new Error("wallet not initialized");
        }
        const messageHash = sha256(new TextEncoder().encode(message));
        const signature = await this.identity.sign(messageHash);
        return hex.encode(signature);
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */
    async verifyMessage(
        _message: string,
        _signature: string,
        _address: string
    ): Promise<boolean> {
        throw new Error("Method not implemented.");
    }

    async subscribeToEvents(
        _message: string,
        _signature: string,
        _address: string
    ): Promise<void> {
        throw new Error("Method not implemented.");
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */

    dispose() {
        if (this.unsubscribeEvents) {
            this.unsubscribeEvents();
        }
    }
}

function getTapLeafScript(input: SpendableVtxo, network: Network) {
    const forfeitLeafHash = tapLeafHash(
        hex.decode(input.forfeitScript),
        TAP_LEAF_VERSION
    );
    const taprootTree = btc.taprootListToTree(
        input.tapscripts.map((script) => ({
            script: hex.decode(script),
        }))
    );
    const p2tr = btc.p2tr(
        btc.TAPROOT_UNSPENDABLE_KEY,
        taprootTree,
        network,
        true
    );
    if (!p2tr.leaves || !p2tr.tapLeafScript)
        throw new Error("invalid vtxo tapscripts");

    const tapLeafScriptIndex = p2tr.leaves?.findIndex(
        (leaf) => hex.encode(leaf.hash) === hex.encode(forfeitLeafHash)
    );
    if (tapLeafScriptIndex === -1 || tapLeafScriptIndex === undefined) {
        throw new Error("forfeit tapscript not found in vtxo tapscripts");
    }

    return p2tr.tapLeafScript[tapLeafScriptIndex];
}
