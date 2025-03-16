import { Wallet, InMemoryKey } from '../src'
import { expect, describe, it, beforeAll } from 'vitest'
import { utils } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { execSync } from 'child_process'
import { BareWallet } from '../src/core/wallet'

const arkdExec = process.env.ARK_ENV === 'master' ? 'docker exec -t arkd' : 'nigiri'

describe('Wallet SDK Integration Tests', () => {
  // Generate random keys for all participants
  const alicePrivateKeyBytes = utils.randomPrivateKeyBytes()
  const bobPrivateKeyBytes = utils.randomPrivateKeyBytes()
  const carolPrivateKeyBytes = utils.randomPrivateKeyBytes()
  const davePrivateKeyBytes = utils.randomPrivateKeyBytes()
  const frankPrivateKeyBytes = utils.randomPrivateKeyBytes()
  // Convert to hex strings for future reference
  const alicePrivateKeyHex = hex.encode(alicePrivateKeyBytes)
  const bobPrivateKeyHex = hex.encode(bobPrivateKeyBytes)
  const carolPrivateKeyHex = hex.encode(carolPrivateKeyBytes)
  const davePrivateKeyHex = hex.encode(davePrivateKeyBytes)
  const frankPrivateKeyHex = hex.encode(frankPrivateKeyBytes)
  // Onchain wallets (Alice and Bob)
  let aliceWallet: Wallet
  let bobWallet: Wallet

  // Offchain wallets (Carol and Dave)
  let carolWallet: Wallet
  let daveWallet: Wallet
  let frankWallet: Wallet

  beforeAll(async () => {
    // Check if there's enough offchain balance before proceeding
    const balanceOutput = execSync(`${arkdExec} ark balance`).toString()
    const balance = JSON.parse(balanceOutput)
    const offchainBalance = balance.offchain_balance.total

    if (offchainBalance < 210_000) {
      throw new Error('Insufficient offchain balance. Please run "node test/setup.js" first to setup the environment')
    }

    // Initialize onchain wallets (Alice and Bob)
    const aliceIdentity = InMemoryKey.fromHex(alicePrivateKeyHex)
    const bobIdentity = InMemoryKey.fromHex(bobPrivateKeyHex)

    aliceWallet = new BareWallet()
    await aliceWallet.init({
      network: 'regtest',
      identity: aliceIdentity,
    })

    bobWallet = new BareWallet()
    await bobWallet.init({
      network: 'regtest',
      identity: bobIdentity,
    })

    // Initialize offchain wallets (Carol and Dave)
    const carolIdentity = InMemoryKey.fromHex(carolPrivateKeyHex)
    const daveIdentity = InMemoryKey.fromHex(davePrivateKeyHex)
    const frankIdentity = InMemoryKey.fromHex(frankPrivateKeyHex)

    carolWallet = new BareWallet()
    await carolWallet.init({
      network: 'regtest',
      identity: carolIdentity,
      arkServerUrl: 'http://localhost:7070',
    })

    daveWallet = new BareWallet()
    await daveWallet.init({
      network: 'regtest',
      identity: daveIdentity,
      arkServerUrl: 'http://localhost:7070',
    })

    frankWallet = new BareWallet()
    await frankWallet.init({
      network: 'regtest',
      identity: frankIdentity,
      arkServerUrl: 'http://localhost:7070',
    })
  })

  it('should settle a boarding UTXO', { timeout: 60000}, async () => {
    const frankAddresses = await frankWallet.getAddress()
    const boardingAddress = frankAddresses.boarding
    const offchainAddress = frankAddresses.offchain

    // faucet 
    execSync(`nigiri faucet ${boardingAddress?.address} 0.001`) // 

    await new Promise(resolve => setTimeout(resolve, 5000))

    const boardingInputs = await frankWallet.getBoardingUtxos()
    expect(boardingInputs.length).toBeGreaterThanOrEqual(1)
    

    const settleTxid = await frankWallet.settle({
      inputs: boardingInputs,
      outputs: [{
        address: offchainAddress!.address,
        amount: BigInt(100000)
      }]
    })

    expect(settleTxid).toBeDefined()    
  })

  it('should settle a VTXO', { timeout: 60000}, async () => {
    const frankAddresses = await frankWallet.getAddress()
    const frankOffchainAddress = frankAddresses.offchain?.address
    execSync(`${arkdExec} ark send --to ${frankOffchainAddress} --amount 1000 --password secret`)

    await new Promise(resolve => setTimeout(resolve, 1000))

    const virtualCoins = await frankWallet.getVtxos()
    expect(virtualCoins.length).toBeGreaterThanOrEqual(1)
    const vtxo = virtualCoins[0]
    expect(vtxo.outpoint.txid).toBeDefined()

    const settleTxid = await frankWallet.settle({
      inputs: [vtxo],
      outputs: [{
        address: frankOffchainAddress!,
        amount: BigInt(vtxo.value)
      }]
    })

    expect(settleTxid).toBeDefined()
  })

  it('should perform a complete onchain roundtrip payment', { timeout: 30000 }, async () => {
    // Get addresses
    const aliceAddress = (await aliceWallet.getAddress()).onchain
    const bobAddress = (await bobWallet.getAddress()).onchain

    // Initial balance check
    const aliceInitialBalance = await aliceWallet.getBalance()
    const bobInitialBalance = await bobWallet.getBalance()
    expect(aliceInitialBalance.onchain.total).toBe(0)
    expect(bobInitialBalance.onchain.total).toBe(0)

    // Fund Alice's address using nigiri faucet
    const faucetAmountSats =  0.001 * 100_000_000 // Amount in sats
    execSync(`nigiri faucet ${aliceAddress} 0.001`)

    // Wait for the faucet transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Check Alice's balance after funding
    const aliceBalanceAfterFunding = await aliceWallet.getBalance()
    expect(aliceBalanceAfterFunding.onchain.total).toBe(faucetAmountSats)

    // Send from Alice to Bob
    const sendAmount = 50000 // 0.0005 BTC in sats
    await aliceWallet.sendBitcoin({
      address: bobAddress,
      amount: sendAmount,
      feeRate: 2
    })

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Final balance check
    const aliceFinalBalance = await aliceWallet.getBalance()
    const bobFinalBalance = await bobWallet.getBalance()
    
    // Verify the transaction was successful
    expect(bobFinalBalance.onchain.total).toBe(sendAmount)
    expect(aliceFinalBalance.onchain.total).toBeLessThan(aliceBalanceAfterFunding.onchain.total)
  })

  it('should perform a complete offchain roundtrip payment', { timeout: 60000 }, async () => {
    // Get addresses
    const carolOffchainAddress = (await carolWallet.getAddress()).offchain?.address
    const daveOffchainAddress = (await daveWallet.getAddress()).offchain?.address
    expect(carolOffchainAddress).toBeDefined()
    expect(daveOffchainAddress).toBeDefined()

    // Initial balance check
    const carolInitialBalance = await carolWallet.getBalance()
    const daveInitialBalance = await daveWallet.getBalance()
    expect(carolInitialBalance.offchain.total).toBe(0)
    expect(daveInitialBalance.offchain.total).toBe(0)

    // Initial virtual coins check
    expect((await carolWallet.getVtxos()).length).toBe(0)
    expect((await daveWallet.getVtxos()).length).toBe(0)

    // Use a smaller amount for testing
    const fundAmount = 10000 
    execSync(`${arkdExec} ark send --to ${carolOffchainAddress} --amount ${fundAmount} --password secret`)

    await new Promise(resolve => setTimeout(resolve, 1000))

    // Check virtual coins after funding
    const virtualCoins = await carolWallet.getVtxos()

    // Verify we have a pending virtual coin
    expect(virtualCoins).toHaveLength(1)
    const vtxo = virtualCoins[0]
    expect(vtxo.txid).toBeDefined()
    expect(vtxo.value).toBe(fundAmount)
    expect(vtxo.virtualStatus.state).toBe('pending')

    // Check Carol's balance after funding
    const carolBalanceAfterFunding = await carolWallet.getBalance()
    expect(carolBalanceAfterFunding.offchain.total).toBe(fundAmount)

    // Send from Carol to Dave offchain
    const sendAmount = 5000 // 5k sats instead of 50k
    const fee = 174 // Fee for offchain virtual TX
    await carolWallet.sendBitcoin({
      address: daveOffchainAddress!,
      amount: sendAmount,
    }, false)

    // Wait for the transaction to be processed
    await new Promise(resolve => setTimeout(resolve, 500))

    // Final balance check
    const carolFinalBalance = await carolWallet.getBalance()
    const daveFinalBalance = await daveWallet.getBalance()
    // Verify the transaction was successful
    expect(daveFinalBalance.offchain.total).toBe(sendAmount)
    expect(carolFinalBalance.offchain.total).toBe(fundAmount - sendAmount - fee)
  })


})
