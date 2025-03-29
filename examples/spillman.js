// This example shows how to create a virtual Spillman Channel
//
// The Spillman Taproot Script is a contract that allows two parties to create an unidirectional payment channel.
// Alice updates the channel state by signing virtual transactions without submitting them to the ark Server.
// Bob can close the channel at any time by signing the last virtual tx and submitting it to the ark Server.
//
// Usage:
// node examples/spillman.js
//
const {
    InMemoryKey,
    Wallet,
    RestArkProvider,
    createVirtualTx,
    VtxoScript,
    MultisigTapscript,
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    networks,
} = require("../dist/index.js");
const { base64, hex } = require("@scure/base");
const { utils } = require("@scure/btc-signer");
const { execSync } = require("child_process");

const SERVER_PUBLIC_KEY = hex.decode(
    "8a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285"
);

const arkdExec = process.argv[2] || "docker exec -t arkd";

const alice = InMemoryKey.fromHex(hex.encode(utils.randomPrivateKeyBytes()));
const bob = InMemoryKey.fromHex(hex.encode(utils.randomPrivateKeyBytes()));

console.log("Creating Spillman Channel between Alice and Bob");
console.log("Alice's public key:", hex.encode(alice.xOnlyPublicKey()));
console.log("Bob's public key:", hex.encode(bob.xOnlyPublicKey()));

