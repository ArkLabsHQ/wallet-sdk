export type VSize = {
    value: bigint;
    fee(feeRate: bigint): bigint;
};

export class TxWeightEstimator {
    static readonly P2PKH_SCRIPT_SIG_SIZE = 1 + 73 + 1 + 33;
    static readonly INPUT_SIZE = 32 + 4 + 1 + 4;
    static readonly BASE_CONTROL_BLOCK_SIZE = 1 + 32;
    static readonly OUTPUT_SIZE = 8 + 1;
    static readonly P2WKH_OUTPUT_SIZE = 1 + 1 + 20;
    static readonly BASE_TX_SIZE = 8 + 2; // Version + LockTime
    static readonly WITNESS_HEADER_SIZE = 2; // Flag + Marker
    static readonly WITNESS_SCALE_FACTOR = 4;

    public hasWitness: boolean;
    public inputCount: number;
    public outputCount: number;
    public inputSize: number;
    public inputWitnessSize: number;
    public outputSize: number;

    private constructor(
        hasWitness: boolean,
        inputCount: number,
        outputCount: number,
        inputSize: number,
        inputWitnessSize: number,
        outputSize: number
    ) {
        this.hasWitness = hasWitness;
        this.inputCount = inputCount;
        this.outputCount = outputCount;
        this.inputSize = inputSize;
        this.inputWitnessSize = inputWitnessSize;
        this.outputSize = outputSize;
    }

    static create(): TxWeightEstimator {
        return new TxWeightEstimator(false, 0, 0, 0, 0, 0);
    }

    addKeySpendInput(isDefault: boolean = true): TxWeightEstimator {
        this.inputCount++;
        this.inputWitnessSize += 64 + 1 + (isDefault ? 0 : 1);
        this.inputSize += TxWeightEstimator.INPUT_SIZE;
        this.hasWitness = true;
        return this;
    }

    addP2PKHInput(): TxWeightEstimator {
        this.inputCount++;
        this.inputWitnessSize++;
        this.inputSize +=
            TxWeightEstimator.INPUT_SIZE +
            TxWeightEstimator.P2PKH_SCRIPT_SIG_SIZE;
        return this;
    }

    addTapscriptInput(
        leafWitnessSize: number,
        leafScriptSize: number,
        leafControlBlockSize: number
    ): TxWeightEstimator {
        const controlBlockWitnessSize =
            1 +
            TxWeightEstimator.BASE_CONTROL_BLOCK_SIZE +
            1 +
            leafScriptSize +
            1 +
            leafControlBlockSize;

        this.inputCount++;
        this.inputWitnessSize += leafWitnessSize + controlBlockWitnessSize;
        this.inputSize += TxWeightEstimator.INPUT_SIZE;
        this.hasWitness = true;
        this.inputCount++;
        return this;
    }

    addP2WKHOutput(): TxWeightEstimator {
        this.outputCount++;
        this.outputSize +=
            TxWeightEstimator.OUTPUT_SIZE + TxWeightEstimator.P2WKH_OUTPUT_SIZE;
        return this;
    }

    vsize(): VSize {
        const getVarIntSize = (n: number): number => {
            if (n < 0xfd) return 1;
            if (n < 0xffff) return 3;
            if (n < 0xffffffff) return 5;
            return 9;
        };

        const inputCount = getVarIntSize(this.inputCount);
        const outputCount = getVarIntSize(this.outputCount);

        // Calculate the size of the transaction without witness data
        const txSizeStripped =
            TxWeightEstimator.BASE_TX_SIZE +
            inputCount +
            this.inputSize +
            outputCount +
            this.outputSize;

        // Calculate the total weight
        let weight = txSizeStripped * TxWeightEstimator.WITNESS_SCALE_FACTOR;

        // Add witness data if present
        if (this.hasWitness) {
            weight +=
                TxWeightEstimator.WITNESS_HEADER_SIZE + this.inputWitnessSize;
        }

        // Convert weight to vsize (weight / 4, rounded up)
        return vsize(weight);
    }
}

const vsize = (weight: number): VSize => {
    const value = BigInt(
        Math.ceil(weight / TxWeightEstimator.WITNESS_SCALE_FACTOR)
    );
    return {
        value,
        fee: (feeRate: bigint) => feeRate * value,
    };
};
