import * as bip68 from "bip68";
import { Bytes } from "@scure/btc-signer/utils";
import { Script, ScriptNum, ScriptType } from "@scure/btc-signer/script";
import { p2tr_ms } from "@scure/btc-signer/payment";

export type RelativeTimelock = {
    value: bigint;
    type: "seconds" | "blocks";
};

export enum TapscriptType {
    Multisig = "multisig",
    CSVMultisig = "csv-multisig",
    ConditionCSVMultisig = "condition-csv-multisig",
    ConditionMultisig = "condition-multisig",
    CLTVMultisig = "cltv-multisig",
}

export interface ArkTapscript<
    T extends TapscriptType,
    Params,
    SizeArgs = never,
> {
    type: T;
    params: Params;
    script: Uint8Array;
    witnessSize(args: SizeArgs): number;
}

export function decodeTapscript(
    script: Uint8Array
): ArkTapscript<TapscriptType, any, any | undefined> {
    const types = [
        MultisigTapscript,
        CSVMultisigTapscript,
        ConditionCSVMultisigTapscript,
        ConditionMultisigTapscript,
        CLTVMultisigTapscript,
    ];

    for (const type of types) {
        try {
            return type.decode(script);
        } catch (error) {
            continue;
        }
    }

    throw new Error("Failed to decode: script is not a valid tapscript");
}

/**
 * Implements a multi-signature script that requires a threshold of signatures
 * from the specified pubkeys.
 */
export namespace MultisigTapscript {
    export type Type = ArkTapscript<TapscriptType.Multisig, Params>;

    export enum MultisigType {
        CHECKSIG,
        CHECKSIGADD,
    }

    export type Params = {
        pubkeys: Bytes[];
        type?: MultisigType;
    };

    export function encode(params: Params): Type {
        if (params.pubkeys.length === 0) {
            throw new Error("At least 1 pubkey is required");
        }

        for (const pubkey of params.pubkeys) {
            if (pubkey.length !== 32) {
                throw new Error(
                    `Invalid pubkey length: expected 32, got ${pubkey.length}`
                );
            }
        }

        if (!params.type) {
            params.type = MultisigType.CHECKSIG;
        }

        if (params.type === MultisigType.CHECKSIGADD) {
            return {
                type: TapscriptType.Multisig,
                params,
                script: p2tr_ms(params.pubkeys.length, params.pubkeys).script,
                witnessSize: () => params.pubkeys.length * 64,
            };
        }

        const asm: ScriptType = [];
        for (let i = 0; i < params.pubkeys.length; i++) {
            asm.push(params.pubkeys[i]);

            // CHECKSIGVERIFY except the last pubkey
            if (i < params.pubkeys.length - 1) {
                asm.push("CHECKSIGVERIFY");
            } else {
                asm.push("CHECKSIG");
            }
        }

        return {
            type: TapscriptType.Multisig,
            params,
            script: Script.encode(asm),
            witnessSize: () => params.pubkeys.length * 64,
        };
    }

    export function decode(script: Uint8Array): Type {
        if (script.length === 0) {
            throw new Error("Failed to decode: script is empty");
        }

        try {
            // Try decoding as checksigAdd first
            return decodeChecksigAdd(script);
        } catch (error) {
            // If checksigAdd fails, try regular checksig
            try {
                return decodeChecksig(script);
            } catch (error2) {
                throw new Error(
                    `Failed to decode script: ${error2 instanceof Error ? error2.message : String(error2)}`
                );
            }
        }
    }

