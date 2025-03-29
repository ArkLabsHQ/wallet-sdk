// This example shows how to create a Virtual Hash Time Lock Contract (VHTLC)
// and how to spend it.
//
// The VHTLC is a contract that allows Bob to claim a coin after 10 blocks if he reveals a secret.
// If Bob doesn't reveal the secret, Alice can spend the VHTLC alone after 10 blocks.
// If Bob and Alice wants to cancel the swap, they can collaborate to spend the VHTLC together.
//
// Usage:
// node examples/vhtlc.js claim (bob reveals the preimage)
// node examples/vhtlc.js refund (alice and bob collaborate to spend the VHTLC)
// node examples/vhtlc.js unilateralRefund (alice spends the VHTLC alone)
//
const {
    InMemoryKey,
    VHTLC,
    addConditionWitness,
    RestArkProvider,
    createVirtualTx,
    networks,
} = require("../dist/index.js");
const { hash160 } = require("@scure/btc-signer/utils");
const { base64, hex } = require("@scure/base");
const { utils } = require("@scure/btc-signer");
const { execSync } = require("child_process");

const SERVER_PUBLIC_KEY = hex.decode(
    "8a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285"
);

const action = process.argv[2];
const arkdExec = process.argv[3] || "docker exec -t arkd";

if (!action || !["claim", "refund", "unilateralRefund"].includes(action)) {
    console.error("Usage: node examples/vhtlc.js <action> [arkdExec]");
    console.error("action: claim | refund | unilateralRefund");
    console.error("arkdExec: docker exec -t arkd | nigiri");
    process.exit(1);
}

// Alice is the vtxo owner, she offers the coin in exchange for the Bob's secret
// to make the swap safe, she funds a VHTLC with Bob's public key as receiver
const alice = InMemoryKey.fromHex(hex.encode(utils.randomPrivateKeyBytes()));
// Bob is the receiver of the VHTLC, he is the one generating the secret
const bob = InMemoryKey.fromHex(hex.encode(utils.randomPrivateKeyBytes()));

const secret = Uint8Array.from("I'm bob secret");
const preimageHash = hash160(secret);

