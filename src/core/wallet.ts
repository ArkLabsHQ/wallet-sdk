import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import * as btc from "@scure/btc-signer";

import type {
    Wallet as IWallet,
    WalletConfig,
    WalletBalance,
    SendBitcoinParams,
    AddressInfo,
    Coin,
    VirtualCoin,
    Identity,
    SettleParams,
    OffchainInfo,
    ForfeitVtxoInput,
} from "../types/wallet";
import { ESPLORA_URL, EsploraProvider } from "../providers/esplora";
import { ArkProvider } from "../providers/ark";
import { BIP21 } from "../utils/bip21";
import { ArkAddress } from "../core/address";
import { checkSequenceVerifyScript, VtxoTapscript } from "../core/tapscript";
import { selectCoins, selectVirtualCoins } from "../utils/coinselect";
import { getNetwork, Network, NetworkName } from "../types/networks";
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
    ArkInfo,
    FinalizationEvent,
    SettlementEventType,
    SigningNoncesGeneratedEvent,
    SigningStartEvent,
} from "../providers/base";
import { clearInterval, setInterval } from "timers";
import { TreeSignerSession } from "./signingSession";
import { buildForfeitTxs } from "./forfeit";
import { TxWeightEstimator } from "../utils/txSizeEstimator";

export class Wallet implements IWallet {
    private identity: Identity;
    private network: Network;
    private onchainProvider: EsploraProvider;
    private arkProvider?: ArkProvider;
    private unsubscribeEvents?: () => void;
    private onchainAddress: string;
    private offchainAddress?: OffchainInfo;
    private onchainP2TR: ReturnType<typeof btc.p2tr>;
    private offchainTapscript?: VtxoTapscript;

    public boardingAddress?: string;
    public boardingTapscript?: VtxoTapscript;

    static DUST_AMOUNT = BigInt(546); // Bitcoin dust limit in satoshis = 546
    static FEE_RATE = 1; // sats/vbyte

    constructor(config: WalletConfig) {
        this.identity = config.identity;
        this.network = getNetwork(config.network as NetworkName);
        this.onchainProvider = new EsploraProvider(
            config.esploraUrl || ESPLORA_URL[config.network as NetworkName]
        );

        // Derive onchain address
        const pubkey = this.identity.xOnlyPublicKey();
        if (!pubkey) {
            throw new Error("Invalid configured public key");
        }

        // Setup Ark provider and derive offchain address if configured
        if (config.arkServerUrl && config.arkServerPublicKey) {
            this.arkProvider = new ArkProvider(
                config.arkServerUrl,
                config.arkServerPublicKey
            );

            // Generate tapscripts for Offchain and Boarding address
            const serverPubKey = hex.decode(config.arkServerPublicKey);
            const bareVtxoTapscript = VtxoTapscript.createBareVtxo(
                pubkey,
                serverPubKey,
                this.network
            );
            const boardingTapscript = VtxoTapscript.createBoarding(
                pubkey,
                serverPubKey,
                this.network
            );
            // Save offchain and boarding address
            this.offchainAddress = {
                address: new ArkAddress(
                    serverPubKey,
                    bareVtxoTapscript.toP2TR().tweakedPubkey,
                    this.network
                ).encode(),
                scripts: {
                    exit: [hex.encode(bareVtxoTapscript.getExitScript())],
                    forfeit: [hex.encode(bareVtxoTapscript.getForfeitScript())],
                },
            };
            this.boardingAddress = boardingTapscript.toP2TR().address;
            // Save tapscripts
            this.offchainTapscript = bareVtxoTapscript;
            this.boardingTapscript = boardingTapscript;
        }

        // Save onchain Taproot address key-path only
        this.onchainP2TR = btc.p2tr(pubkey, undefined, this.network);
        this.onchainAddress = this.onchainP2TR.address!;
    }

