import {
    DEFAULT_SEQUENCE,
    RawWitness,
    TAPROOT_UNSPENDABLE_KEY,
    Transaction,
} from "@scure/btc-signer";
import { TaprootLeaf } from "@scure/btc-signer/payment";
import { VirtualCoin } from "../wallet";
import { Output } from "../providers/ark";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment";
import { CLTVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import { EncodedVtxoScript, VtxoScript } from "../script/base";
import { ArkAddress } from "../script/address";

// Constant for condition witness key prefix
export const CONDITION_WITNESS_KEY_PREFIX = new TextEncoder().encode(
    "condition"
);

export function addConditionWitness(
    inIndex: number,
    tx: Transaction,
    witness: Uint8Array[]
): void {
    const witnessBytes = RawWitness.encode(witness);

    tx.updateInput(inIndex, {
        unknown: [
            [
                {
                    type: 255,
                    key: CONDITION_WITNESS_KEY_PREFIX,
                },
                witnessBytes,
            ],
        ],
    });
}

export function makeVirtualTx(
    inputs: (TaprootLeaf &
        EncodedVtxoScript &
        Pick<VirtualCoin, "txid" | "vout" | "value">)[],
    outputs: Output[]
) {
    let lockTime: number | undefined;
    for (const input of inputs) {
        const tapscript = decodeTapscript(input.script);
        if (CLTVMultisigTapscript.is(tapscript)) {
            lockTime = Number(tapscript.params.absoluteTimelock);
        }
    }

    const tx = new Transaction({
        allowUnknown: true,
        lockTime,
    });

    for (const input of inputs) {
        tx.addInput({
            txid: input.txid,
            index: input.vout,
            sequence: lockTime ? DEFAULT_SEQUENCE - 1 : undefined,
            witnessUtxo: {
                script: VtxoScript.decode(input.scripts).pkScript,
                amount: BigInt(input.value),
            },
            tapLeafScript: [
                [
                    {
                        version: TAP_LEAF_VERSION,
                        internalKey: TAPROOT_UNSPENDABLE_KEY,
                        merklePath: input.path,
                    },
                    new Uint8Array([...input.script, TAP_LEAF_VERSION]),
                ],
            ],
        });
    }

    for (const output of outputs) {
        tx.addOutput({
            amount: output.amount,
            script: ArkAddress.decode(output.address).pkScript,
        });
    }

    return tx;
}
