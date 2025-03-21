import { describe, it, expect } from "vitest";
import {
    MultisigTapscript,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
} from "../src/script/tapscript";
import { Script } from "@scure/btc-signer/script";
import { hex } from "@scure/base";

const exPubKey1 = Buffer.from(
    "f8352deebdf5658d95875d89656112b1dd150f176c702eea4f91a91527e48e26",
    "hex"
);
const exPubKey2 = Buffer.from(
    "fc68d5ea9279cc9d2c57e6885e21bbaee9c3aec85089f1d6c705c017d321ea84",
    "hex"
);
const exHash = Buffer.from("628850CB844FE63C308C62AFC8BC5351F1952A7F", "hex");

describe("MultisigTapscript", () => {
    it("should encode and decode single key multisig", () => {
        const params = {
            pubkeys: [exPubKey1],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = MultisigTapscript.encode(params);
        const decoded = MultisigTapscript.decode(encoded.script);

        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
        expect(decoded.params.type).toBe(params.type);
    });

    it("should encode and decode 2-of-2 multisig", () => {
        const params = {
            pubkeys: [exPubKey1, exPubKey2],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = MultisigTapscript.encode(params);
        const decoded = MultisigTapscript.decode(encoded.script);

        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
        expect(decoded.params.type).toBe(params.type);
    });

    it("should fail on empty script", () => {
        expect(() => MultisigTapscript.decode(new Uint8Array())).toThrow(
            "Failed to decode: script is empty"
        );
    });

    it("should fail on invalid pubkey length", () => {
        const invalidPubkey = Buffer.from("invalid", "utf8");
        expect(() =>
            MultisigTapscript.encode({
                pubkeys: [invalidPubkey],
                type: MultisigTapscript.MultisigType.CHECKSIG,
            })
        ).toThrow("Invalid pubkey length: expected 32, got 7");
    });
});

describe("CSVMultisigTapscript", () => {
    it("should encode and decode with blocks timelock", () => {
        const params: CSVMultisigTapscript.Params = {
            timelock: {
                type: "blocks",
                value: BigInt(144),
            },
            pubkeys: [exPubKey1],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = CSVMultisigTapscript.encode(params);
        const decoded = CSVMultisigTapscript.decode(encoded.script);
        expect(decoded.params.timelock).toEqual(params.timelock);
        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
    });

    it("should encode and decode with seconds timelock", () => {
        const params = {
            timelock: {
                type: "seconds" as const,
                value: BigInt(512 * 4),
            },
            pubkeys: [exPubKey1, exPubKey2],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = CSVMultisigTapscript.encode(params);
        const decoded = CSVMultisigTapscript.decode(encoded.script);

        expect(decoded.params.timelock).toEqual(params.timelock);
        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
    });

    it("should fail on empty script", () => {
        expect(() => CSVMultisigTapscript.decode(new Uint8Array())).toThrow(
            "Failed to decode: script is empty"
        );
    });

    it("should fail on too short script in CSVMultisig", () => {
        const shortScript = new Uint8Array([0x01, 0x02]); // Just 2 bytes
        expect(() => CSVMultisigTapscript.decode(shortScript)).toThrow(
            "Invalid script: too short (expected at least 3)"
        );
    });
});

describe("CLTVMultisigTapscript", () => {
    it("should encode and decode with absolute timelock", () => {
        const params = {
            absoluteTimelock: BigInt(1687459200), // Some timestamp
            pubkeys: [exPubKey1],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = CLTVMultisigTapscript.encode(params);
        const decoded = CLTVMultisigTapscript.decode(encoded.script);

        expect(decoded.params.absoluteTimelock).toBe(params.absoluteTimelock);
        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
    });

    it("should fail on empty script", () => {
        expect(() => CLTVMultisigTapscript.decode(new Uint8Array())).toThrow(
            "Failed to decode: script is empty"
        );
    });

    it("should fail on too short script in CLTVMultisig", () => {
        const shortScript = new Uint8Array([0x01, 0x02]); // Just 2 bytes
        expect(() => CLTVMultisigTapscript.decode(shortScript)).toThrow(
            "Invalid script: too short (expected at least 3)"
        );
    });
});

describe("ConditionCSVMultisigTapscript", () => {
    it("should encode and decode with condition", () => {
        const condition = Script.encode([1]);
        const params: ConditionCSVMultisigTapscript.Params = {
            conditionScript: condition,
            timelock: {
                type: "blocks",
                value: BigInt(144),
            },
            pubkeys: [exPubKey1],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = ConditionCSVMultisigTapscript.encode(params);
        const decoded = ConditionCSVMultisigTapscript.decode(encoded.script);

        expect(decoded.params.conditionScript).toEqual(params.conditionScript);
        expect(decoded.params.timelock).toEqual(params.timelock);
        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
    });

    it("should fail on empty script", () => {
        const shortScript = new Uint8Array([]); // Empty script
        expect(() => ConditionCSVMultisigTapscript.decode(shortScript)).toThrow(
            "Failed to decode: script is empty"
        );
    });
});

describe("ConditionMultisigTapscript", () => {
    it("should encode and decode with hash condition", () => {
        const condition = Script.encode(["SHA256", exHash, "EQUAL"]);
        const params: ConditionMultisigTapscript.Params = {
            conditionScript: condition,
            pubkeys: [exPubKey1, exPubKey2],
            type: MultisigTapscript.MultisigType.CHECKSIG,
        };

        const encoded = ConditionMultisigTapscript.encode(params);
        const decoded = ConditionMultisigTapscript.decode(encoded.script);

        expect(decoded.params.conditionScript).toEqual(params.conditionScript);
        expect(decoded.params.pubkeys.map(hex.encode)).toEqual(
            params.pubkeys.map(hex.encode)
        );
    });

    it("should fail on empty script", () => {
        expect(() =>
            ConditionMultisigTapscript.decode(new Uint8Array())
        ).toThrow("Failed to decode: script is empty");
    });
});
