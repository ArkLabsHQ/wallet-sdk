import { DEFAULT_SEQUENCE, RawWitness, Transaction } from "@scure/btc-signer";
import { VirtualCoin } from "../wallet";
import { Output } from "../providers/ark";
import { CLTVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import {
    EncodedVtxoScript,
    scriptFromTapLeafScript,
    TapLeafScript,
    VtxoScript,
} from "../script/base";
import { ArkAddress } from "../script/address";
import { hex } from "@scure/base";

const ARK_UNKNOWN_KEY_TYPE = 255;

// Constant for condition witness key prefix
export const CONDITION_WITNESS_KEY_PREFIX = new TextEncoder().encode(
    "condition"
);

export const VTXO_TAPROOT_TREE_KEY_PREFIX = new TextEncoder().encode("taptree");

export function addVtxoTaprootTree(
    inIndex: number,
    tx: Transaction,
    scripts: Uint8Array[]
): void {
    tx.updateInput(inIndex, {
        unknown: [
            ...(tx.getInput(inIndex)?.unknown ?? []),
            [
                {
                    type: ARK_UNKNOWN_KEY_TYPE,
                    key: VTXO_TAPROOT_TREE_KEY_PREFIX,
                },
                encodeTaprootTree(scripts),
            ],
        ],
    });
}

export function addConditionWitness(
    inIndex: number,
    tx: Transaction,
    witness: Uint8Array[]
): void {
    const witnessBytes = RawWitness.encode(witness);

    tx.updateInput(inIndex, {
        unknown: [
            ...(tx.getInput(inIndex)?.unknown ?? []),
            [
                {
                    type: ARK_UNKNOWN_KEY_TYPE,
                    key: CONDITION_WITNESS_KEY_PREFIX,
                },
                witnessBytes,
            ],
        ],
    });
}

export function createVirtualTx(
    inputs: ({ tapLeafScript: TapLeafScript } & EncodedVtxoScript &
        Pick<VirtualCoin, "txid" | "vout" | "value">)[],
    outputs: Output[]
) {
    let lockTime = 0;
    for (const input of inputs) {
        const tapscript = decodeTapscript(
            scriptFromTapLeafScript(input.tapLeafScript)
        );
        if (CLTVMultisigTapscript.is(tapscript)) {
            const thisLockTime = Number(tapscript.params.absoluteTimelock);
            if (thisLockTime > lockTime) lockTime = thisLockTime;
        }
    }

    const tx = new Transaction({
        allowUnknown: true,
        lockTime,
    });

    for (const [i, input] of inputs.entries()) {
        tx.addInput({
            txid: input.txid,
            index: input.vout,
            sequence: lockTime ? DEFAULT_SEQUENCE - 1 : undefined,
            witnessUtxo: {
                script: VtxoScript.decode(input.scripts).pkScript,
                amount: BigInt(input.value),
            },
            tapLeafScript: [input.tapLeafScript],
        });

        // add BIP371 encoded taproot tree to the unknown key field
        addVtxoTaprootTree(i, tx, input.scripts.map(hex.decode));
    }

    for (const output of outputs) {
        tx.addOutput({
            amount: output.amount,
            script: ArkAddress.decode(output.address).pkScript,
        });
    }

    return tx;
}

function encodeTaprootTree(leaves: Uint8Array[]): Uint8Array {
    const chunks: Uint8Array[] = [];

    // Write number of leaves as compact size uint
    chunks.push(encodeCompactSizeUint(leaves.length));

    for (const tapscript of leaves) {
        // Write depth (always 1 for now)
        chunks.push(new Uint8Array([1]));

        // Write leaf version (0xc0 for tapscript)
        chunks.push(new Uint8Array([0xc0]));

        // Write script length and script
        chunks.push(encodeCompactSizeUint(tapscript.length));
        chunks.push(tapscript);
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

function encodeCompactSizeUint(value: number): Uint8Array {
    if (value < 0xfd) {
        return new Uint8Array([value]);
    } else if (value <= 0xffff) {
        const buffer = new Uint8Array(3);
        buffer[0] = 0xfd;
        new DataView(buffer.buffer).setUint16(1, value, true);
        return buffer;
    } else if (value <= 0xffffffff) {
        const buffer = new Uint8Array(5);
        buffer[0] = 0xfe;
        new DataView(buffer.buffer).setUint32(1, value, true);
        return buffer;
    } else {
        const buffer = new Uint8Array(9);
        buffer[0] = 0xff;
        new DataView(buffer.buffer).setBigUint64(1, BigInt(value), true);
        return buffer;
    }
}
