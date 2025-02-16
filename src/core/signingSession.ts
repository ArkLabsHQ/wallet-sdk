import * as musig2 from "../core/musig2";
import { getCosignerKeys, VtxoTree } from "./tree/vtxoTree";
import { Script, SigHash, Transaction } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

export const ErrMissingVtxoTree = new Error("missing vtxo tree");
export const ErrMissingAggregateKey = new Error("missing aggregate key");

export type TreeNonces = (Pick<musig2.Nonces, "pubNonce"> | null)[][];
export type TreePartialSigs = (musig2.PartialSig | null)[][];

// Signer session defines the methods to participate in a cooperative signing process
// with participants of a settlement. It holds the state of the musig2 nonces and allows to
// create the partial signatures for each transaction in the vtxo tree
export interface SignerSession {
    getNonces(): TreeNonces;
    setAggregatedNonces(nonces: TreeNonces): void;
    sign(): TreePartialSigs;
}

export class TreeSignerSession implements SignerSession {
    private myNonces: (musig2.Nonces | null)[][] | null = null;
    private aggregateNonces: TreeNonces | null = null;

    constructor(
        private secretKey: Uint8Array,
        private tree: VtxoTree,
        private scriptRoot: Uint8Array,
        private rootSharedOutputAmount: bigint
    ) {}

    get publicKey(): Uint8Array {
        return secp256k1.getPublicKey(this.secretKey);
    }

    getNonces(): TreeNonces {
        if (!this.tree) throw ErrMissingVtxoTree;

        if (!this.myNonces) {
            this.myNonces = this.generateNonces();
        }

        const nonces: TreeNonces = [];

        for (const levelNonces of this.myNonces) {
            const levelPubNonces: (Pick<musig2.Nonces, "pubNonce"> | null)[] =
                [];
            for (const nonce of levelNonces) {
                if (!nonce) {
                    levelPubNonces.push(null);
                    continue;
                }
                levelPubNonces.push({ pubNonce: nonce.pubNonce });
            }
            nonces.push(levelPubNonces);
        }

        return nonces;
    }

    setAggregatedNonces(nonces: TreeNonces) {
        if (this.aggregateNonces) throw new Error("nonces already set");
        this.aggregateNonces = nonces;
    }

    sign(): TreePartialSigs {
        if (!this.tree) throw ErrMissingVtxoTree;
        if (!this.aggregateNonces) throw new Error("nonces not set");
        if (!this.myNonces) throw new Error("nonces not generated");

        const sigs: TreePartialSigs = [];

        for (
            let levelIndex = 0;
            levelIndex < this.tree.levels.length;
            levelIndex++
        ) {
            const levelSigs: (musig2.PartialSig | null)[] = [];
            const level = this.tree.levels[levelIndex];

            for (let nodeIndex = 0; nodeIndex < level.length; nodeIndex++) {
                const node = level[nodeIndex];
                const tx = Transaction.fromPSBT(base64.decode(node.tx));
                const sig = this.signPartial(tx, levelIndex, nodeIndex);
                if (sig) {
                    levelSigs.push(sig);
                } else {
                    levelSigs.push(null);
                }
            }

            sigs.push(levelSigs);
        }

        return sigs;
    }

    private generateNonces(): musig2.Nonces[][] {
        if (!this.tree) throw ErrMissingVtxoTree;

        const myNonces: musig2.Nonces[][] = [];

        const publicKey = secp256k1.getPublicKey(this.secretKey);

        for (const level of this.tree.levels) {
            const levelNonces: musig2.Nonces[] = [];
            for (let i = 0; i < level.length; i++) {
                const nonces = musig2.generateNonces(publicKey);
                levelNonces.push(nonces);
            }
            myNonces.push(levelNonces);
        }

        return myNonces;
    }

