import { expect, describe, it, beforeAll } from "vitest";
import { Transaction, utils } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { execSync } from "child_process";
import {
    IWallet,
    TxType,
    Wallet,
    InMemoryKey,
    VHTLC,
    Identity,
    addConditionWitness,
    RestArkProvider,
    makeVirtualTx,
} from "../src";
import { networks } from "../src/networks";
import { hash160 } from "@scure/btc-signer/utils";

const arkdExec =
    process.env.ARK_ENV === "master" ? "docker exec -t arkd" : "nigiri";

// Deterministic server public key from mnemonic "abandon" x24
const ARK_SERVER_PUBKEY =
    "038a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285";

const X_ONLY_PUBLIC_KEY = hex.decode(ARK_SERVER_PUBKEY).slice(1);

interface TestWallet {
    wallet: IWallet;
    identity: InMemoryKey;
}

function createTestIdentity(): InMemoryKey {
    const privateKeyBytes = utils.randomPrivateKeyBytes();
    const privateKeyHex = hex.encode(privateKeyBytes);
    return InMemoryKey.fromHex(privateKeyHex);
}

async function createTestWallet(): Promise<TestWallet> {
    const identity = createTestIdentity();

    const wallet = await Wallet.create({
        network: "regtest",
        identity,
        arkServerUrl: "http://localhost:7070",
        arkServerPublicKey: ARK_SERVER_PUBKEY,
    });

    return {
        wallet,
        identity,
    };
}

