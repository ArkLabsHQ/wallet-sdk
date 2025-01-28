import { Transaction } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { sha256x2 } from "@scure/btc-signer/utils";
import { aggregateKeys } from "../musig2";

// Node represents a transaction and its parent txid in a vtxo tree
export interface TreeNode {
    txid: string;
    tx: string;
    parentTxid: string;
    leaf: boolean;
}

export class VtxoTreeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VtxoTreeError";
    }
}

export const ErrParentNotFound = new VtxoTreeError("parent not found");
export const ErrLeafNotFound = new VtxoTreeError("leaf not found in vtxo tree");
export const ErrInvalidSettlementTx = new VtxoTreeError(
    "invalid settlement transaction"
);
export const ErrInvalidSettlementTxOutputs = new VtxoTreeError(
    "invalid settlement transaction outputs"
);
export const ErrEmptyTree = new VtxoTreeError("empty tree");
export const ErrInvalidRootLevel = new VtxoTreeError("invalid root level");
export const ErrNumberOfInputs = new VtxoTreeError("invalid number of inputs");
export const ErrWrongSettlementTxid = new VtxoTreeError(
    "wrong settlement txid"
);
export const ErrInvalidAmount = new VtxoTreeError("invalid amount");
export const ErrNoLeaves = new VtxoTreeError("no leaves");
export const ErrNodeTxEmpty = new VtxoTreeError("node transaction empty");
export const ErrNodeTxidEmpty = new VtxoTreeError("node txid empty");
export const ErrNodeParentTxidEmpty = new VtxoTreeError(
    "node parent txid empty"
);
export const ErrNodeTxidDifferent = new VtxoTreeError("node txid different");
export const ErrNumberOfTapscripts = new VtxoTreeError(
    "invalid number of tapscripts"
);
export const ErrParentTxidInput = new VtxoTreeError(
    "parent txid input mismatch"
);
export const ErrLeafChildren = new VtxoTreeError("leaf node has children");
export const ErrInvalidTaprootScript = new VtxoTreeError(
    "invalid taproot script"
);
export const ErrInternalKey = new VtxoTreeError("invalid internal key");
export const ErrInvalidControlBlock = new VtxoTreeError(
    "invalid control block"
);
export const ErrInvalidRootTransaction = new VtxoTreeError(
    "invalid root transaction"
);
export const ErrInvalidNodeTransaction = new VtxoTreeError(
    "invalid node transaction"
);

// VtxoTree is represented as a matrix of Node objects
// the first level of the matrix is the root of the tree
export class VtxoTree {
    // SHARED_OUTPUT_INDEX is the index of the shared output in a settlement transaction
    static SHARED_OUTPUT_INDEX = 0;
    private tree: TreeNode[][];

    constructor(tree: TreeNode[][]) {
        this.tree = tree;
    }

    get levels(): TreeNode[][] {
        return this.tree;
    }

