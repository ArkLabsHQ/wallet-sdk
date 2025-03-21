import { TaprootLeaf } from "@scure/btc-signer/payment";
import { Bytes } from "@scure/btc-signer/utils";
import { VtxoScript } from "./base";
import {
    CSVMultisigTapscript,
    MultisigTapscript,
    RelativeTimelock,
} from "./tapscript";
import { hex } from "@scure/base";

// DefaultVtxo is the default implementation of a VtxoScript.
// it contains 1 forfeit path and 1 exit path.
// forfeit = (Alice + Server)
// exit = (Alice) after csvTimelock
export namespace DefaultVtxo {
    export interface Options {
        pubKey: Bytes;
        serverPubKey: Bytes;
        csvTimelock?: RelativeTimelock;
    }

    export class Script extends VtxoScript {
        static readonly DEFAULT_TIMELOCK: RelativeTimelock = {
            value: 144n,
            type: "blocks",
        }; // 1 day in blocks

        readonly forfeitScript: string;
        readonly exitScript: string;

        constructor(readonly options: Options) {
            const {
                pubKey,
                serverPubKey,
                csvTimelock = Script.DEFAULT_TIMELOCK,
            } = options;

            const forfeitScript = MultisigTapscript.encode({
                pubkeys: [pubKey, serverPubKey],
            }).script;

            const exitScript = CSVMultisigTapscript.encode({
                timelock: csvTimelock,
                pubkeys: [pubKey],
            }).script;

            super([forfeitScript, exitScript]);

            this.forfeitScript = hex.encode(forfeitScript);
            this.exitScript = hex.encode(exitScript);
        }

        forfeit(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) => hex.encode(leaf.script) === this.forfeitScript
            );
            if (!leaf) {
                throw new Error("forfeit script not found");
            }

            return leaf;
        }

        exit(): TaprootLeaf {
            const leaf = this.leaves.find(
                (leaf) => hex.encode(leaf.script) === this.exitScript
            );
            if (!leaf) {
                throw new Error("exit script not found");
            }

            return leaf;
        }
    }
}