describe("Wallet SDK Integration Tests", () => {
    beforeAll(async () => {
        // Check if there's enough offchain balance before proceeding
        const balanceOutput = execSync(`${arkdExec} ark balance`).toString();
        const balance = JSON.parse(balanceOutput);
        const offchainBalance = balance.offchain_balance.total;

        if (offchainBalance < 210_000) {
            throw new Error(
                'Insufficient offchain balance. Please run "node test/setup.js" first to setup the environment'
            );
        }
    });

    it("should settle a boarding UTXO", { timeout: 60000 }, async () => {
        const alice = await createTestWallet();

        const aliceAddresses = await alice.wallet.getAddress();
        const boardingAddress = aliceAddresses.boarding;
        const offchainAddress = aliceAddresses.offchain;

        // faucet
        execSync(`nigiri faucet ${boardingAddress?.address} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        const settleTxid = await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: offchainAddress!.address,
                    amount: BigInt(100000),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it("should settle a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain
            ?.address;
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        const vtxo = virtualCoins[0];
        expect(vtxo.txid).toBeDefined();

        const settleTxid = await alice.wallet.settle({
            inputs: [vtxo],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(fundAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it(
        "should perform a complete onchain roundtrip payment",
        { timeout: 30000 },
        async () => {
            // Create fresh wallet instances for this test
            const alice = await createTestWallet();
            const bob = await createTestWallet();

            // Get addresses
            const aliceAddress = (await alice.wallet.getAddress()).onchain;
            const bobAddress = (await bob.wallet.getAddress()).onchain;

            // Initial balance check
            const aliceInitialBalance = await alice.wallet.getBalance();
            const bobInitialBalance = await bob.wallet.getBalance();
            expect(aliceInitialBalance.onchain.total).toBe(0);
            expect(bobInitialBalance.onchain.total).toBe(0);

            // Fund Alice's address using nigiri faucet
            const faucetAmountSats = 0.001 * 100_000_000; // Amount in sats
            execSync(`nigiri faucet ${aliceAddress} 0.001`);

            // Wait for the faucet transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Check Alice's balance after funding
            const aliceBalanceAfterFunding = await alice.wallet.getBalance();
            expect(aliceBalanceAfterFunding.onchain.total).toBe(
                faucetAmountSats
            );

            // Send from Alice to Bob
            const sendAmount = 50000; // 0.0005 BTC in sats
            await alice.wallet.sendBitcoin({
                address: bobAddress,
                amount: sendAmount,
                feeRate: 2,
            });

            // Wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Final balance check
            const aliceFinalBalance = await alice.wallet.getBalance();
            const bobFinalBalance = await bob.wallet.getBalance();

            // Verify the transaction was successful
            expect(bobFinalBalance.onchain.total).toBe(sendAmount);
            expect(aliceFinalBalance.onchain.total).toBeLessThan(
                aliceBalanceAfterFunding.onchain.total
            );
        }
    );

    it(
        "should perform a complete offchain roundtrip payment",
        { timeout: 60000 },
        async () => {
            // Create fresh wallet instances for this test
            const alice = await createTestWallet();
            const bob = await createTestWallet();

            // Get addresses
            const aliceOffchainAddress = (await alice.wallet.getAddress())
                .offchain?.address;
            const bobOffchainAddress = (await bob.wallet.getAddress()).offchain
                ?.address;
            expect(aliceOffchainAddress).toBeDefined();
            expect(bobOffchainAddress).toBeDefined();

            // Initial balance check
            const aliceInitialBalance = await alice.wallet.getBalance();
            const bobInitialBalance = await bob.wallet.getBalance();
            expect(aliceInitialBalance.offchain.total).toBe(0);
            expect(bobInitialBalance.offchain.total).toBe(0);

            // Initial virtual coins check
            expect((await alice.wallet.getVtxos()).length).toBe(0);
            expect((await bob.wallet.getVtxos()).length).toBe(0);

            // Use a smaller amount for testing
            const fundAmount = 10000;
            execSync(
                `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Check virtual coins after funding
            const virtualCoins = await alice.wallet.getVtxos();

            // Verify we have a pending virtual coin
            expect(virtualCoins).toHaveLength(1);
            const vtxo = virtualCoins[0];
            expect(vtxo.txid).toBeDefined();
            expect(vtxo.value).toBe(fundAmount);
            expect(vtxo.virtualStatus.state).toBe("pending");

            // Check Alice's balance after funding
            const aliceBalanceAfterFunding = await alice.wallet.getBalance();
            expect(aliceBalanceAfterFunding.offchain.total).toBe(fundAmount);

            // Send from Alice to Bob offchain
            const sendAmount = 5000; // 5k sats instead of 50k
            const fee = 174; // Fee for offchain virtual TX
            await alice.wallet.sendBitcoin(
                {
                    address: bobOffchainAddress!,
                    amount: sendAmount,
                },
                false
            );

            // Wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Final balance check
            const aliceFinalBalance = await alice.wallet.getBalance();
            const bobFinalBalance = await bob.wallet.getBalance();
            // Verify the transaction was successful
            expect(bobFinalBalance.offchain.total).toBe(sendAmount);
            expect(aliceFinalBalance.offchain.total).toBe(
                fundAmount - sendAmount - fee
            );
        }
    );

    it("should return transaction history", { timeout: 60000 }, async () => {
        const alice = await createTestWallet();
        const bob = await createTestWallet();

        // Get addresses
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain
            ?.address;
        const bobOffchainAddress = (await bob.wallet.getAddress()).offchain
            ?.address;
        expect(aliceOffchainAddress).toBeDefined();
        expect(bobOffchainAddress).toBeDefined();

        // Alice onboarding
        const boardingAmount = 10000;
        const boardingAddress = (await alice.wallet.getAddress()).boarding
            ?.address;
        execSync(
            `nigiri faucet ${boardingAddress} ${boardingAmount * 0.00000001}`
        );

        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Get boarding utxos
        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(boardingAmount),
                },
            ],
        });

        // Wait for the transaction to be processed
        execSync("nigiri rpc generatetoaddress 1 $(nigiri rpc getnewaddress)");

        // Check history before sending to bob
        let aliceHistory = await alice.wallet.getTransactionHistory();
        expect(aliceHistory).toBeDefined();
        expect(aliceHistory.length).toBe(1); // should have boarding tx

        // Check boarding transaction
        expect(aliceHistory[0].type).toBe(TxType.TxReceived);
        expect(aliceHistory[0].amount).toBe(boardingAmount);
        expect(aliceHistory[0].settled).toBe(true);
        expect(aliceHistory[0].key.boardingTxid.length).toBeGreaterThan(0);

        // Send from Alice to Bob offchain
        const sendAmount = 5000;
        const fee = 174; // Fee for offchain virtual TX
        const sendTxid = await alice.wallet.sendBitcoin(
            {
                address: bobOffchainAddress!,
                amount: sendAmount,
            },
            false
        );

        // Wait for the transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Check final balances
        const aliceFinalBalance = await alice.wallet.getBalance();
        const bobFinalBalance = await bob.wallet.getBalance();
        expect(bobFinalBalance.offchain.total).toBe(sendAmount);
        expect(aliceFinalBalance.offchain.total).toBe(
            boardingAmount - sendAmount - fee
        );

        // Get transaction history for Alice
        aliceHistory = await alice.wallet.getTransactionHistory();
        expect(aliceHistory).toBeDefined();
        expect(aliceHistory.length).toBe(2); // Should have at least receive and send transactions

        const [sendTx, fundingTx] = aliceHistory;

        // Check funding transaction
        expect(fundingTx.type).toBe(TxType.TxReceived);
        expect(fundingTx.amount).toBe(boardingAmount);
        expect(fundingTx.settled).toBe(true);
        expect(fundingTx.key.boardingTxid.length).toBeGreaterThan(0);

        // Check send transaction
        expect(sendTx.type).toBe(TxType.TxSent);
        expect(sendTx.amount).toBe(sendAmount + fee);
        expect(sendTx.key.redeemTxid.length).toBeGreaterThan(0);
        expect(sendTx.key.redeemTxid).toBe(sendTxid);

        // Get transaction history for Bob
        const bobHistory = await bob.wallet.getTransactionHistory();
        expect(bobHistory).toBeDefined();
        expect(bobHistory.length).toBe(1); // Should have at least the receive transaction

        // Verify Bob's receive transaction
        const [bobsReceiveTx] = bobHistory;
        expect(bobsReceiveTx.type).toBe(TxType.TxReceived);
        expect(bobsReceiveTx.amount).toBe(sendAmount);
        expect(bobsReceiveTx.settled).toBe(false);
        expect(bobsReceiveTx.key.redeemTxid.length).toBeGreaterThan(0);

        // Bob settles the received VTXO
        let bobInputs = await bob.wallet.getVtxos();
        await bob.wallet.settle({
            inputs: bobInputs,
            outputs: [
                {
                    address: bobOffchainAddress!,
                    amount: BigInt(sendAmount),
                },
            ],
        });

        // Verify Bob's history
        const bobHistoryAfterSettling =
            await bob.wallet.getTransactionHistory();
        expect(bobHistoryAfterSettling).toBeDefined();
        expect(bobHistoryAfterSettling.length).toBe(1);
        const [bobsReceiveTxAfterSettling] = bobHistoryAfterSettling;
        expect(bobsReceiveTxAfterSettling.type).toBe(TxType.TxReceived);
        expect(bobsReceiveTxAfterSettling.amount).toBe(sendAmount);
        expect(bobsReceiveTxAfterSettling.settled).toBe(true);

        // Bob does a collaborative exit to alice's boarding address
        bobInputs = await bob.wallet.getVtxos();
        const amount = bobInputs.reduce((acc, input) => acc + input.value, 0);
        const bobExitTxid = await bob.wallet.settle({
            inputs: bobInputs,
            outputs: [
                {
                    address: boardingAddress!,
                    amount: BigInt(amount),
                },
            ],
        });

        expect(bobExitTxid).toBeDefined();

        // Check bob's history
        const bobHistoryAfterExit = await bob.wallet.getTransactionHistory();
        expect(bobHistoryAfterExit).toBeDefined();
        expect(bobHistoryAfterExit.length).toBe(2);
        const [bobsExitTx] = bobHistoryAfterExit;
        expect(bobsExitTx.type).toBe(TxType.TxSent);
        expect(bobsExitTx.amount).toBe(amount);

        // Check alice's history
        const aliceHistoryAfterExit =
            await alice.wallet.getTransactionHistory();
        expect(aliceHistoryAfterExit).toBeDefined();
        expect(aliceHistoryAfterExit.length).toBe(3);
        const [alicesExitTx] = aliceHistoryAfterExit;
        expect(alicesExitTx.type).toBe(TxType.TxReceived);
        expect(alicesExitTx.amount).toBe(amount);
    });

    it("should be able to claim a vthlc", { timeout: 60000 }, async () => {
        const alice = createTestIdentity();
        const bob = createTestIdentity();

        const preimage = Uint8Array.from("preimage");
        const preimageHash = hash160(preimage);

        const vhtlcScript = new VHTLC.Script({
            preimageHash,
            sender: alice.xOnlyPublicKey(),
            receiver: bob.xOnlyPublicKey(),
            server: X_ONLY_PUBLIC_KEY,
            refundLocktime: BigInt(100),
            unilateralClaimDelay: {
                type: "blocks",
                value: 100n,
            },
            unilateralRefundDelay: {
                type: "blocks",
                value: 50n,
            },
            unilateralRefundWithoutReceiverDelay: {
                type: "blocks",
                value: 50n,
            },
        });

        const address = vhtlcScript
            .address(networks.regtest.ark, X_ONLY_PUBLIC_KEY)
            .encode();

        // fund the vhtlc address
        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${address} --amount ${fundAmount} --password secret`
        );

        // bob special identity to sign with the preimage
        const bobVHTLCIdentity: Identity = {
            sign: async (tx: Transaction, inputIndexes?: number[]) => {
                const cpy = tx.clone();
                addConditionWitness(0, cpy, [preimage]);
                return bob.sign(cpy, inputIndexes);
            },
            xOnlyPublicKey: bob.xOnlyPublicKey,
            signerSession: bob.signerSession,
        };

        const arkProvider = new RestArkProvider("http://localhost:7070");
        const { spendableVtxos } = await arkProvider.getVirtualCoins(address);
        expect(spendableVtxos).toHaveLength(1);
        const vtxo = spendableVtxos[0];

        const tx = makeVirtualTx(
            [
                {
                    ...vtxo,
                    ...vhtlcScript.claim(),
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
        expect(txid).toBeDefined();
    });
});
