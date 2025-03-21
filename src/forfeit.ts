import { SigHash, Transaction } from "@scure/btc-signer";
import { Outpoint } from "./wallet";

interface ForfeitTxParams {
    connectorInput: Outpoint;
    vtxoInput: Outpoint;
    vtxoAmount: bigint;
    connectorAmount: bigint;
    feeAmount: bigint;
    vtxoPkScript: Uint8Array;
    connectorPkScript: Uint8Array;
    serverPkScript: Uint8Array;
    txLocktime?: number;
}

export function buildForfeitTx({
    connectorInput,
    vtxoInput,
    vtxoAmount,
    connectorAmount,
    feeAmount,
    vtxoPkScript,
    connectorPkScript,
    serverPkScript,
    txLocktime,
}: ForfeitTxParams): Transaction {
    const tx = new Transaction({
        version: 2,
        lockTime: txLocktime,
    });

    // Add connector input
    tx.addInput({
        txid: connectorInput.txid,
        index: connectorInput.vout,
        witnessUtxo: {
            script: connectorPkScript,
            amount: connectorAmount,
        },
        sequence: 0xffffffff,
    });

    // Add VTXO input
    tx.addInput({
        txid: vtxoInput.txid,
        index: vtxoInput.vout,
        witnessUtxo: {
            script: vtxoPkScript,
            amount: vtxoAmount,
        },
        sequence: txLocktime ? 0xfffffffe : 0xffffffff, // MAX_SEQUENCE - 1 if locktime is set
        sighashType: SigHash.DEFAULT,
    });

    const amount =
        BigInt(vtxoAmount) + BigInt(connectorAmount) - BigInt(feeAmount);

    // Add main output to server
    tx.addOutput({
        script: serverPkScript,
        amount,
    });

    return tx;
}