    // <pubkey> CHECKSIG <pubkey> CHECKSIGADD <len_keys> NUMEQUAL
    function decodeChecksigAdd(script: Uint8Array): Type {
        const asm = Script.decode(script);
        const pubkeys: Bytes[] = [];
        let foundNumEqual = false;

        // Parse through ASM operations
        for (let i = 0; i < asm.length; i++) {
            const op = asm[i];

            // If it's a data push, it should be a 32-byte pubkey
            if (typeof op !== "string" && typeof op !== "number") {
                if (op.length !== 32) {
                    throw new Error(
                        `Invalid pubkey length: expected 32, got ${op.length}`
                    );
                }
                pubkeys.push(op);

                // Check next operation is CHECKSIGADD or CHECKSIG
                if (
                    i + 1 >= asm.length ||
                    (asm[i + 1] !== "CHECKSIGADD" && asm[i + 1] !== "CHECKSIG")
                ) {
                    throw new Error(
                        "Expected CHECKSIGADD or CHECKSIG after pubkey"
                    );
                }
                i++; // Skip the CHECKSIGADD op
                continue;
            }

            // Last operation should be NUMEQUAL
            if (i === asm.length - 1) {
                if (op !== "NUMEQUAL") {
                    throw new Error("Expected NUMEQUAL at end of script");
                }
                foundNumEqual = true;
            }
        }

        if (!foundNumEqual) {
            throw new Error("Missing NUMEQUAL operation");
        }

        if (pubkeys.length === 0) {
            throw new Error("Invalid script: must have at least 1 pubkey");
        }

        // Verify the script by re-encoding and comparing
        const reconstructed = encode({
            pubkeys,
            type: MultisigType.CHECKSIGADD,
        });
        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.Multisig,
            params: { pubkeys, type: MultisigType.CHECKSIGADD },
            script,
            witnessSize: () => pubkeys.length * 64,
        };
    }

    // <pubkey> CHECKSIGVERIFY <pubkey> CHECKSIG
    function decodeChecksig(script: Uint8Array): Type {
        const asm = Script.decode(script);
        const pubkeys: Bytes[] = [];

        // Parse through ASM operations
        for (let i = 0; i < asm.length; i++) {
            const op = asm[i];

            // If it's a data push, it should be a 32-byte pubkey
            if (typeof op !== "string" && typeof op !== "number") {
                if (op.length !== 32) {
                    throw new Error(
                        `Invalid pubkey length: expected 32, got ${op.length}`
                    );
                }
                pubkeys.push(op);

                // Check next operation
                if (i + 1 >= asm.length) {
                    throw new Error("Unexpected end of script");
                }

                const nextOp = asm[i + 1];
                if (nextOp !== "CHECKSIGVERIFY" && nextOp !== "CHECKSIG") {
                    throw new Error(
                        "Expected CHECKSIGVERIFY or CHECKSIG after pubkey"
                    );
                }

                // Last operation must be CHECKSIG, not CHECKSIGVERIFY
                if (i === asm.length - 2 && nextOp !== "CHECKSIG") {
                    throw new Error("Last operation must be CHECKSIG");
                }

                i++; // Skip the CHECKSIG/CHECKSIGVERIFY op
                continue;
            }
        }

        if (pubkeys.length === 0) {
            throw new Error("Invalid script: must have at least 1 pubkey");
        }

        // Verify the script by re-encoding and comparing
        const reconstructed = encode({ pubkeys, type: MultisigType.CHECKSIG });
        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.Multisig,
            params: { pubkeys, type: MultisigType.CHECKSIG },
            script,
            witnessSize: () => pubkeys.length * 64,
        };
    }

    export function is(tapscript: ArkTapscript<any, any>): tapscript is Type {
        return tapscript.type === TapscriptType.Multisig;
    }
}

/**
 * Implements a relative timelock script that requires all specified pubkeys to sign
 * after the relative timelock has expired. The timelock can be specified in blocks or seconds.
 *
 * This is the standard exit closure and it is also used for the sweep closure in vtxo trees.
 */
export namespace CSVMultisigTapscript {
    export type Type = ArkTapscript<TapscriptType.CSVMultisig, Params>;

    export type Params = {
        timelock: RelativeTimelock;
    } & MultisigTapscript.Params;

    export function encode(params: Params): Type {
        for (const pubkey of params.pubkeys) {
            if (pubkey.length !== 32) {
                throw new Error(
                    `Invalid pubkey length: expected 32, got ${pubkey.length}`
                );
            }
        }

        const sequence = ScriptNum().encode(
            BigInt(
                bip68.encode(
                    params.timelock.type === "blocks"
                        ? { blocks: Number(params.timelock.value) }
                        : { seconds: Number(params.timelock.value) }
                )
            )
        );

        const asm: ScriptType = [sequence, "CHECKSEQUENCEVERIFY", "DROP"];
        const multisigScript = MultisigTapscript.encode(params);
        const script = new Uint8Array([
            ...Script.encode(asm),
            ...multisigScript.script,
        ]);

        return {
            type: TapscriptType.CSVMultisig,
            params,
            script,
            witnessSize: () => params.pubkeys.length * 64,
        };
    }

