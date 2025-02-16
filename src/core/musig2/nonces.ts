import { ProjectivePoint, CURVE } from "@noble/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { concatBytes, randomBytes } from "@noble/hashes/utils";
import { schnorr } from "@noble/curves/secp256k1";
import { mod } from "@noble/curves/abstract/modular";

export const PUB_NONCE_SIZE = 66; // Two 33-byte compressed points
export const SEC_NONCE_SIZE = 97; // Two 32-byte scalars + 33-byte pubkey

const NONCE_TAG = "MuSig/nonce";

/**
 * MuSig2 nonce pair containing public and secret values.
 * Public nonces are two compressed points (33 bytes each).
 * Secret nonces are the corresponding private scalars plus pubkey.
 */
export type Nonces = {
    pubNonce: Uint8Array;
    secNonce: Uint8Array;
};

export function isNonces(value: unknown): value is Nonces {
    if (!value || typeof value !== "object") return false;

    const nonces = value as Nonces;
    return (
        nonces.pubNonce instanceof Uint8Array &&
        nonces.secNonce instanceof Uint8Array &&
        nonces.pubNonce.length === PUB_NONCE_SIZE &&
        nonces.secNonce.length === SEC_NONCE_SIZE
    );
}

function writeUint8(value: number): Uint8Array {
    return new Uint8Array([value]);
}

function writeBytesWithLength(
    data: Uint8Array | undefined,
    lengthWriter: (n: number) => Uint8Array
): Uint8Array {
    if (!data) data = new Uint8Array(0);
    return concatBytes(lengthWriter(data.length), data);
}

/**
 * Generates nonce auxiliary bytes using the specified parameters
 */
function genNonceAuxBytes(
    rand: Uint8Array,
    pubkey: Uint8Array,
    idx: number
): Uint8Array {
    // Build the buffer with all components
    const components: Uint8Array[] = [
        // Initial randomness
        rand,

        // len(pk) || pk
        writeBytesWithLength(pubkey, writeUint8),
    ];

    components.push(new Uint8Array([0x00]));

    components.push(new Uint8Array([idx]));

    // Concatenate all components and create tagged hash
    const buffer = concatBytes(...components);
    const tagged = schnorr.utils.taggedHash(NONCE_TAG, buffer);

    // Reduce to valid scalar and convert to 32-byte array
    const scalar = mod(bytesToNumberBE(tagged), CURVE.n);
    return schnorr.utils.numberToBytesBE(scalar, 32);
}

/**
 * Converts secret nonces to public nonces by performing point multiplication
 */
function secNonceToPubNonce(secNonce: Uint8Array): Uint8Array {
    // Extract the two 32-byte secret nonces
    const k1 = secNonce.slice(0, 32);
    const k2 = secNonce.slice(32, 64);

    // Convert secret bytes to scalars and multiply by generator point
    const k1Scalar = bytesToNumberBE(k1);
    const k2Scalar = bytesToNumberBE(k2);

    // Use the base point multiplication to get the public points
    const R1 = ProjectivePoint.BASE.multiply(k1Scalar);
    const R2 = ProjectivePoint.BASE.multiply(k2Scalar);

    // Convert to affine coordinates and serialize in compressed format
    return concatBytes(
        R1.toRawBytes(true), // 33 bytes compressed format
        R2.toRawBytes(true) // 33 bytes compressed format
    );
}

/**
 * Generates a pair of public and secret nonces for MuSig2 signing
 */
export function generateNonces(publicKey: Uint8Array): Nonces {
    if (!publicKey || publicKey.length !== 33) {
        throw new Error("Invalid public key");
    }

    // Generate 32 random bytes
    let randBytes = randomBytes(32);

    // Generate the two secret nonces
    const k1 = genNonceAuxBytes(randBytes, publicKey, 0);
    const k2 = genNonceAuxBytes(randBytes, publicKey, 1);

    // Construct the secret nonce array (k1 || k2 || pubkey)
    const secNonce = concatBytes(k1, k2, publicKey);

    // Generate the public nonces from the secret nonces
    const pubNonce = secNonceToPubNonce(secNonce);

    return { secNonce, pubNonce };
}