    validate(settlementTx: string, sweepTapTreeRoot: Uint8Array): void {
        // Parse settlement transaction
        let settlementTransaction: Transaction;
        try {
            settlementTransaction = Transaction.fromPSBT(
                base64.decode(settlementTx)
            );
        } catch {
            throw ErrInvalidSettlementTx;
        }

        if (
            settlementTransaction.outputsLength <= VtxoTree.SHARED_OUTPUT_INDEX
        ) {
            throw ErrInvalidSettlementTxOutputs;
        }

        const sharedOutput = settlementTransaction.getOutput(
            VtxoTree.SHARED_OUTPUT_INDEX
        );
        if (!sharedOutput?.amount) throw ErrInvalidSettlementTxOutputs;
        const sharedOutputAmount = sharedOutput.amount;

        const nbNodes = this.numberOfNodes();
        if (nbNodes === 0) {
            throw ErrEmptyTree;
        }

        if (this.levels[0].length !== 1) {
            throw ErrInvalidRootLevel;
        }

        // Check root input is connected to settlement tx
        const rootNode = this.levels[0][0];
        let rootTx: Transaction;
        try {
            rootTx = Transaction.fromPSBT(base64.decode(rootNode.tx));
        } catch {
            throw ErrInvalidRootTransaction;
        }

        if (rootTx.inputsLength !== 1) {
            throw ErrNumberOfInputs;
        }

        const rootInput = rootTx.getInput(0);
        if (!rootInput.txid || rootInput.index === undefined)
            throw ErrWrongSettlementTxid;

        const settlementTxid = hex.encode(
            sha256x2(settlementTransaction.toBytes(true)).reverse()
        );
        if (
            hex.encode(Buffer.from(rootInput.txid)) !== settlementTxid ||
            rootInput.index !== VtxoTree.SHARED_OUTPUT_INDEX
        ) {
            throw ErrWrongSettlementTxid;
        }

        // Check root output amounts
        let sumRootValue = 0n;
        for (let i = 0; i < rootTx.outputsLength; i++) {
            const output = rootTx.getOutput(i);
            if (!output?.amount) continue;
            sumRootValue += output.amount;
        }

        if (sumRootValue >= sharedOutputAmount) {
            throw ErrInvalidAmount;
        }

        if (this.leaves().length === 0) {
            throw ErrNoLeaves;
        }

        // Validate each node in the tree
        for (const level of this.levels) {
            for (const node of level) {
                this.validateNode(node, sweepTapTreeRoot);
            }
        }
    }

    private validateNode(node: TreeNode, tapTreeRoot: Uint8Array): void {
        if (!node.tx) throw ErrNodeTxEmpty;
        if (!node.txid) throw ErrNodeTxidEmpty;
        if (!node.parentTxid) throw ErrNodeParentTxidEmpty;

        // Parse node transaction
        let tx: Transaction;
        try {
            tx = Transaction.fromPSBT(base64.decode(node.tx));
        } catch {
            throw ErrInvalidNodeTransaction;
        }

        const txid = hex.encode(sha256x2(tx.toBytes(true)).reverse());
        if (txid !== node.txid) {
            throw ErrNodeTxidDifferent;
        }

        if (tx.inputsLength !== 1) {
            throw ErrNumberOfInputs;
        }

        const input = tx.getInput(0);
        if (!input.tapInternalKey || !input.tapLeafScript?.[0]) {
            throw ErrNumberOfTapscripts;
        }

        // Get cosigner keys from input
        const cosignerKeys = getCosignerKeys(tx);

        const { preTweakedKey } = aggregateKeys(cosignerKeys, true, {
            taprootTweak: tapTreeRoot,
        });

        if (
            hex.encode(input.tapInternalKey) !==
            hex.encode(preTweakedKey.slice(1))
        ) {
            throw ErrInternalKey;
        }

        if (!input.txid) throw ErrParentTxidInput;
        if (hex.encode(input.txid) !== node.parentTxid) {
            throw ErrParentTxidInput;
        }

        const children = this.children(node.txid);
        if (node.leaf && children.length >= 1) {
            throw ErrLeafChildren;
        }

        // Validate each child
        for (let childIndex = 0; childIndex < children.length; childIndex++) {
            const child = children[childIndex];
            const childTx = Transaction.fromPSBT(base64.decode(child.tx));

            const parentOutput = tx.getOutput(childIndex);
            if (!parentOutput?.script) throw ErrInvalidTaprootScript;

            const previousScriptKey = parentOutput.script.slice(2);
            if (previousScriptKey.length !== 32) {
                throw ErrInvalidTaprootScript;
            }

            // Get cosigner keys from input
            const cosignerKeys = getCosignerKeys(childTx);

            // Aggregate keys
            const { preTweakedKey } = aggregateKeys(cosignerKeys, true, {
                taprootTweak: tapTreeRoot,
            });

            if (
                hex.encode(input.tapInternalKey) !==
                hex.encode(preTweakedKey.slice(1))
            ) {
                throw ErrInternalKey;
            }

            // Check amounts
            let sumChildAmount = 0n;
            for (let i = 0; i < childTx.outputsLength; i++) {
                const output = childTx.getOutput(i);
                if (!output?.amount) continue;
                sumChildAmount += output.amount;
            }

            if (!parentOutput.amount) throw ErrInvalidAmount;
            if (sumChildAmount >= parentOutput.amount) {
                throw ErrInvalidAmount;
            }
        }
    }