async function main() {
    const chainTip = await fetch(
        "http://localhost:3000/blocks/tip/height"
    ).then((res) => res.json());

    // VHTLC is a Virtual Hash Time Lock Contract, containing 3 spending conditions:
    // 1. Bob can spend the coin alone, if he reveals the preimage
    // 2. 10 blocks after funding, Alice can spend the VHTLC alone
    // 3. Bob and Alice can spend the VHTLC together
    //
    // Because of the nature of Ark, we need six different scripts to implement this behavior.
    //
    // offchain paths:
    //   claim: (Bob + preimage + Ark Server)
    //   refund: (Bob + Alice + Ark Server)
    //   refundWithoutReceiver: (Alice + Ark Server at chainTip + 10 blocks)
    //
    //   refundWithoutReceiver must be locked by an absolute TimeLock
    //   to prevent Alice to double spend the VTXO in case Bob claimed the VHTLC
    //
    // onchain paths:
    //   unilateralClaim: (Bob + preimage after 1 blocks)
    //   unilateralRefund: (Bob + Alice + Ark Server after 2 blocks)
    //   unilateralRefundWithoutReceiver: (Bob + Ark Server after 3 blocks)
    //
    //   onchain paths are locked by relative TimeLocks. Their value determines the priority of the paths.
    //   - unilateralClaim's timelock should be the smaller one, the secret reveal has always max priority.
    //   - unilateralRefund's timelock should be the second smaller one.
    //   - unilateralRefundWithoutReceiver's timelock should be greater than the other two.
    //   thus, we ensure that a claim is always possible before a refund. And a collaborative refund is always possible before an unilateral refund.
    //
    // onchain paths are needed to avoid Bob and Alice to trust the Ark Server
    // if the server is not responsive or malicious, the funds can still be spent.
    //
    const vhtlcScript = new VHTLC.Script({
        preimageHash,
        sender: alice.xOnlyPublicKey(),
        receiver: bob.xOnlyPublicKey(),
        server: SERVER_PUBLIC_KEY,
        refundLocktime: BigInt(chainTip + 10), // 10 blocks from now
        unilateralClaimDelay: {
            type: "blocks",
            value: 10n,
        },
        unilateralRefundDelay: {
            type: "blocks",
            value: 2n,
        },
        unilateralRefundWithoutReceiverDelay: {
            type: "blocks",
            value: 3n,
        },
    });

    const address = vhtlcScript
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("VHTLC Address:", address);

    // Use faucet to fund the VHTLC address using arkdExec
    // in a real scenario, it should be funded by Alice herself
    const fundAmount = 1000;
    await fundAddress(address, fundAmount);

    // Get the virtual coins for the VHTLC address
    const arkProvider = new RestArkProvider("http://localhost:7070");
    const { spendableVtxos } = await arkProvider.getVirtualCoins(address);

    if (spendableVtxos.length === 0) {
        throw new Error("No spendable virtual coins found");
    }

    const vtxo = spendableVtxos[0];

    switch (action) {
        case "claim": {
            const bobVHTLCIdentity = {
                // Signing a VTHLC needs an extra witness element to be added to the PSBT input
                // This witness must satisfy the preimageHash condition
                sign: async (tx, inputIndexes) => {
                    const cpy = tx.clone();
                    // reveal the secret in the PSBT, thus the server can verify the claim script
                    addConditionWitness(0, cpy, [secret]);
                    return bob.sign(cpy, inputIndexes);
                },
                xOnlyPublicKey: bob.xOnlyPublicKey,
                signerSession: bob.signerSession,
            };

            const tx = createVirtualTx(
                [
                    {
                        ...vtxo,
                        tapLeafScript: vhtlcScript.claim(),
                        scripts: vhtlcScript.encode(),
                    },
                ],
                [
                    {
                        address,
                        amount: BigInt(fundAmount),
                    },
                ]
            );

            const signedTx = await bobVHTLCIdentity.sign(tx);
            const txid = await arkProvider.submitVirtualTx(
                base64.encode(signedTx.toPSBT())
            );

            console.log("Successfully claimed VHTLC! Transaction ID:", txid);
            break;
        }
        case "refund": {
            // Create and sign the refund transaction
            const tx = createVirtualTx(
                [
                    {
                        ...vtxo,
                        tapLeafScript: vhtlcScript.refund(),
                        scripts: vhtlcScript.encode(),
                    },
                ],
                [
                    {
                        address,
                        amount: BigInt(fundAmount),
                    },
                ]
            );

            // Alice signs the transaction
            let signedTx = await alice.sign(tx);
            // Bob signs the transaction
            signedTx = await bob.sign(signedTx);
            const txid = await arkProvider.submitVirtualTx(
                base64.encode(signedTx.toPSBT())
            );

            console.log("Successfully refunded VHTLC! Transaction ID:", txid);
            break;
        }
        case "unilateralRefund": {
            // Generate 11 blocks to ensure the locktime period has passed
            execSync(
                `nigiri rpc generatetoaddress 11 $(nigiri rpc getnewaddress)`
            );

            // Create and sign the unilateral refund transaction
            const tx = createVirtualTx(
                [
                    {
                        ...vtxo,
                        tapLeafScript: vhtlcScript.refundWithoutReceiver(),
                        scripts: vhtlcScript.encode(),
                    },
                ],
                [
                    {
                        address,
                        amount: BigInt(fundAmount),
                    },
                ]
            );

            // Alice signs the transaction alone
            const signedTx = await alice.sign(tx);
            const txid = await arkProvider.submitVirtualTx(
                base64.encode(signedTx.toPSBT())
            );

            console.log(
                "Successfully refunded VHTLC alone! Transaction ID:",
                txid
            );
            break;
        }
        default:
            throw new Error(`Unsupported action: ${action}`);
    }
}

async function fundAddress(address, amount) {
    console.log(`\nFunding address with ${amount} sats...`);
    execSync(
        `${arkdExec} ark send --to ${address} --amount ${amount} --password secret`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
}

main().catch(console.error);
