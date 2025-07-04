import { InMemoryKey } from "./identity/inMemoryKey";
import { Identity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import { VtxoScript } from "./script/base";
import {
    TxType,
    IWallet,
    WalletConfig,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    Recipient,
    SettleParams,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
} from "./wallet/index";
import { Wallet } from "./wallet/wallet";
import { TxGraph, TxGraphChunk } from "./tree/txGraph";
import { ServiceWorkerWallet } from "./wallet/serviceWorker/wallet";
import { OnchainWallet } from "./wallet/onchain";
import { Worker } from "./wallet/serviceWorker/worker";
import { Request } from "./wallet/serviceWorker/request";
import { Response } from "./wallet/serviceWorker/response";
import { ESPLORA_URL, EsploraProvider } from "./providers/onchain";
import { RestArkProvider } from "./providers/ark";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    decodeTapscript,
    MultisigTapscript,
    TapscriptType,
} from "./script/tapscript";
import { buildOffchainTx, VirtualTxInput, OffchainTx } from "./utils/psbt";
import {
    VtxoTaprootTree,
    ConditionWitness,
    getArkPsbtFields,
    setArkPsbtField,
    ArkPsbtFieldCoder,
    ArkPsbtFieldKey,
    ArkPsbtFieldKeyType,
    CosignerPublicKey,
    VtxoTreeExpiry,
} from "./utils/unknownFields";
import { BIP322 } from "./bip322";
import { ArkNote } from "./arknote";
import { IndexedDBVtxoRepository } from "./wallet/serviceWorker/db/vtxo/idb";
import { VtxoRepository } from "./wallet/serviceWorker/db/vtxo";
import { networks } from "./networks";
import {
    RestIndexerProvider,
    IndexerProvider,
    IndexerTxType,
    ChainTxType,
    PageResponse,
    Batch,
    ChainTx,
    CommitmentTx,
    TxHistoryRecord,
    Vtxo,
    VtxoChain,
    Tx,
} from "./providers/indexer";
import { waitForIncomingFunds } from "./utils/waitForIncomingFunds";

export {
    // Classes
    Wallet,
    ServiceWorkerWallet,
    InMemoryKey,
    OnchainWallet,

    // Providers
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    RestIndexerProvider,

    // Script-related
    ArkAddress,
    DefaultVtxo,
    VtxoScript,
    VHTLC,

    // Enums
    TxType,
    IndexerTxType,
    ChainTxType,

    // Service Worker
    Worker,
    Request,
    Response,

    // Tapscript
    decodeTapscript,
    MultisigTapscript,
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CLTVMultisigTapscript,

    // Ark PSBT fields
    ArkPsbtFieldKey,
    ArkPsbtFieldKeyType,
    setArkPsbtField,
    getArkPsbtFields,
    CosignerPublicKey,
    VtxoTreeExpiry,

    // Utils
    VtxoTaprootTree,
    ConditionWitness,
    buildOffchainTx,
    waitForIncomingFunds,

    // Arknote
    ArkNote,

    // Network
    networks,

    // Database
    IndexedDBVtxoRepository,

    // BIP322
    BIP322,

    // TxGraph
    TxGraph,
};

// Type exports
export type {
    // Types and Interfaces
    Identity,
    IWallet,
    WalletConfig,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    Recipient,
    SettleParams,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
    TapscriptType,
    VtxoRepository,
    VirtualTxInput,
    OffchainTx,

    // Indexer types
    IndexerProvider,
    PageResponse,
    Batch,
    ChainTx,
    CommitmentTx,
    TxHistoryRecord,
    Vtxo,
    VtxoChain,
    Tx,

    // Ark PSBT fields
    ArkPsbtFieldCoder,

    // TxGraph
    TxGraphChunk,
};