    // Returns the root node of the vtxo tree
    root(): TreeNode {
        if (this.tree.length <= 0 || this.tree[0].length <= 0) {
            throw new VtxoTreeError("empty vtxo tree");
        }
        return this.tree[0][0];
    }

    // Returns the leaves of the vtxo tree
    leaves(): TreeNode[] {
        const leaves = [...this.tree[this.tree.length - 1]];

        // Check other levels for leaf nodes
        for (let i = 0; i < this.tree.length - 1; i++) {
            for (const node of this.tree[i]) {
                if (node.leaf) {
                    leaves.push(node);
                }
            }
        }

        return leaves;
    }

    // Returns all nodes that have the given node as parent
    children(nodeTxid: string): TreeNode[] {
        const children: TreeNode[] = [];

        for (const level of this.tree) {
            for (const node of level) {
                if (node.parentTxid === nodeTxid) {
                    children.push(node);
                }
            }
        }

        return children;
    }

    // Returns the total number of nodes in the vtxo tree
    numberOfNodes(): number {
        return this.tree.reduce((count, level) => count + level.length, 0);
    }

    // Returns the branch of the given vtxo txid from root to leaf
    branch(vtxoTxid: string): TreeNode[] {
        const branch: TreeNode[] = [];
        const leaves = this.leaves();

        // Check if the vtxo is a leaf
        const leaf = leaves.find((leaf) => leaf.txid === vtxoTxid);
        if (!leaf) {
            throw ErrLeafNotFound;
        }

        branch.push(leaf);
        const rootTxid = this.root().txid;

        while (branch[0].txid !== rootTxid) {
            const parent = this.findParent(branch[0]);
            branch.unshift(parent);
        }

        return branch;
    }

    // Helper method to find parent of a node
    private findParent(node: TreeNode): TreeNode {
        for (const level of this.tree) {
            for (const potentialParent of level) {
                if (potentialParent.txid === node.parentTxid) {
                    return potentialParent;
                }
            }
        }
        throw ErrParentNotFound;
    }
}

// Prefix for cosigner keys in PSBT unknowns
const COSIGNER_KEY_PREFIX = new Uint8Array(
    "cosigner".split("").map((c) => c.charCodeAt(0))
);

function parsePrefixedCosignerKey(key: Uint8Array): number {
    // Check if key starts with the cosigner prefix
    if (key.length < COSIGNER_KEY_PREFIX.length + 1) return -1;

    for (let i = 0; i < COSIGNER_KEY_PREFIX.length; i++) {
        if (key[i] !== COSIGNER_KEY_PREFIX[i]) return -1;
    }

    // The index is stored after the prefix
    return key[COSIGNER_KEY_PREFIX.length];
}

function getCosignerKeys(tx: Transaction): Uint8Array[] {
    const keys: Uint8Array[] = [];

    const input = tx.getInput(0);

    if (!input.unknown) return keys;

    for (const unknown of input.unknown) {
        const cosignerIndex = parsePrefixedCosignerKey(
            Buffer.concat([new Uint8Array([unknown[0].type]), unknown[0].key])
        );
        if (cosignerIndex === -1) throw new Error("Invalid cosigner key");

        // Assuming the value is already a valid public key in compressed format
        keys.push(unknown[1]);
    }

    return keys;
}