async function main() {
    console.log("\nInitializing Bob's wallet...");
    const bobWallet = await Wallet.create({
        identity: bob,
        network: "regtest",
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    const aliceWallet = await Wallet.create({
        identity: alice,
        network: "regtest",
        esploraUrl: "http://localhost:3000",
        arkServerUrl: "http://localhost:7070",
    });

    console.log("Fetching current chain tip...");
    const chainTip = await fetch(
        "http://localhost:3000/blocks/tip/height"
    ).then((res) => res.json());
    console.log("Chain tip:", chainTip);

    // offchain paths:
    //   update: (Alice + Bob + Ark Server)
    //   refund: (Alice + Ark Server at chainTip + 10 blocks)
    //
    // onchain paths:
    //   unilateralUpdate: (Alice + Bob after 1 block)
    //   unilateralRefund: (Alice + Bob after 2 blocks)
    //
    //   unilateralUpdate's timelock should be smaller than unilateralRefund's timelock.
    //   this ensures that a unilateralUpdate is always possible before a unilateralRefund.
    //
    const updateScript = MultisigTapscript.encode({
        pubkeys: [alice.xOnlyPublicKey(), bob.xOnlyPublicKey()],
    }).script;

    const refundScript = CLTVMultisigTapscript.encode({
        pubkeys: [alice.xOnlyPublicKey()],
        absoluteTimelock: BigInt(chainTip + 10),
    }).script;

    const unilateralUpdateScript = CSVMultisigTapscript.encode({
        pubkeys: [alice.xOnlyPublicKey(), bob.xOnlyPublicKey()],
        timelock: { type: "blocks", value: 1n },
    }).script;

    const unilateralRefundScript = CSVMultisigTapscript.encode({
        pubkeys: [alice.xOnlyPublicKey()],
        timelock: { type: "blocks", value: 2n },
    }).script;

    const virtualSpillmanChannel = new VtxoScript([
        updateScript,
        refundScript,
        unilateralUpdateScript,
        unilateralRefundScript,
    ]);

    const address = virtualSpillmanChannel
        .address(networks.regtest.hrp, SERVER_PUBLIC_KEY)
        .encode();
    console.log("\nSpillman Channel Address:", address);

    // Use faucet to fund the Spillman Channel address
    // in a real scenario, it should be funded by Alice herself
    const channelCapacity = 10_000;
    await fundAddress(address, channelCapacity);

    // Get the virtual coins for the Spillman Channel address
    console.log("Fetching virtual coins...");
    const arkProvider = new RestArkProvider("http://localhost:7070");
    const { spendableVtxos } = await arkProvider.getVirtualCoins(address);

    if (spendableVtxos.length === 0) {
        throw new Error("No spendable virtual coins found");
    }

    const vtxo = spendableVtxos[0];
    const input = {
        ...vtxo,
        tapLeafScript: virtualSpillmanChannel.findLeaf(
            hex.encode(updateScript)
        ),
        scripts: virtualSpillmanChannel.encode(),
    };

    console.log("Alice's balance:", vtxo.value, "sats");
    console.log("Bob's balance:", "0 sats");

    // Bob's receiving address
    const bobAddress = await bobWallet.getAddress();
    console.log("\nBob's receiving address:", bobAddress.offchain.address);

    // Alice's receiving address
    const aliceAddress = await aliceWallet.getAddress();
    console.log("\nAlice's receiving address:", aliceAddress.offchain.address);

    // Bob has to keep track of the channel states
    // it means he has to store the list of virtual txs signed by Alice
    const bobChannelStates = [];

    console.log("\nStarting channel updates...");
    // Alice sends 1000 to bob
    console.log("Alice sends 1000 sats to Bob");
    const tx1 = createVirtualTx(
        [input],
        [
            {
                address: bobAddress.offchain.address,
                amount: BigInt(1000),
            },
            {
                address: aliceAddress.offchain.address,
                amount: BigInt(channelCapacity - 1000),
            },
        ]
    );
    const signedTx1 = await alice.sign(tx1);
    console.log("Alice signed transaction 1");
    bobChannelStates.push(await bob.sign(signedTx1));
    console.log("Bob signed transaction 1");

    // Alice updates the state, sending 500 sats more to Bob
    console.log("\nAlice sends 500 more sats to Bob");
    const tx2 = createVirtualTx(
        [input],
        [
            {
                address: bobAddress.offchain.address,
                amount: BigInt(1500),
            },
            {
                address: aliceAddress.offchain.address,
                amount: BigInt(channelCapacity - 1500),
            },
        ]
    );
    const signedTx2 = await alice.sign(tx2);
    console.log("Alice signed transaction 2");
    bobChannelStates.push(await bob.sign(signedTx2));
    console.log("Bob signed transaction 2");

    const action = Math.random() > 0.5 ? "close" : "refund";

    if (action === "close") {
        // to close the channel, Alice or Bob can submit the last virtual tx to the server
        console.log("\nClosing channel...");
        const lastState = bobChannelStates[bobChannelStates.length - 1];
        const txid = await arkProvider.submitVirtualTx(
            base64.encode(lastState.toPSBT())
        );
        console.log("Channel closed successfully!");
        console.log("Final transaction ID:", txid);

        console.log("\nFinal Balances:");
        console.log("Alice's final balance:", channelCapacity - 1500, "sats");
        console.log("Bob's final balance:", 1500, "sats");

        console.log("\nChannel Summary:");
        console.log("Initial capacity:", channelCapacity, "sats");
        console.log("Final amount sent to Bob:", 1500, "sats");
        console.log("Number of state updates:", bobChannelStates.length);
    } else {
        execSync(`nigiri rpc generatetoaddress 11 $(nigiri rpc getnewaddress)`);

        console.log("\nRefunding channel...");
        // after 10 blocks, Alice can spend without Bob's signature
        const tx = createVirtualTx(
            [
                {
                    ...input,
                    tapLeafScript: virtualSpillmanChannel.findLeaf(
                        hex.encode(refundScript)
                    ),
                },
            ],
            [
                {
                    address: aliceAddress.offchain.address,
                    amount: BigInt(channelCapacity),
                },
            ]
        );
        const signedTx = await alice.sign(tx);
        console.log("Alice signed the refund transaction");
        const txid = await arkProvider.submitVirtualTx(
            base64.encode(signedTx.toPSBT())
        );
        console.log("Channel refunded successfully!");
        console.log("Final transaction ID:", txid);

        console.log("\nFinal Balances:");
        console.log("Alice's final balance:", channelCapacity, "sats");
        console.log("Bob's final balance:", 0, "sats");
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
