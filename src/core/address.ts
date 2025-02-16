import { bech32m, hex } from "@scure/base";
import { Bytes, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer/utils";
import { networks } from "../types/networks";
import { p2tr, Script, taprootListToTree } from "@scure/btc-signer";

/**
 * ArkAddress is a bech32m encoded address with a custom HRP (ark/tark)
 */
export class ArkAddress {
    static readonly VALID_NETWORKS = [
        networks.bitcoin,
        networks.testnet,
        networks.mutinynet,
        networks.regtest,
    ];

    readonly network: typeof networks.bitcoin;
    readonly serverPubKey: Uint8Array;
    readonly tweakedPubKey: Uint8Array;

    /**
     * Get network from HRP prefix
     */
    static networkFromPrefix(prefix: string): typeof networks.bitcoin {
        switch (prefix) {
            case "ark":
                return networks.bitcoin;
            case "tark":
                return networks.testnet; // Both testnet and regtest use tark
            default:
                throw new Error("Invalid Ark address format");
        }
    }

    /**
     * Get HRP prefix from network
     */
    static prefixFromNetwork(network: typeof networks.bitcoin): string {
        if (network === networks.bitcoin) return "ark";
        return "tark"; // testnet, regtest, and mutinynet all use tark
    }

    constructor(
        serverPubKey: Bytes,
        tweakedPubKey: Bytes,
        network: typeof networks.bitcoin = networks.testnet
    ) {
        if (!ArkAddress.VALID_NETWORKS.includes(network)) {
            throw new Error("Invalid network");
        }
        this.network = network;
        this.serverPubKey = new Uint8Array(serverPubKey);
        this.tweakedPubKey = new Uint8Array(tweakedPubKey);
    }

    static fromTapscripts(
        serverPubKey: Bytes,
        tapscripts: string[],
        network?: typeof networks.bitcoin
    ): ArkAddress {
        const tapTree = taprootListToTree(
            tapscripts.map((script) => ({ script: hex.decode(script) }))
        );

        const payment = p2tr(TAPROOT_UNSPENDABLE_KEY, tapTree, undefined, true);

        return new ArkAddress(serverPubKey, payment.tweakedPubkey, network);
    }

    static decode(address: string): ArkAddress {
        // @ts-expect-error - bech32m addresses are properly formatted
        const decoded = bech32m.decode(address, 1023);
        const data = new Uint8Array(bech32m.fromWords(decoded.words));

        // First 32 bytes are server pubkey, next 32 bytes are tweaked pubkey
        if (data.length !== 64) {
            throw new Error("Invalid data length");
        }

        const serverPubKey = data.slice(0, 32);
        const tweakedPubKey = data.slice(32, 64);

        // Get network from prefix
        const network = ArkAddress.networkFromPrefix(decoded.prefix);

        return new ArkAddress(serverPubKey, tweakedPubKey, network);
    }

    /**
     * Get the HRP for this address
     */
    get hrp(): string {
        return ArkAddress.prefixFromNetwork(this.network);
    }

    encode(): string {
        if (!this.serverPubKey) {
            throw new Error("missing Server public key");
        }
        if (!this.tweakedPubKey) {
            throw new Error("missing Tweaked public key");
        }

        // Combine server pubkey and tweaked pubkey
        const data = new Uint8Array(64);
        data.set(this.serverPubKey, 0);
        data.set(this.tweakedPubKey, 32);

        // Convert to 5-bit words and encode
        const words = bech32m.toWords(data);
        return bech32m.encode(this.hrp, words, 1023);
    }

    get script(): Bytes {
        return Script.encode(["OP_1", this.tweakedPubKey]);
    }
}
