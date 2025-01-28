import { schnorr } from "@noble/curves/secp256k1";
import { nobleCrypto } from "./crypto";
import { MuSigFactory } from "@brandonblack/musig";

export class KeyAggError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "KeyAggError";
    }
}

interface KeyAggOptions {
    taprootTweak?: Uint8Array;
}

export interface AggregateKey {
    preTweakedKey: Uint8Array; // 33-byte compressed point
    finalKey: Uint8Array; // 33-byte compressed point
}

/**
 * Checks if array of public keys is already sorted
 */
function isSorted(keys: Uint8Array[]): boolean {
    for (let i = 1; i < keys.length; i++) {
        const prev = keys[i - 1];
        const curr = keys[i];

        // Compare each byte
        for (let j = 0; j < prev.length; j++) {
            if (prev[j] < curr[j]) {
                break;
            }
            if (prev[j] > curr[j]) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Sorts public keys in lexicographical order based on their serialized bytes.
 * Returns a new array with sorted keys.
 */
export function sortKeys(keys: Uint8Array[]): Uint8Array[] {
    // Check if already sorted
    if (isSorted(keys)) {
        return keys;
    }

    return [...keys].sort((a, b) => {
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return a[i] - b[i];
            }
        }
        return 0;
    });
}

/**
 * Aggregates multiple public keys according to the MuSig2 algorithm
 */
export function aggregateKeys(
    publicKeys: Uint8Array[],
    sort: boolean,
    options: Partial<KeyAggOptions> = {}
): AggregateKey {
    if (sort) {
        publicKeys = sortKeys(publicKeys);
    }

    const musig2 = MuSigFactory(nobleCrypto);
    const preTweakedKeyCtx = musig2.keyAgg(publicKeys);
    const preTweakedKey = preTweakedKeyCtx.aggPublicKey;
    const preTweakedKeyCompressed = nobleCrypto.pointCompress(
        preTweakedKey,
        true
    );
    const tweakBytes = schnorr.utils.taggedHash(
        "TapTweak",
        preTweakedKeyCompressed.subarray(1),
        options.taprootTweak ?? new Uint8Array(0)
    );
    const finalKeyCtx = musig2.addTweaks(preTweakedKeyCtx, {
        tweak: tweakBytes,
        xOnly: true,
    });
    const finalKey = finalKeyCtx.aggPublicKey;

    // convert to compressed format
    const finalKeyCompressed = nobleCrypto.pointCompress(finalKey, true);

    return {
        preTweakedKey: preTweakedKeyCompressed,
        finalKey: finalKeyCompressed,
    };
}
