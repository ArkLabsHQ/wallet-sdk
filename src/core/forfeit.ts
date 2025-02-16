import { hex } from "@scure/base";
import { SigHash, Transaction } from "@scure/btc-signer";
import { sha256x2 } from "@scure/btc-signer/utils";
import { Outpoint } from "../types/wallet";

type WitnessUtxo = {
    script: Uint8Array;
    amount: bigint;
};

interface ForfeitTxParams {
    connectorTx: Transaction;
    vtxoInput: Outpoint;
    vtxoAmount: bigint;
    connectorAmount: bigint;
    feeAmount: bigint;
    vtxoScript: Uint8Array;
    serverScript: Uint8Array;
    txLocktime?: number;
}

export function buildForfeitTxs({
    connectorTx,
    vtxoInput,
    vtxoAmount,
    connectorAmount,
    feeAmount,
    vtxoScript,
    serverScript,
    txLocktime,
}: ForfeitTxParams): Transaction[] {
    const [connectors, prevouts] = getConnectorInputs(
        connectorTx,
        connectorAmount
    );
    const forfeitTxs: Transaction[] = [];

    for (let i = 0; i < connectors.length; i++) {
        const connectorInput = connectors[i];
        const connectorPrevout = prevouts[i];

        // Create new transaction
        const tx = new Transaction({
            version: 2,
            lockTime: txLocktime,
        });

        // Add connector input
        tx.addInput({
            txid: connectorInput.txid,
            index: connectorInput.vout,
            witnessUtxo: connectorPrevout,
            sequence: 0xffffffff, // MAX_SEQUENCE
        });

        // Add VTXO input
        tx.addInput({
            txid: vtxoInput.txid,
            index: vtxoInput.vout,
            witnessUtxo: {
                script: vtxoScript,
                amount: vtxoAmount,
            },
            sequence: txLocktime ? 0xfffffffe : 0xffffffff, // MAX_SEQUENCE - 1 if locktime is set
            sighashType: SigHash.DEFAULT,
        });

        const amount =
            BigInt(vtxoAmount) + BigInt(connectorAmount) - BigInt(feeAmount);

        // Add main output to server
        tx.addOutput({
            script: serverScript,
            amount,
        });

        forfeitTxs.push(tx);
    }

    return forfeitTxs;
}

// extract outpoints and witness utxos from a connector transaction
function getConnectorInputs(
    tx: Transaction,
    connectorAmount: bigint
): [Outpoint[], WitnessUtxo[]] {
    const outpoints: Outpoint[] = [];
    const witnessUtxos: WitnessUtxo[] = [];
    const txid = hex.encode(sha256x2(tx.toBytes(true)).reverse());

    for (let vout = 0; vout < tx.outputsLength; vout++) {
        const output = tx.getOutput(vout);
        if (!output.amount) {
            continue;
        }
        if (BigInt(output.amount) === BigInt(connectorAmount)) {
            outpoints.push({
                txid,
                vout,
            });

            if (!output.script) {
                throw new Error("Output script is undefined");
            }

            witnessUtxos.push({
                script: output.script,
                amount: output.amount,
            });
        }
    }

    return [outpoints, witnessUtxos];
}