    export function decode(script: Uint8Array): Type {
        if (script.length === 0) {
            throw new Error("Failed to decode: script is empty");
        }

        const asm = Script.decode(script);

        if (asm.length < 3) {
            throw new Error(`Invalid script: too short (expected at least 3)`);
        }

        const sequence = asm[0];
        if (typeof sequence === "string" || typeof sequence === "number") {
            throw new Error("Invalid script: expected sequence number");
        }

        if (asm[1] !== "CHECKSEQUENCEVERIFY" || asm[2] !== "DROP") {
            throw new Error(
                "Invalid script: expected CHECKSEQUENCEVERIFY DROP"
            );
        }

        const multisigScript = new Uint8Array(Script.encode(asm.slice(3)));
        let multisig: MultisigTapscript.Type;

        try {
            multisig = MultisigTapscript.decode(multisigScript);
        } catch (error) {
            throw new Error(
                `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const sequenceNum = Number(ScriptNum().decode(sequence));
        const decodedTimelock = bip68.decode(sequenceNum);

        const timelock: RelativeTimelock =
            decodedTimelock.blocks !== undefined
                ? { type: "blocks", value: BigInt(decodedTimelock.blocks) }
                : { type: "seconds", value: BigInt(decodedTimelock.seconds!) };

        const reconstructed = encode({
            timelock,
            ...multisig.params,
        });

        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.CSVMultisig,
            params: {
                timelock,
                ...multisig.params,
            },
            script,
            witnessSize: () => multisig.params.pubkeys.length * 64,
        };
    }

    export function is(tapscript: ArkTapscript<any, any>): tapscript is Type {
        return tapscript.type === TapscriptType.CSVMultisig;
    }
}

/**
 * Combines a condition script with an exit closure. The resulting script requires
 * the condition to be met, followed by the standard exit closure requirements
 * (timelock and signatures).
 */
export namespace ConditionCSVMultisigTapscript {
    export type Type = ArkTapscript<TapscriptType.ConditionCSVMultisig, Params>;

    export type Params = {
        conditionScript: Bytes;
    } & CSVMultisigTapscript.Params;

    export function encode(params: Params): Type {
        const script = new Uint8Array([
            ...params.conditionScript,
            ...Script.encode(["VERIFY"]),
            ...CSVMultisigTapscript.encode(params).script,
        ]);

        return {
            type: TapscriptType.ConditionCSVMultisig,
            params,
            script,
            witnessSize: (conditionSize: number) =>
                conditionSize + params.pubkeys.length * 64,
        };
    }

    export function decode(script: Uint8Array): Type {
        if (script.length === 0) {
            throw new Error("Failed to decode: script is empty");
        }

        const asm = Script.decode(script);

        if (asm.length < 1) {
            throw new Error(`Invalid script: too short (expected at least 1)`);
        }

        let verifyIndex = -1;
        for (let i = asm.length - 1; i >= 0; i--) {
            if (asm[i] === "VERIFY") {
                verifyIndex = i;
            }
        }

        if (verifyIndex === -1) {
            throw new Error("Invalid script: missing VERIFY operation");
        }

        const conditionScript = new Uint8Array(
            Script.encode(asm.slice(0, verifyIndex))
        );
        const csvMultisigScript = new Uint8Array(
            Script.encode(asm.slice(verifyIndex + 1))
        );

        let csvMultisig: CSVMultisigTapscript.Type;
        try {
            csvMultisig = CSVMultisigTapscript.decode(csvMultisigScript);
        } catch (error) {
            throw new Error(
                `Invalid CSV multisig script: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const reconstructed = encode({
            conditionScript,
            ...csvMultisig.params,
        });

        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.ConditionCSVMultisig,
            params: {
                conditionScript,
                ...csvMultisig.params,
            },
            script,
            witnessSize: (conditionSize: number) =>
                conditionSize + csvMultisig.params.pubkeys.length * 64,
        };
    }

    export function is(tapscript: ArkTapscript<any, any>): tapscript is Type {
        return tapscript.type === TapscriptType.ConditionCSVMultisig;
    }
}

/**
 * Combines a condition script with a forfeit closure. The resulting script requires
 * the condition to be met, followed by the standard forfeit closure requirements
 * (multi-signature).
 */
export namespace ConditionMultisigTapscript {
    export type Type = ArkTapscript<TapscriptType.ConditionMultisig, Params>;

    export type Params = {
        conditionScript: Bytes;
    } & MultisigTapscript.Params;

