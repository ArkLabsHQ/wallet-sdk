import { InMemoryKey } from "./identity/inMemoryKey";
import { Identity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
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
import {
    ArkTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    decodeTapscript,
    MultisigTapscript,
    TapscriptType,
} from "./script/tapscript";
import {
    addConditionWitness,
    CONDITION_WITNESS_KEY_PREFIX,
    makeVirtualTx,
} from "./utils/psbt";

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
    ArkTapscript,
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
    VHTLC,
    TxType,
    Worker,
    Request,
    Response,
    decodeTapscript,
    MultisigTapscript,
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CLTVMultisigTapscript,
    addConditionWitness,
    CONDITION_WITNESS_KEY_PREFIX,
    TapscriptType,
    makeVirtualTx,
};
