import { Wallet, InMemoryKey } from '../src'
import { expect, describe, it, beforeAll } from 'vitest'
import { utils } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { execSync } from 'child_process'
import { TxType } from '../src/core/wallet'

const arkdExec = process.env.ARK_ENV === 'master' ? 'docker exec -t arkd' : 'nigiri'

// Deterministic server public key from mnemonic "abandon" x24
const ARK_SERVER_PUBKEY = '038a9bbb1fb2aa92b9557dd0b39a85f31d204f58b41c62ea112d6ad148a9881285'
const ARK_SERVER_XONLY_PUBKEY = ARK_SERVER_PUBKEY.slice(2)

interface TestWallet {
  wallet: Wallet
  privateKeyHex: string
}

function createTestWallet(): TestWallet {
  const privateKeyBytes = utils.randomPrivateKeyBytes()
  const privateKeyHex = hex.encode(privateKeyBytes)
  const identity = InMemoryKey.fromHex(privateKeyHex)

  const wallet = new Wallet({
    network: 'regtest',
    identity,
    arkServerUrl: 'http://localhost:7070',
    arkServerPublicKey: ARK_SERVER_XONLY_PUBKEY
  })

  return {
    wallet,
    privateKeyHex
  }
}

describe('Wallet SDK Integration Tests', () => {
  beforeAll(async () => {
    // Check if there's enough offchain balance before proceeding
    const balanceOutput = execSync(`${arkdExec} ark balance`).toString()
    const balance = JSON.parse(balanceOutput)
    const offchainBalance = balance.offchain_balance.total

    if (offchainBalance < 210_000) {
      throw new Error('Insufficient offchain balance. Please run "node test/setup.js" first to setup the environment')
    }
  })

  it('should settle a boarding UTXO', { timeout: 60000}, async () => {
    const alice = createTestWallet()

    const aliceAddresses = alice.wallet.getAddress()
    const boardingAddress = aliceAddresses.boarding
    const offchainAddress = aliceAddresses.offchain

    // faucet 
    execSync(`nigiri faucet ${boardingAddress?.address} 0.001`) 

    await new Promise(resolve => setTimeout(resolve, 5000))

    const boardingInputs = await alice.wallet.getBoardingUtxos()
    expect(boardingInputs.length).toBeGreaterThanOrEqual(1)
    

    const settleTxid = await alice.wallet.settle({
      inputs: boardingInputs,
      outputs: [{
        address: offchainAddress!.address,
        amount: BigInt(100000)
      }]
    })

    expect(settleTxid).toBeDefined()    
  })

  it('should settle a VTXO', { timeout: 60000}, async () => {
    // Create fresh wallet instance for this test
    const alice = createTestWallet()
    const aliceOffchainAddress = alice.wallet.getAddress().offchain?.address
    expect(aliceOffchainAddress).toBeDefined()

    const fundAmount = 1000 
    execSync(`${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const virtualCoins = await alice.wallet.getVtxos()
    expect(virtualCoins).toHaveLength(1)
    const vtxo = virtualCoins[0]
    expect(vtxo.outpoint.txid).toBeDefined()

    const settleTxid = await alice.wallet.settle({
      inputs: [vtxo],
      outputs: [{
        address: aliceOffchainAddress!,
        amount: BigInt(fundAmount)
      }]
    })

    expect(settleTxid).toBeDefined()
  })

  it('should perform a complete onchain roundtrip payment', { timeout: 30000 }, async () => {
    // Create fresh wallet instances for this test
    const alice = createTestWallet()
    const bob = createTestWallet()

    // Get addresses
    const aliceAddress = alice.wallet.getAddress().onchain
    const bobAddress = bob.wallet.getAddress().onchain

    // Initial balance check
    const aliceInitialBalance = await alice.wallet.getBalance()
    const bobInitialBalance = await bob.wallet.getBalance()
    expect(aliceInitialBalance.onchain.total).toBe(0)
    expect(bobInitialBalance.onchain.total).toBe(0)

    // Fund Alice's address using nigiri faucet
    const faucetAmountSats = 0.001 * 100_000_000 // Amount in sats
    execSync(`nigiri faucet ${aliceAddress} 0.001`)

    // Wait for the faucet transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Check Alice's balance after funding
    const aliceBalanceAfterFunding = await alice.wallet.getBalance()
    expect(aliceBalanceAfterFunding.onchain.total).toBe(faucetAmountSats)

    // Send from Alice to Bob
    const sendAmount = 50000 // 0.0005 BTC in sats
    await alice.wallet.sendBitcoin({
      address: bobAddress,
      amount: sendAmount,
      feeRate: 2
    })

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Final balance check
    const aliceFinalBalance = await alice.wallet.getBalance()
    const bobFinalBalance = await bob.wallet.getBalance()
    
    // Verify the transaction was successful
    expect(bobFinalBalance.onchain.total).toBe(sendAmount)
    expect(aliceFinalBalance.onchain.total).toBeLessThan(aliceBalanceAfterFunding.onchain.total)
  })

  it('should perform a complete offchain roundtrip payment', { timeout: 60000 }, async () => {
    // Create fresh wallet instances for this test
    const alice = createTestWallet()
    const bob = createTestWallet()

    // Get addresses
    const aliceOffchainAddress = alice.wallet.getAddress().offchain?.address
    const bobOffchainAddress = bob.wallet.getAddress().offchain?.address
    expect(aliceOffchainAddress).toBeDefined()
    expect(bobOffchainAddress).toBeDefined()

    // Initial balance check
    const aliceInitialBalance = await alice.wallet.getBalance()
    const bobInitialBalance = await bob.wallet.getBalance()
    expect(aliceInitialBalance.offchain.total).toBe(0)
    expect(bobInitialBalance.offchain.total).toBe(0)

    // Initial virtual coins check
    expect((await alice.wallet.getVirtualCoins()).length).toBe(0)
    expect((await bob.wallet.getVirtualCoins()).length).toBe(0)

    // Use a smaller amount for testing
    const fundAmount = 10000 
    execSync(`${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`)

    await new Promise(resolve => setTimeout(resolve, 1000))

    // Check virtual coins after funding
    const virtualCoins = await alice.wallet.getVirtualCoins()

    // Verify we have a pending virtual coin
    expect(virtualCoins).toHaveLength(1)
    const vtxo = virtualCoins[0]
    expect(vtxo.txid).toBeDefined()
    expect(vtxo.value).toBe(fundAmount)
    expect(vtxo.virtualStatus.state).toBe('pending')

    // Check Alice's balance after funding
    const aliceBalanceAfterFunding = await alice.wallet.getBalance()
    expect(aliceBalanceAfterFunding.offchain.total).toBe(fundAmount)

    // Send from Alice to Bob offchain
    const sendAmount = 5000 // 5k sats instead of 50k
    const fee = 174 // Fee for offchain virtual TX
    await alice.wallet.sendBitcoin({
      address: bobOffchainAddress!,
      amount: sendAmount,
    }, false)

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 500))

    // Final balance check
    const aliceFinalBalance = await alice.wallet.getBalance()
    const bobFinalBalance = await bob.wallet.getBalance()
    // Verify the transaction was successful
    expect(bobFinalBalance.offchain.total).toBe(sendAmount)
    expect(aliceFinalBalance.offchain.total).toBe(fundAmount - sendAmount - fee)
  })

  it('should return transaction history', { timeout: 60000}, async () => {
    // Create fresh wallet instances for this test
    const alice = createTestWallet()
    const bob = createTestWallet()

    // Get addresses
    const aliceOffchainAddress = alice.wallet.getAddress().offchain?.address
    const bobOffchainAddress = bob.wallet.getAddress().offchain?.address
    expect(aliceOffchainAddress).toBeDefined()
    expect(bobOffchainAddress).toBeDefined()

    // Initial balance check
    const aliceInitialBalance = await alice.wallet.getBalance()
    const bobInitialBalance = await bob.wallet.getBalance()
    expect(aliceInitialBalance.offchain.total).toBe(0)
    expect(bobInitialBalance.offchain.total).toBe(0)

    // Initial virtual coins check
    expect((await alice.wallet.getVirtualCoins()).length).toBe(0)
    expect((await bob.wallet.getVirtualCoins()).length).toBe(0)

    // Alice onboarding
    const boardingAmount = 10000
    const boardingAddress = alice.wallet.getAddress().boarding?.address
    execSync(`nigiri faucet ${boardingAddress} ${boardingAmount * 0.00000001}`)

    await new Promise(resolve => setTimeout(resolve, 5000))

    // Get boarding utxos
    const boardingInputs = await alice.wallet.getBoardingUtxos()
    expect(boardingInputs.length).toBeGreaterThanOrEqual(1)

    await alice.wallet.settle({
      inputs: boardingInputs,
      outputs: [{
        address: aliceOffchainAddress!,
        amount: BigInt(boardingAmount)
      }]
    })

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Check virtual coins after funding
    const virtualCoins = await alice.wallet.getVirtualCoins()
    expect(virtualCoins).toHaveLength(1)
    const vtxo = virtualCoins[0]
    expect(vtxo.txid).toBeDefined()
    expect(vtxo.value).toBe(boardingAmount)
    expect(vtxo.virtualStatus.state).toBe('settled')

    // Check Alice's balance after funding
    const aliceBalanceAfterFunding = await alice.wallet.getBalance()
    expect(aliceBalanceAfterFunding.offchain.total).toBe(boardingAmount)

    // Check history before sending to bob
    let aliceHistory = await alice.wallet.getTransactionHistory()
    expect(aliceHistory).toBeDefined()
    expect(aliceHistory.length).toBe(1) // Should have at least receive and send transactions

    // Check funding transaction
    expect(aliceHistory[0].type).toBe(TxType.TxReceived)
    expect(aliceHistory[0].amount).toBe(boardingAmount)
    expect(aliceHistory[0].settled).toBe(true)
    expect(aliceHistory[0].key.boardingTxid.length).toBeGreaterThan(0)

    // Send from Alice to Bob offchain
    const sendAmount = 5000
    const fee = 174 // Fee for offchain virtual TX
    const sendTxid = await alice.wallet.sendBitcoin({
      address: bobOffchainAddress!,
      amount: sendAmount,
    }, false)

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Check final balances
    const aliceFinalBalance = await alice.wallet.getBalance()
    const bobFinalBalance = await bob.wallet.getBalance()
    expect(bobFinalBalance.offchain.total).toBe(sendAmount)
    expect(aliceFinalBalance.offchain.total).toBe(boardingAmount - sendAmount - fee)

    // Get transaction history for Alice
    aliceHistory = await alice.wallet.getTransactionHistory()
    expect(aliceHistory).toBeDefined()
    expect(aliceHistory.length).toBe(2) // Should have at least receive and send transactions

    const [sendTx, fundingTx] = aliceHistory

    // Check funding transaction
    expect(fundingTx.type).toBe(TxType.TxReceived)
    expect(fundingTx.amount).toBe(boardingAmount)
    expect(fundingTx.settled).toBe(true)
    expect(fundingTx.key.boardingTxid.length).toBeGreaterThan(0)
    
    // Check send transaction
    expect(sendTx.type).toBe(TxType.TxSent)
    expect(sendTx.amount).toBe(sendAmount + fee)
    expect(sendTx.key.redeemTxid.length).toBeGreaterThan(0)
    expect(sendTx.key.redeemTxid).toBe(sendTxid)

    // Get transaction history for Bob
    const bobHistory = await bob.wallet.getTransactionHistory()
    expect(bobHistory).toBeDefined()
    expect(bobHistory.length).toBe(1) // Should have at least the receive transaction

    // Verify Bob's receive transaction
    const [bobsReceiveTx] = bobHistory
    expect(bobsReceiveTx.type).toBe(TxType.TxReceived)
    expect(bobsReceiveTx.amount).toBe(sendAmount)
    expect(bobsReceiveTx.settled).toBe(false)
    expect(bobsReceiveTx.key.redeemTxid.length).toBeGreaterThan(0)

    // Bob settles the received VTXO
    const bobInputs = await bob.wallet.getVtxos()
    await bob.wallet.settle({
      inputs: bobInputs,
      outputs: [{
        address: bobOffchainAddress!,
        amount: BigInt(sendAmount)
      }]
    })

    // Verify Bob's history
    const bobHistoryAfterSettling = await bob.wallet.getTransactionHistory()
    expect(bobHistoryAfterSettling).toBeDefined()
    expect(bobHistoryAfterSettling.length).toBe(1)
    const [bobsReceiveTxAfterSettling] = bobHistoryAfterSettling
    expect(bobsReceiveTxAfterSettling.type).toBe(TxType.TxReceived)
    expect(bobsReceiveTxAfterSettling.amount).toBe(sendAmount)
    expect(bobsReceiveTxAfterSettling.settled).toBe(true)
  })

})
