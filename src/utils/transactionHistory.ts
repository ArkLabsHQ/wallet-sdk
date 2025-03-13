import { ArkTransaction, TxType, TxKey, VirtualCoin } from "../core/wallet";

/**
 * Helper function to find vtxos that were spent in a settlement
 */
function findVtxosSpentInSettlement(
    vtxos: VirtualCoin[],
    vtxo: VirtualCoin
): VirtualCoin[] {
    if (vtxo.virtualStatus.state === "pending") {
        return [];
    }

    return vtxos.filter((v) => {
        if (!v.spentBy) return false;
        return v.spentBy === vtxo.virtualStatus.batchTxID;
    });
}

/**
 * Helper function to find vtxos that were spent in a payment
 */
function findVtxosSpentInPayment(
    vtxos: VirtualCoin[],
    vtxo: VirtualCoin
): VirtualCoin[] {
    return vtxos.filter((v) => {
        if (!v.spentBy) return false;
        return v.spentBy === vtxo.txid;
    });
}

/**
 * Helper function to find vtxos that resulted from a spentBy transaction
 */
function findVtxosResultedFromSpentBy(
    vtxos: VirtualCoin[],
    spentBy: string
): VirtualCoin[] {
    return vtxos.filter((v) => {
        if (
            v.virtualStatus.state !== "pending" &&
            v.virtualStatus.batchTxID === spentBy
        ) {
            return true;
        }
        return v.txid === spentBy;
    });
}

/**
 * Helper function to reduce vtxos to their total amount
 */
function reduceVtxosAmount(vtxos: VirtualCoin[]): number {
    return vtxos.reduce((sum, v) => sum + v.value, 0);
}

/**
 * Helper function to get a vtxo from a list of vtxos
 */
function getVtxo(
    resultedVtxos: VirtualCoin[],
    spentVtxos: VirtualCoin[]
): VirtualCoin {
    if (resultedVtxos.length === 0) {
        return spentVtxos[0];
    }
    return resultedVtxos[0];
}

export function vtxosToTxs(
    spendable: VirtualCoin[],
    spent: VirtualCoin[],
    boardingRounds: Set<string>
): ArkTransaction[] {
    const txs: ArkTransaction[] = [];

    // Receive case
    // All vtxos are received unless:
    // - they resulted from a settlement (either boarding or refresh)
    // - they are the change of a spend tx
    let vtxosLeftToCheck = [...spent];
    for (const vtxo of [...spendable, ...spent]) {
        if (
            vtxo.virtualStatus.state !== "pending" &&
            boardingRounds.has(vtxo.virtualStatus.batchTxID || "")
        ) {
            continue;
        }

        const settleVtxos = findVtxosSpentInSettlement(vtxosLeftToCheck, vtxo);
        vtxosLeftToCheck = removeVtxosFromList(vtxosLeftToCheck, settleVtxos);
        const settleAmount = reduceVtxosAmount(settleVtxos);
        if (vtxo.value <= settleAmount) {
            continue; // settlement or change, ignore
        }

        const spentVtxos = findVtxosSpentInPayment(vtxosLeftToCheck, vtxo);
        vtxosLeftToCheck = removeVtxosFromList(vtxosLeftToCheck, spentVtxos);
        const spentAmount = reduceVtxosAmount(spentVtxos);
        if (vtxo.value <= spentAmount) {
            continue; // settlement or change, ignore
        }

        const txKey: TxKey = {
            roundTxid: vtxo.virtualStatus.batchTxID || "",
            boardingTxid: "",
            redeemTxid: "",
        };
        let settled = vtxo.virtualStatus.state !== "pending";
        if (vtxo.virtualStatus.state === "pending") {
            txKey.redeemTxid = vtxo.txid;

            if (vtxo.spentBy) {
                settled = true;
            }
        }

        txs.push({
            key: txKey,
            amount: vtxo.value - settleAmount - spentAmount,
            type: TxType.TxReceived,
            createdAt: vtxo.createdAt.toISOString(),
            settled,
        });
    }

    // send case
    // All "spentBy" vtxos are payments unless:
    // - they are settlements

    // aggregate spent by spentId
    const vtxosBySpentBy = new Map<string, VirtualCoin[]>();
    for (const v of spent) {
        if (!v.spentBy) continue;

        if (!vtxosBySpentBy.has(v.spentBy)) {
            vtxosBySpentBy.set(v.spentBy, []);
        }
        const currentVtxos = vtxosBySpentBy.get(v.spentBy)!;
        vtxosBySpentBy.set(v.spentBy, [...currentVtxos, v]);
    }

    for (const [sb, vtxos] of vtxosBySpentBy) {
        const resultedVtxos = findVtxosResultedFromSpentBy(
            [...spendable, ...spent],
            sb
        );
        const resultedAmount = reduceVtxosAmount(resultedVtxos);
        const spentAmount = reduceVtxosAmount(vtxos);
        if (spentAmount <= resultedAmount) {
            continue; // settlement or change, ignore
        }

        const vtxo = getVtxo(resultedVtxos, vtxos);

        const txKey: TxKey = {
            roundTxid: vtxo.virtualStatus.batchTxID || "",
            boardingTxid: "",
            redeemTxid: "",
        };
        if (vtxo.virtualStatus.state === "pending") {
            txKey.redeemTxid = vtxo.txid;
        }

        txs.push({
            key: txKey,
            amount: spentAmount - resultedAmount,
            type: TxType.TxSent,
            createdAt: vtxo.createdAt.toISOString(),
            settled: true,
        });
    }

    // sort by createdAt in descending order
    txs.sort(
        (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return txs;
}

function removeVtxosFromList(
    vtxos: VirtualCoin[],
    vtxosToRemove: VirtualCoin[]
): VirtualCoin[] {
    return vtxos.filter((v) => {
        for (const vtxoToRemove of vtxosToRemove) {
            if (v.txid === vtxoToRemove.txid && v.vout === vtxoToRemove.vout) {
                return false;
            }
        }
        return true;
    });
}
