import { expect, describe, it, beforeAll } from "vitest";
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { execSync } from "child_process";
import {
    TxType,
    VHTLC,
    Identity,
    RestIndexerProvider,
    RestArkProvider,
    ArkNote,
    CSVMultisigTapscript,
    buildOffchainTx,
    ConditionWitness,
    setArkPsbtField,
} from "../../src";
import { networks } from "../../src/networks";
import { hash160 } from "@scure/btc-signer/utils";
import {
    arkdExec,
    X_ONLY_PUBLIC_KEY,
    createTestIdentity,
    createTestWallet,
} from "./utils";

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
        execSync(`nigiri faucet ${boardingAddress} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        const settleTxid = await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: offchainAddress!,
                    amount: BigInt(100000),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it("should settle a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
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
                .offchain;
            const bobOffchainAddress = (await bob.wallet.getAddress()).offchain;
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

            // Verify we have a preconfirmed virtual coin
            expect(virtualCoins).toHaveLength(1);
            const vtxo = virtualCoins[0];
            expect(vtxo.txid).toBeDefined();
            expect(vtxo.value).toBe(fundAmount);
            expect(vtxo.virtualStatus.state).toBe("preconfirmed");

            // Check Alice's balance after funding
            const aliceBalanceAfterFunding = await alice.wallet.getBalance();
            expect(aliceBalanceAfterFunding.offchain.total).toBe(fundAmount);

            // Send from Alice to Bob offchain
            const sendAmount = 5000; // 5k sats instead of 50k
            await alice.wallet.sendBitcoin({
                address: bobOffchainAddress!,
                amount: sendAmount,
            });

            // Wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Final balance check
            const aliceFinalBalance = await alice.wallet.getBalance();
            const bobFinalBalance = await bob.wallet.getBalance();
            // Verify the transaction was successful
            expect(bobFinalBalance.offchain.total).toBe(sendAmount);
            expect(aliceFinalBalance.offchain.total).toBe(
                fundAmount - sendAmount
            );
        }
    );

    it("should return transaction history", { timeout: 60000 }, async () => {
        const alice = await createTestWallet();
        const bob = await createTestWallet();

        // Get addresses
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
        const bobOffchainAddress = (await bob.wallet.getAddress()).offchain;
        expect(aliceOffchainAddress).toBeDefined();
        expect(bobOffchainAddress).toBeDefined();

        // Alice onboarding
        const boardingAmount = 10000;
        const boardingAddress = (await alice.wallet.getAddress()).boarding;
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
        await new Promise((resolve) => setTimeout(resolve, 2000));

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
        const sendTxid = await alice.wallet.sendBitcoin({
            address: bobOffchainAddress!,
            amount: sendAmount,
        });

        // Wait for the transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Check final balances
        const aliceFinalBalance = await alice.wallet.getBalance();
        const bobFinalBalance = await bob.wallet.getBalance();
        expect(bobFinalBalance.offchain.total).toBe(sendAmount);
        expect(aliceFinalBalance.offchain.total).toBe(
            boardingAmount - sendAmount
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
        expect(sendTx.amount).toBe(sendAmount);
        expect(sendTx.key.arkTxid.length).toBeGreaterThan(0);
        expect(sendTx.key.arkTxid).toBe(sendTxid);

        // Get transaction history for Bob
        const bobHistory = await bob.wallet.getTransactionHistory();
        expect(bobHistory).toBeDefined();
        expect(bobHistory.length).toBe(1); // Should have at least the receive transaction

        // Verify Bob's receive transaction
        const [bobsReceiveTx] = bobHistory;
        expect(bobsReceiveTx.type).toBe(TxType.TxReceived);
        expect(bobsReceiveTx.amount).toBe(sendAmount);
        expect(bobsReceiveTx.settled).toBe(false);
        expect(bobsReceiveTx.key.arkTxid.length).toBeGreaterThan(0);

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

    it("should claim a VHTLC", { timeout: 60000 }, async () => {
        const alice = createTestIdentity();
        const bob = createTestIdentity();

        const preimage = new TextEncoder().encode("preimage");
        const preimageHash = hash160(preimage);

        const vhtlcScript = new VHTLC.Script({
            preimageHash,
            sender: alice.xOnlyPublicKey(),
            receiver: bob.xOnlyPublicKey(),
            server: X_ONLY_PUBLIC_KEY,
            refundLocktime: BigInt(1000),
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
            .address(networks.regtest.hrp, X_ONLY_PUBLIC_KEY)
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
                setArkPsbtField(cpy, 0, ConditionWitness, [preimage]);
                return bob.sign(cpy, inputIndexes);
            },
            xOnlyPublicKey: bob.xOnlyPublicKey,
            signerSession: bob.signerSession,
        };

        const arkProvider = new RestArkProvider("http://localhost:7070");
        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const spendableVtxos = await indexerProvider.getVtxos({
            addresses: [address],
            spendableOnly: true,
        });
        expect(spendableVtxos).toHaveLength(1);

        const infos = await arkProvider.getInfo();
        const serverUnrollScript = CSVMultisigTapscript.encode({
            timelock: {
                type: infos.unilateralExitDelay < 512 ? "blocks" : "seconds",
                value: infos.unilateralExitDelay,
            },
            pubkeys: [X_ONLY_PUBLIC_KEY],
        });

        const vtxo = spendableVtxos[0];

        const { virtualTx, checkpoints } = buildOffchainTx(
            [
                {
                    ...vtxo,
                    tapLeafScript: vhtlcScript.claim(),
                    tapTree: vhtlcScript.encode(),
                },
            ],
            [
                {
                    script: vhtlcScript.pkScript,
                    amount: BigInt(fundAmount),
                },
            ],
            serverUnrollScript
        );

        const signedVirtualTx = await bobVHTLCIdentity.sign(virtualTx);
        const { arkTxid, finalArkTx, signedCheckpointTxs } =
            await arkProvider.submitTx(
                base64.encode(signedVirtualTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT()))
            );

        expect(arkTxid).toBeDefined();
        expect(finalArkTx).toBeDefined();
        expect(signedCheckpointTxs).toBeDefined();
        expect(signedCheckpointTxs.length).toBe(checkpoints.length);

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c), {
                    allowUnknown: true,
                });
                const signedCheckpoint = await bobVHTLCIdentity.sign(tx, [0]);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    });

    it.skip(
        "should be able to unilateral exit VTXO",
        { timeout: 60000 },
        async () => {
            const alice = await createTestWallet();

            const aliceAddresses = await alice.wallet.getAddress();
            const boardingAddress = aliceAddresses.boarding;
            const offchainAddress = aliceAddresses.offchain;

            // faucet
            execSync(`nigiri faucet ${boardingAddress} 0.0001`);

            await new Promise((resolve) => setTimeout(resolve, 5000));

            const boardingInputs = await alice.wallet.getBoardingUtxos();
            expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

            await alice.wallet.settle({
                inputs: boardingInputs,
                outputs: [
                    {
                        address: offchainAddress!,
                        amount: BigInt(10000),
                    },
                ],
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const virtualCoins = await alice.wallet.getVtxos();
            expect(virtualCoins).toHaveLength(1);
            const vtxo = virtualCoins[0];
            expect(vtxo.txid).toBeDefined();
            await alice.wallet.exit([{ txid: vtxo.txid, vout: vtxo.vout }]);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const virtualCoinsAfterExit = await alice.wallet.getVtxos();
            expect(virtualCoinsAfterExit).toHaveLength(0);
        }
    );

    it("should redeem a note", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;

        const arknote = execSync(
            `${arkdExec} arkd wallet note --amount ${fundAmount}`
        )
            .toString()
            .replace(/\n/g, "");

        const settleTxid = await alice.wallet.settle({
            inputs: [ArkNote.fromString(arknote)],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(fundAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        expect(virtualCoins[0].value).toBe(fundAmount);
    });

    it("should settle a recoverable VTXO", { timeout: 60000 }, async () => {
        const alice = await createTestWallet();
        const aliceAddresses = await alice.wallet.getAddress();
        const boardingAddress = aliceAddresses.boarding;
        const aliceOffchainAddress = aliceAddresses.offchain;
        expect(aliceOffchainAddress).toBeDefined();

        // faucet
        execSync(`nigiri faucet ${boardingAddress} 0.001`);

        await new Promise((resolve) => setTimeout(resolve, 5000));

        const boardingInputs = await alice.wallet.getBoardingUtxos();
        expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

        await alice.wallet.settle({
            inputs: boardingInputs,
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(100_000),
                },
            ],
        });

        // give some time for the server to be swept
        await new Promise((resolve) => setTimeout(resolve, 10000));

        const vtxos = await alice.wallet.getVtxos({
            withSpendableInSettlement: false,
        });
        expect(vtxos).toHaveLength(1);
        const vtxo = vtxos[0];
        expect(vtxo.txid).toBeDefined();
        expect(vtxo.virtualStatus.state).toBe("settled");

        // generate 25 blocks to make the vtxo swept (expiry set to 20 blocks)
        execSync(`nigiri rpc generatetoaddress 25 $(nigiri rpc getnewaddress)`);

        await new Promise((resolve) => setTimeout(resolve, 20_000));

        const vtxosAfterSweep = await alice.wallet.getVtxos({
            withSpendableInSettlement: true,
        });
        expect(vtxosAfterSweep).toHaveLength(1);
        const vtxoAfterSweep = vtxosAfterSweep[0];
        expect(vtxoAfterSweep.txid).toBe(vtxo.txid);
        expect(vtxoAfterSweep.virtualStatus.state).toBe("swept");
        expect(vtxoAfterSweep.spentBy).toBe("");

        const settleTxid = await alice.wallet.settle({
            inputs: [vtxo],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(100_000),
                },
            ],
        });

        expect(settleTxid).toBeDefined();
    });

    it("should send subdust amount", { timeout: 60000 }, async () => {
        const alice = await createTestWallet();
        const bob = await createTestWallet();

        const aliceAddresses = await alice.wallet.getAddress();
        const bobAddresses = await bob.wallet.getAddress();

        const fundAmount = 10_000;
        execSync(
            `${arkdExec} ark send --to ${aliceAddresses.offchain} --amount ${fundAmount} --password secret`
        );

        // alice should send offchain tx with subdust output
        await alice.wallet.sendBitcoin({
            address: bobAddresses.offchain!,
            amount: 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // bob should have 1 sat in offchain balance
        const bobBalance = await bob.wallet.getBalance();
        expect(bobBalance.offchain.total).toBe(1);

        // bob shouldn't be able to send offchain tx with subdust output
        await expect(
            bob.wallet.sendBitcoin({
                address: bobAddresses.offchain!,
                amount: 1,
            })
        ).rejects.toThrow("Insufficient funds");

        // bob shouldn't be able to settle cause the total amount is less than the dust amount
        await expect(bob.wallet.settle()).rejects.toThrow();

        await alice.wallet.sendBitcoin({
            address: bobAddresses.offchain!,
            amount: fundAmount - 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // now bob should be able to settle
        await bob.wallet.settle();
    });
});