    getAddress(): AddressInfo {
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
                address: this.onchainAddress,
                ark: this.offchainAddress.address,
            });
        }

        return addressInfo;
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
        const address = this.getAddress();
        return this.onchainProvider.getCoins(address.onchain);
    }

    async getForfeitVtxoInputs(): Promise<(ForfeitVtxoInput & VirtualCoin)[]> {
        if (!this.arkProvider) {
            return [];
        }

        // TODO: add caching logic to lower the number of requests to provider
        const address = this.getAddress();
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

    async getVirtualCoins(): Promise<VirtualCoin[]> {
        if (!this.arkProvider) {
            return [];
        }

        const address = this.getAddress();
        if (!address.offchain) {
            return [];
        }

        return this.arkProvider.getVirtualCoins(address.offchain.address);
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        if (params.amount <= 0) {
            throw new Error("Amount must be positive");
        }

        if (params.amount < Wallet.DUST_AMOUNT) {
            throw new Error("Amount is below dust limit");
        }

        // If Ark is configured and amount is suitable, send via offchain
        if (this.arkProvider && this.isOffchainSuitable(params)) {
            return this.sendOffchain(params);
        }

        // Otherwise, send via onchain
        return this.sendOnchain(params);
    }

    private isOffchainSuitable(params: SendBitcoinParams): boolean {
        // TODO: Add proper logic to determine if transaction is suitable for offchain
        // For now, just check if amount is greater than dust
        return params.amount > Wallet.DUST_AMOUNT;
    }

    async sendOnchain(params: SendBitcoinParams): Promise<string> {
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

    async sendOffchain(params: SendBitcoinParams): Promise<string> {
        if (
            !this.arkProvider ||
            !this.offchainAddress ||
            !this.offchainTapscript
        ) {
            throw new Error("Ark provider not configured");
        }

        const virtualCoins = await this.getVirtualCoins();
        const feeRate = params.feeRate || Wallet.FEE_RATE;

        // Ensure fee is an integer by rounding up
        const estimatedFee = Math.ceil(174 * feeRate);
        const totalNeeded = params.amount + estimatedFee;

        const selected = await selectVirtualCoins(virtualCoins, totalNeeded);

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
                        Buffer.concat([
                            selectedLeaf.script,
                            Buffer.from([TAP_LEAF_VERSION]),
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

    async settle(params: SettleParams): Promise<string> {
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        // generate a vtxo tree signing key
        const vtxoTreeSigningKey = secp256k1.utils.randomPrivateKey();
        const vtxoTreePublicKey = secp256k1.getPublicKey(vtxoTreeSigningKey);

        // register inputs
        const { requestId } =
            await this.arkProvider!.registerInputsForNextRound(
                params.inputs,
                hex.encode(vtxoTreePublicKey)
            );

        // register outputs
        await this.arkProvider!.registerOutputsForNextRound(
            requestId,
            params.outputs
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
                value: info.vtxoTreeExpiry || info.roundLifetime,
                type: "seconds",
            }, // TODO: remove roundLifetime
            hex.decode(info.pubkey).slice(1)
        );

        const sweepTapTreeRoot = tapLeafHash(sweepTapscript);

        for await (const event of settlementStream) {
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
        vtxoTree.validate(event.unsignedSettlementTx, sweepTapTreeRoot);

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

        signingSession.setKeys(event.cosignersPublicKeys.map(hex.decode));

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
        if (!this.arkProvider) {
            throw new Error("Ark provider not configured");
        }

        const connectors = event.connectors.map((connector) =>
            btc.Transaction.fromPSBT(base64.decode(connector))
        );

        const forfeitAddress = btc
            .Address(this.network)
            .decode(infos.forfeitAddress);
        const serverScript = btc.OutScript.encode(forfeitAddress);

        const vtxos = await this.getVirtualCoins();

        const signedForfeits: string[] = [];

        for (const input of inputs) {
            if (typeof input === "string") continue; // exclude notes

            const vtxo = vtxos.find(
                (vtxo) =>
                    vtxo.txid === input.outpoint.txid &&
                    vtxo.vout === input.outpoint.vout
            );
            if (!vtxo) {
                // TODO: handle boarding utxos, sign the settlement tx
                throw new Error("Vtxo not found");
            }

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
                this.network,
                true
            );

            if (!p2tr.leaves || !p2tr.tapLeafScript)
                throw new Error("invalid vtxo tapscripts");

            const tapLeafScriptIndex = p2tr.leaves?.findIndex(
                (leaf) => hex.encode(leaf.hash) === hex.encode(forfeitLeafHash)
            );
            if (tapLeafScriptIndex === -1 || tapLeafScriptIndex === undefined) {
                throw new Error(
                    "forfeit tapscript not found in vtxo tapscripts"
                );
            }

            const forfeitTapLeafScript = p2tr.tapLeafScript[tapLeafScriptIndex];
            const forfeitControlBlock = btc.TaprootControlBlock.encode(
                forfeitTapLeafScript[0]
            );

            const fees = TxWeightEstimator.create()
                .addP2PKHInput() // connector
                .addTapscriptInput(
                    64 * 2, // TODO: handle conditional script
                    forfeitTapLeafScript[1].length,
                    forfeitControlBlock.length
                )
                .addP2WKHOutput()
                .vsize()
                .fee(event.minRelayFeeRate);

            for (const connectorTx of connectors) {
                const forfeitTxs = buildForfeitTxs({
                    connectorTx,
                    connectorAmount: infos.dust,
                    feeAmount: fees,
                    serverScript,
                    vtxoAmount: BigInt(vtxo.value),
                    vtxoInput: input.outpoint,
                    vtxoScript: ArkAddress.fromTapscripts(
                        hex.decode(infos.pubkey),
                        input.tapscripts,
                        this.network
                    ).script,
                });

                for (const forfeitTx of forfeitTxs) {
                    // add the tapscript
                    forfeitTx.updateInput(1, {
                        tapLeafScript: [forfeitTapLeafScript],
                    });

                    forfeitTx.signIdx(
                        this.identity.privateKey(),
                        1,
                        undefined,
                        Buffer.alloc(32)
                    );

                    signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
                }
            }
        }

        await this.arkProvider.submitSignedForfeitTxs(signedForfeits);
    }

    async signMessage(message: string): Promise<string> {
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
