import { Script } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    RelativeTimelock,
} from "./tapscript";
import { hex } from "@scure/base";
import { VtxoScript } from "./base";
import { TaprootLeaf } from "@scure/btc-signer/payment";

// VHTLC is an Hashed Timelock Contract VtxoScript implementation
// - claim (preimage + receiver)
// - refund (sender + receiver + server)
// - refundWithoutReceiver (at refundLocktime, sender + receiver + server)
// - unilateralClaim (preimage + receiver after unilateralClaimDelay)
// - unilateralRefund (sender + receiver after unilateralRefundDelay)
// - unilateralRefundWithoutReceiver (sender after unilateralRefundWithoutReceiverDelay)
export namespace VHTLC {
    export interface Options {
        sender: Bytes;
        receiver: Bytes;
        server: Bytes;
        preimageHash: Bytes;
        refundLocktime: bigint;
        unilateralClaimDelay: RelativeTimelock;
        unilateralRefundDelay: RelativeTimelock;
        unilateralRefundWithoutReceiverDelay: RelativeTimelock;
    }

    export class Script extends VtxoScript {
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;

        constructor(readonly options: Options) {
            const {
                sender,
                receiver,
                server,
                preimageHash,
                refundLocktime,
                unilateralClaimDelay,
                unilateralRefundDelay,
                unilateralRefundWithoutReceiverDelay,
            } = options;

            const conditionScript = preimageConditionScript(preimageHash);

            const claimScript = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [receiver, server],
            }).script;

            const refundScript = MultisigTapscript.encode({
                pubkeys: [sender, receiver, server],
            }).script;

            const refundWithoutReceiverScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: refundLocktime,
                pubkeys: [sender, server],
            }).script;

            const unilateralClaimScript = ConditionCSVMultisigTapscript.encode({
                conditionScript,
                timelock: unilateralClaimDelay,
                pubkeys: [receiver],
            }).script;

            const unilateralRefundScript = CSVMultisigTapscript.encode({
                timelock: unilateralRefundDelay,
                pubkeys: [sender, receiver],
            }).script;

            const unilateralRefundWithoutReceiverScript =
                CSVMultisigTapscript.encode({
                    timelock: unilateralRefundWithoutReceiverDelay,
                    pubkeys: [sender],
                }).script;

            super([
                claimScript,
                refundScript,
                refundWithoutReceiverScript,
                unilateralClaimScript,
                unilateralRefundScript,
                unilateralRefundWithoutReceiverScript,
            ]);

            this.claimScript = hex.encode(claimScript);
            this.refundScript = hex.encode(refundScript);
            this.refundWithoutReceiverScript = hex.encode(
                refundWithoutReceiverScript
            );
            this.unilateralClaimScript = hex.encode(unilateralClaimScript);
            this.unilateralRefundScript = hex.encode(unilateralRefundScript);
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                unilateralRefundWithoutReceiverScript
            );
        }

        claim(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) => hex.encode(leaf.script) === this.claimScript
            );
            if (!leaf) {
                throw new Error("Claim script not found");
            }
            return leaf;
        }

        refund(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) => hex.encode(leaf.script) === this.refundScript
            );
            if (!leaf) {
                throw new Error("Refund script not found");
            }
            return leaf;
        }

        refundWithoutReceiver(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) =>
                    hex.encode(leaf.script) === this.refundWithoutReceiverScript
            );
            if (!leaf) {
                throw new Error("Refund without receiver script not found");
            }
            return leaf;
        }

        unilateralClaim(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) => hex.encode(leaf.script) === this.unilateralClaimScript
            );
            if (!leaf) {
                throw new Error("Unilateral claim script not found");
            }
            return leaf;
        }

        unilateralRefund(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) =>
                    hex.encode(leaf.script) === this.unilateralRefundScript
            );
            if (!leaf) {
                throw new Error("Unilateral refund script not found");
            }
            return leaf;
        }

        unilateralRefundWithoutReceiver(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) =>
                    hex.encode(leaf.script) ===
                    this.unilateralRefundWithoutReceiverScript
            );
            if (!leaf) {
                throw new Error(
                    "Unilateral refund without receiver script not found"
                );
            }
            return leaf;
        }
    }
}

function preimageConditionScript(preimageHash: Bytes): Bytes {
    return Script.encode(["HASH160", preimageHash, "EQUAL"]);
}
