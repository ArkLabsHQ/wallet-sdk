# Arkade TypeScript SDK
The Arkade SDK is a TypeScript library for building Bitcoin wallets with support for both on-chain and off-chain transactions via the Ark protocol.

## Installation

```bash
npm install @arkade-os/sdk
```

## Usage

### Creating a Wallet

```typescript
import { InMemoryKey, Wallet } from '@arkade-os/sdk'

// Create a new in-memory key (or use an external signer)
const identity = InMemoryKey.fromHex('your_private_key_hex')

// Create a wallet with Ark support
const wallet = await Wallet.create({
  identity: identity,
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  arkServerUrl: 'https://mutinynet.arkade.sh',
})
```

### Receiving Bitcoin

```typescript
// Get wallet addresses
const arkAddress = await wallet.getAddress()
const boardingAddress = await wallet.getBoardingAddress()
console.log('Ark Address:', arkAddress)
console.log('Boarding Address:', boardingAddress)

// be notified when incoming funds
wallet.notifyIncomingFunds((coins) => {
  const amount = coins.reduce((sum, a) => sum + a.value)
  console.log('received ${coins.length} coins totalling ${amount} sats')
})

// or block and wait for incoming funds
const coins = await waitForIncomingFunds(wallet)
```

### Sending Bitcoin

```typescript
// Send bitcoin via Ark
const txid = await wallet.sendBitcoin({
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,  // in satoshis
  feeRate: 1      // optional, in sats/vbyte
})

// For settling transactions
const settleTxid = await wallet.settle({
  inputs, // from getVtxos() or getBoardingUtxos()
  outputs: [{
    address: destinationAddress,
    amount: BigInt(amount)
  }]
})
```

### Checking Balance

```typescript
// Get detailed balance information
const balance = await wallet.getBalance()
console.log('Total Balance:', balance.total)
console.log('Boarding Total:', balance.boarding.total)
console.log('Offchain Available:', balance.available)
console.log('Offchain Settled:', balance.settled)
console.log('Offchain Preconfirmed:', balance.preconfirmed)
console.log('Recoverable:', balance.recoverable)

// Get virtual UTXOs (off-chain)
const virtualCoins = await wallet.getVtxos()

// Get boarding UTXOs
const boardingUtxos = await wallet.getBoardingUtxos()
```

### Transaction History

```typescript
// Get transaction history
const history = await wallet.getTransactionHistory()
console.log('History:', history)

// Example history entry:
{
  key: {
    boardingTxid: '...', // for boarding transactions
    commitmentTxid: '...', // for commitment transactions
    redeemTxid: '...'    // for regular transactions
  },
  type: TxType.TxReceived, // or TxType.TxSent
  amount: 50000,
  settled: true,
  createdAt: 1234567890
}
```

### Unilateral Exit

```typescript
// Unilateral exit all vtxos
await wallet.exit();

// Unilateral exit a specific vtxo
await wallet.exit([{ txid: vtxo.txid, vout: vtxo.vout }]);
```

### Running the wallet in a service worker

1. Create a service worker file

```typescript
// service-worker.ts
import { Worker } from '@arkade-os/sdk'

// Worker handles communication between the main thread and service worker
new Worker().start()
```

2. Instantiate the ServiceWorkerWallet

```typescript
// specify the path to the service worker file
// this will automatically register the service worker
const wallet = await ServiceWorkerWallet.create('/service-worker.js')

// Initialize the wallet
await wallet.init({
  privateKey: 'your_private_key_hex',
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  // OPTIONAL Ark Server connection information
  arkServerUrl: 'https://mutinynet.arkade.sh',
})
```

## API Reference

### Wallet

#### Constructor Options

```typescript
interface WalletConfig {
  /** Identity for signing transactions */
  identity: Identity;
  /** Ark server URL */
  arkServerUrl: string;
  /** Optional Esplora API URL */
  esploraUrl?: string;
  /** Ark server public key (optional) */
  arkServerPublicKey?: string;
  /** Optional boarding timelock configuration */
  boardingTimelock?: RelativeTimelock;
  /** Optional exit timelock configuration */
  exitTimelock?: RelativeTimelock;
}
```

#### Methods