    private signPartial(
        tx: Transaction,
        levelIndex: number,
        nodeIndex: number
    ): musig2.PartialSig | null {
        if (!this.myNonces || !this.aggregateNonces) {
            throw new Error("session not properly initialized");
        }

        const myNonce = this.myNonces[levelIndex][nodeIndex];
        if (!myNonce) return null;

        const aggNonce = this.aggregateNonces[levelIndex][nodeIndex];
        if (!aggNonce) throw new Error("missing aggregate nonce");
        const prevoutAmounts: bigint[] = [];
        const prevoutScripts: Uint8Array[] = [];

        const cosigners = getCosignerKeys(tx);

        const { finalKey } = musig2.aggregateKeys(cosigners, true, {
            taprootTweak: this.scriptRoot,
        });

        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const prevout = getPrevOutput(
                finalKey,
                this.tree,
                this.rootSharedOutputAmount,
                tx
            );
            prevoutAmounts.push(prevout.amount);
            prevoutScripts.push(prevout.script);
        }

        const message = tx.preimageWitnessV1(
            0, // always first input
            prevoutScripts,
            SigHash.DEFAULT,
            prevoutAmounts
        );

        return musig2.sign(
            myNonce.secNonce,
            myNonce.pubNonce,
            this.secretKey,
            aggNonce.pubNonce,
            cosigners,
            message,
            {
                taprootTweak: this.scriptRoot,
                sortKeys: true,
            }
        );
    }
}

// Helper function to validate tree signatures
export async function validateTreeSigs(
    finalAggregatedKey: Uint8Array,
    sharedOutputAmount: bigint,
    vtxoTree: VtxoTree
): Promise<void> {
    // Iterate through each level of the tree
    for (const level of vtxoTree.levels) {
        for (const node of level) {
            // Parse the transaction
            const tx = Transaction.fromPSBT(base64.decode(node.tx));
            const input = tx.getInput(0);

            // Check if input has signature
            if (!input.tapKeySig) {
                throw new Error("unsigned tree input");
            }

            // Get the previous output information
            const prevout = getPrevOutput(
                finalAggregatedKey,
                vtxoTree,
                sharedOutputAmount,
                tx
            );

            // Calculate the message that was signed
            const message = tx.preimageWitnessV1(
                0, // always first input
                [prevout.script],
                SigHash.DEFAULT,
                [prevout.amount]
            );

            // Verify the signature
            const isValid = schnorr.verify(
                input.tapKeySig,
                message,
                finalAggregatedKey
            );

            if (!isValid) {
                throw new Error("invalid signature");
            }
        }
    }
}

interface PrevOutput {
    script: Uint8Array;
    amount: bigint;
}

function getPrevOutput(
    finalKey: Uint8Array,
    vtxoTree: VtxoTree,
    sharedOutputAmount: bigint,
    partial: Transaction
): PrevOutput {
    // Generate P2TR script
    const pkScript = Script.encode(["OP_1", finalKey.slice(1)]);
    // Get root node
    const rootNode = vtxoTree.levels[0][0];
    if (!rootNode) throw new Error("empty vtxo tree");

    const input = partial.getInput(0);
    if (!input.txid) throw new Error("missing input txid");

    const parentTxID = hex.encode(input.txid);

    // Check if parent is root
    if (rootNode.parentTxid === parentTxID) {
        return {
            amount: sharedOutputAmount,
            script: pkScript,
        };
    }

    // Search for parent in tree
    let parent = null;
    for (const level of vtxoTree.levels) {
        for (const node of level) {
            if (node.txid === parentTxID) {
                parent = node;
                break;
            }
        }
        if (parent) break;
    }

    if (!parent) {
        throw new Error("parent tx not found");
    }

    // Parse parent tx
    const parentTx = Transaction.fromPSBT(base64.decode(parent.tx));

    if (!input.index) throw new Error("missing input index");
    const parentOutput = parentTx.getOutput(input.index);
    if (!parentOutput) throw new Error("parent output not found");
    if (!parentOutput.amount) throw new Error("parent output amount not found");

    return {
        amount: parentOutput.amount,
        script: pkScript,
    };
}