    export function encode(params: Params): Type {
        const script = new Uint8Array([
            ...params.conditionScript,
            ...Script.encode(["VERIFY"]),
            ...MultisigTapscript.encode(params).script,
        ]);

        return {
            type: TapscriptType.ConditionMultisig,
            params,
            script,
            witnessSize: (conditionSize: number) =>
                conditionSize + params.pubkeys.length * 64,
        };
    }

    export function decode(script: Uint8Array): Type {
        if (script.length === 0) {
            throw new Error("Failed to decode: script is empty");
        }

        const asm = Script.decode(script);

        if (asm.length < 1) {
            throw new Error(`Invalid script: too short (expected at least 1)`);
        }

        let verifyIndex = -1;
        for (let i = asm.length - 1; i >= 0; i--) {
            if (asm[i] === "VERIFY") {
                verifyIndex = i;
            }
        }

        if (verifyIndex === -1) {
            throw new Error("Invalid script: missing VERIFY operation");
        }

        const conditionScript = new Uint8Array(
            Script.encode(asm.slice(0, verifyIndex))
        );
        const multisigScript = new Uint8Array(
            Script.encode(asm.slice(verifyIndex + 1))
        );

        let multisig: MultisigTapscript.Type;
        try {
            multisig = MultisigTapscript.decode(multisigScript);
        } catch (error) {
            throw new Error(
                `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const reconstructed = encode({
            conditionScript,
            ...multisig.params,
        });

        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.ConditionMultisig,
            params: {
                conditionScript,
                ...multisig.params,
            },
            script,
            witnessSize: (conditionSize: number) =>
                conditionSize + multisig.params.pubkeys.length * 64,
        };
    }

    export function is(tapscript: ArkTapscript<any, any>): tapscript is Type {
        return tapscript.type === TapscriptType.ConditionMultisig;
    }
}

/**
 * Implements an absolute timelock (CLTV) script combined with a forfeit closure.
 * The script requires waiting until a specific block height/timestamp before the
 * forfeit closure conditions can be met.
 */
export namespace CLTVMultisigTapscript {
    export type Type = ArkTapscript<TapscriptType.CLTVMultisig, Params>;

    export type Params = {
        absoluteTimelock: bigint;
    } & MultisigTapscript.Params;

    export function encode(params: Params): Type {
        const locktime = ScriptNum().encode(params.absoluteTimelock);
        const asm: ScriptType = [locktime, "CHECKLOCKTIMEVERIFY", "DROP"];
        const timelockedScript = Script.encode(asm);

        const script = new Uint8Array([
            ...timelockedScript,
            ...MultisigTapscript.encode(params).script,
        ]);

        return {
            type: TapscriptType.CLTVMultisig,
            params,
            script,
            witnessSize: () => params.pubkeys.length * 64,
        };
    }

    export function decode(script: Uint8Array): Type {
        if (script.length === 0) {
            throw new Error("Failed to decode: script is empty");
        }

        const asm = Script.decode(script);

        if (asm.length < 3) {
            throw new Error(`Invalid script: too short (expected at least 3)`);
        }

        const locktime = asm[0];
        if (typeof locktime === "string" || typeof locktime === "number") {
            throw new Error("Invalid script: expected locktime number");
        }

        if (asm[1] !== "CHECKLOCKTIMEVERIFY" || asm[2] !== "DROP") {
            throw new Error(
                "Invalid script: expected CHECKLOCKTIMEVERIFY DROP"
            );
        }

        const multisigScript = new Uint8Array(Script.encode(asm.slice(3)));
        let multisig: MultisigTapscript.Type;

        try {
            multisig = MultisigTapscript.decode(multisigScript);
        } catch (error) {
            throw new Error(
                `Invalid multisig script: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        const absoluteTimelock = ScriptNum().decode(locktime);

        const reconstructed = encode({
            absoluteTimelock,
            ...multisig.params,
        });

        if (Buffer.compare(reconstructed.script, script) !== 0) {
            throw new Error(
                "Invalid script format: script reconstruction mismatch"
            );
        }

        return {
            type: TapscriptType.CLTVMultisig,
            params: {
                absoluteTimelock,
                ...multisig.params,
            },
            script,
            witnessSize: () => multisig.params.pubkeys.length * 64,
        };
    }

    export function is(tapscript: ArkTapscript<any, any>): tapscript is Type {
        return tapscript.type === TapscriptType.CLTVMultisig;
    }
}