```typescript
interface IWallet {
  /** Get offchain address */
  getAddress(): Promise<string>;

  /** Get boarding address */
  getBoardingAddress(): Promise<string>;

  /** Get wallet balance */
  getBalance(): Promise<{
    boarding: {
      confirmed: number;
      unconfirmed: number;
      total: number;
    };
    settled: number;
    preconfirmed: number;
    available: number;
    recoverable: number;
    total: number;
  }>;

  /** Send bitcoin via Ark */
  sendBitcoin(params: {
    address: string;
    amount: number;
    feeRate?: number;
    memo?: string;
  }): Promise<string>;

  /** Get virtual UTXOs */
  getVtxos(filter?: { withSpendableInSettlement?: boolean }): Promise<ExtendedVirtualCoin[]>;

  /** Get boarding UTXOs */
  getBoardingUtxos(): Promise<ExtendedCoin[]>;

  /** Settle transactions */
  settle(
    params?: {
      inputs: ExtendedCoin[];
      outputs: {
        address: string;
        amount: bigint;
      }[];
    },
    eventCallback?: (event: SettlementEvent) => void
  ): Promise<string>;

  /** Get transaction history */
  getTransactionHistory(): Promise<ArkTransaction[]>;

  /** Be notified via callback */
  notifyIncomingFunds(
    eventCallback: (
      coins: Coin[] | VirtualCoin[],
      stopFunc: () => void
    ) => void
  ): Promise<void>;

  /** Exit vtxos unilaterally */
  exit(outpoints?: Outpoint[]): Promise<void>;
}
```

### Types

```typescript
/** Transaction types */
enum TxType {
  TxSent = 'SENT',
  TxReceived = 'RECEIVED'
}

/** Transaction history entry */
interface ArkTransaction {
  key: {
    boardingTxid: string;
    commitmentTxid: string;
    redeemTxid: string;
  };
  type: TxType;
  amount: number;
  settled: boolean;
  createdAt: number;
}

/** Virtual coin (off-chain UTXO) */
interface ExtendedVirtualCoin {
  txid: string;
  vout: number;
  value: number;
  virtualStatus: {
    state: 'pending' | 'settled' | 'swept' | 'spent';
    commitmentTxIds?: string[];
    batchExpiry?: number;
  };
  spentBy?: string;
  createdAt: Date;
  forfeitTapLeafScript: TapLeafScript;
  intentTapLeafScript: TapLeafScript;
  tapTree: string;
  extraWitness?: Bytes[];
}

/** Boarding UTXO */
interface ExtendedCoin {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  forfeitTapLeafScript: TapLeafScript;
  intentTapLeafScript: TapLeafScript;
  tapTree: string;
  extraWitness?: Bytes[];
}
```

### Identity

```typescript
export interface Identity {
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    xOnlyPublicKey(): Uint8Array;
    signerSession(): SignerSession;
}
```

The SDK provides a default implementation of the `Identity` interface: `InMemoryKey` for managing private keys in memory:

```typescript
class InMemoryKey {
  static fromPrivateKey(privateKey: Uint8Array): InMemoryKey;
  static fromHex(privateKeyHex: string): InMemoryKey;
}
```

## Development

### Requirements

- [pnpm](https://pnpm.io/) - Package manager
- [nigiri](https://github.com/vulpemventures/nigiri) - For running integration tests with a local Bitcoin regtest network

### Setup

1. Install dependencies:

```bash
pnpm install
pnpm format
pnpm lint
```

2. Install nigiri for integration tests:

```bash
curl https://getnigiri.vulpem.com | bash
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests with ark provided by nigiri
nigiri start --ark
pnpm test:setup # Run setup script for integration tests
pnpm test:integration
nigiri stop --delete

# Run integration tests with ark provided by docker (requires nigiri)
nigiri start
pnpm test:up-docker
pnpm test:setup-docker # Run setup script for integration tests
pnpm test:integration-docker
pnpm test:down-docker
nigiri stop --delete

# Watch mode for development
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

### Releasing

```bash
# Release new version (will prompt for version patch, minor, major)
pnpm release

# You can test release process without making changes
pnpm release:dry-run

# Cleanup: checkout version commit and remove release branch
pnpm release:cleanup
```

## License

MIT
