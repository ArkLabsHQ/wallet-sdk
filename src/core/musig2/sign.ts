import { nobleCrypto } from "./crypto";
import * as musig from "@brandonblack/musig";

import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { CURVE } from "@noble/secp256k1";
import { aggregateKeys, sortKeys } from "./keys";
import { schnorr } from "@noble/curves/secp256k1";

export class SignError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SignError";
    }
}

// Add this error type for decode failures
export class PartialSignatureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PartialSignatureError";
    }
}

interface SignOptions {
    sortKeys?: boolean;
    taprootTweak?: Uint8Array;
}

// Implement a concrete class for PartialSignature
export class PartialSig {
    constructor(
        public s: Uint8Array,
        public R: Uint8Array
    ) {
        if (s.length !== 32) {
            throw new PartialSignatureError("Invalid s length");
        }
        if (R.length !== 33) {
            throw new PartialSignatureError("Invalid R length");
        }
    }

    /**
     * Encodes the partial signature into bytes
     * Returns a 32-byte array containing just the s value
     */
    encode(): Uint8Array {
        // Return copy of s bytes
        return new Uint8Array(this.s);
    }

    /**
     * Decodes a partial signature from bytes
     * @param bytes - 32-byte array containing s value
     */
    static decode(bytes: Uint8Array): PartialSig {
        if (bytes.length !== 32) {
            throw new PartialSignatureError("Invalid partial signature length");
        }

        // Verify s is less than curve order
        const s = bytesToNumberBE(bytes);
        if (s >= CURVE.n) {
            throw new PartialSignatureError("s value overflows curve order");
        }

        // For decode we don't have R, so we'll need to compute it later
        const R = new Uint8Array(33); // Zero R for now

        return new PartialSig(bytes, R);
    }
}

/**
 * Generates a MuSig2 partial signature
 */
export function sign(
    secNonce: Uint8Array,
    pubNonce: Uint8Array,
    privateKey: Uint8Array,
    combinedNonce: Uint8Array,
    publicKeys: Uint8Array[],
    message: Uint8Array,
    options?: SignOptions
): PartialSig {
    const musig2 = musig.MuSigFactory(nobleCrypto);
    musig2.addExternalNonce(pubNonce, secNonce);

    const { preTweakedKey } = aggregateKeys(
        options?.sortKeys ? sortKeys(publicKeys) : publicKeys,
        true
    );

    if (!options?.taprootTweak) {
        throw new SignError("Taproot tweak is required");
    }

    if (preTweakedKey.length !== 33) {
        throw new SignError("Pre-tweaked key is not 33 bytes");
    }
    const tweakBytes = schnorr.utils.taggedHash(
        "TapTweak",
        preTweakedKey.subarray(1),
        options.taprootTweak
    );

    const sessionKey = musig2.startSigningSession(
        combinedNonce,
        message,
        options?.sortKeys ? sortKeys(publicKeys) : publicKeys,
        { tweak: tweakBytes, xOnly: true }
    );

    const partialSig = musig2.partialSign({
        sessionKey,
        publicNonce: pubNonce,
        secretKey: privateKey,
        verify: true,
    });

    return PartialSig.decode(partialSig);
}
