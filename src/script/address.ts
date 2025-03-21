import { bech32m } from "@scure/base";
import { Bytes } from "@scure/btc-signer/utils";
import { Script } from "@scure/btc-signer";

// ArkAddress is a bech32m encoded address with a custom HRP (ark/tark)
export class ArkAddress {
    constructor(
        readonly serverPubKey: Bytes,
        readonly tweakedPubKey: Bytes,
        readonly hrp: string
    ) {
        if (serverPubKey.length !== 32) {
            throw new Error("Invalid server public key length");
        }
        if (tweakedPubKey.length !== 32) {
            throw new Error("Invalid tweaked public key length");
        }
    }

    static decode(address: string): ArkAddress {
        const decoded = bech32m.decodeUnsafe(address, 1023);
        if (!decoded) {
            throw new Error("Invalid address");
        }
        const data = new Uint8Array(bech32m.fromWords(decoded.words));

        // First 32 bytes are server pubkey, next 32 bytes are tweaked pubkey
        if (data.length !== 64) {
            throw new Error("Invalid data length");
        }

        const serverPubKey = data.slice(0, 32);
        const tweakedPubKey = data.slice(32, 64);

        return new ArkAddress(serverPubKey, tweakedPubKey, decoded.prefix);
    }

    encode(): string {
        // Combine server pubkey and tweaked pubkey
        const data = new Uint8Array(64);
        data.set(this.serverPubKey, 0);
        data.set(this.tweakedPubKey, 32);

        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.tweakedPubKey]);
    }
}
