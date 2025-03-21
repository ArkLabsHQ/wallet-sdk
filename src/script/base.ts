import {
    Address,
    p2tr,
    TAP_LEAF_VERSION,
    TaprootLeaf,
    taprootListToTree,
} from "@scure/btc-signer/payment";
import {
    BTC_NETWORK,
    Bytes,
    TAPROOT_UNSPENDABLE_KEY,
} from "@scure/btc-signer/utils";
import { ArkAddress } from "./address";
import { Script } from "@scure/btc-signer";
import { hex } from "@scure/base";

export class VtxoScript {
    readonly leaves: TaprootLeaf[];
    readonly tweakedPublicKey: Bytes;

    static decode(scripts: string[]): VtxoScript {
        return new VtxoScript(scripts.map(hex.decode));
    }

    constructor(readonly scripts: Bytes[]) {
        const tapTree = taprootListToTree(
            scripts.map((script) => ({ script, leafVersion: TAP_LEAF_VERSION }))
        );

        const payment = p2tr(TAPROOT_UNSPENDABLE_KEY, tapTree, undefined, true);

        if (!payment.leaves || payment.leaves.length !== scripts.length) {
            throw new Error("invalid scripts");
        }

        this.leaves = payment.leaves;
        this.tweakedPublicKey = payment.tweakedPubkey;
    }

    encode(): string[] {
        return this.scripts.map(hex.encode);
    }

    address(prefix: string, serverPubKey: Bytes): ArkAddress {
        return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
    }

    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.tweakedPublicKey]);
    }
    onchainAddress(network: BTC_NETWORK): string {
        return Address(network).encode({
            type: "tr",
            pubkey: this.tweakedPublicKey,
        });
    }
}

export type EncodedVtxoScript = { scripts: ReturnType<VtxoScript["encode"]> };
