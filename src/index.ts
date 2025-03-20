import { InMemoryKey } from "./identity/inMemoryKey";
import { Identity } from "./identity";
import { ArkAddress } from "./script/address";
import { DefaultVtxo } from "./script/default";
import { VtxoScript } from "./script/base";
import {
    IWallet,
    WalletConfig,
    ArkTransaction,
    TxType,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
} from "./wallet";
import { Wallet } from "./wallet/wallet";
import { ServiceWorkerWallet } from "./wallet/serviceWorker/wallet";
import { Worker } from "./wallet/serviceWorker/worker";
import { Request } from "./wallet/serviceWorker/request";
import { Response } from "./wallet/serviceWorker/response";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "./providers/onchain";
import {
    SettlementEvent,
    SettlementEventType,
    RestArkProvider,
    ArkProvider,
} from "./providers/ark";

export type {
    WalletConfig,
    IWallet,
    SettlementEvent,
    SettlementEventType,
    OnchainProvider,
    ArkProvider,
    Identity,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
};
export {
    Wallet,
    ServiceWorkerWallet,
    InMemoryKey,
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    ArkAddress,
    DefaultVtxo,
    VtxoScript,
    TxType,
    Worker,
    Request,
    Response,
};
