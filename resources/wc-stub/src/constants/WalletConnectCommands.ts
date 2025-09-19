// import { ServiceName } from '@chia-network/api';

const ServiceName = {
  WALLET: "WALLET",
  FULL_NODE: "FULL_NODE",
  DATALAYER: "DATALAYER",
  DAEMON: "DAEMON"
};

import type WalletConnectCommand from '../types/WalletConnectCommand';
import WalletConnectCommandParamName from '../types/WalletConnectCommandParamName';

const walletConnectCommands: WalletConnectCommand[] = [
  {
    command: 'requestPermissions',
    label: "Request Permissions",
    description: "App is requesting permission to execute these commands",
    service: 'EXECUTE',
    execute: (values: any) => ({ values }),
    params: [
      {
        name: WalletConnectCommandParamName.COMMANDS,
        type: 'object',
        label: "Commands",
      },
    ],
  },
  {
    command: 'logIn',
    label: "Log In",
    service: ServiceName.WALLET,
    allFingerprints: true,
    params: [
      {
        name: WalletConnectCommandParamName.FINGERPRINT,
        type: 'number',
        label: "Fingerprint",
      },
    ],
  },
  {
    command: 'getWallets',
    label: "Get Wallets",
    description: "Requests a complete listing of the wallets associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.INCLUDE_DATA,
        type: 'boolean',
        label: "Include Wallet Metadata",
      },
    ],
  },
  {
    command: 'getTransaction',
    label: "Get Transaction",
    description: "Requests details for a specific transaction",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.TRANSACTION_ID,
        type: 'string',
        label: "Transaction Id",
      },
    ],
  },
  {
    command: 'getWalletBalance',
    label: "Get Wallet Balance",
    description: "Requests the asset balance for a specific wallet associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
        isOptional: true,
        defaultValue: 1,
        hide: true,
      },
    ],
  },
  {
    command: 'getWalletBalances',
    label: "Get Wallet Balances",
    description: "Requests the asset balances for specific wallets associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_IDS,
        type: 'object',
        label: "Wallet Ids",
        isOptional: true,
        defaultValue: undefined,
        hide: false,
      },
    ],
  },
  {
    command: 'getCurrentAddress',
    label: "Get Current Address",
    description: "Requests the current receive address associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
        isOptional: true,
        defaultValue: 1,
        hide: true,
      },
    ],
  },

  {
    command: 'sendTransaction',
    label: "Send Transaction",
    service: ServiceName.WALLET,
    waitForSync: true,
    params: [
      {
        name: WalletConnectCommandParamName.AMOUNT,
        label: "Amount",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.ADDRESS,
        label: "Address",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet ID",
        type: 'number',
        defaultValue: 1,
        hide: true,
      },
      {
        name: WalletConnectCommandParamName.MEMOS,
        label: "Memos",
        // type: 'string[]', ??
        isOptional: true,
        hide: true,
      },
      {
        name: WalletConnectCommandParamName.PUZZLE_DECORATOR,
        label: "Puzzle Decorator",
        type: 'object',
        isOptional: true,
        // hide: true,
      },
    ],
  },
  {
    command: 'spendClawbackCoins',
    label: "Claw back or claim claw back transaction",
    service: ServiceName.WALLET,
    waitForSync: true,
    params: [
      {
        name: WalletConnectCommandParamName.COIN_IDS,
        label: "Coin Ids",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'signMessageById',
    label: "Sign Message by Id",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.MESSAGE,
        label: "Message",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.IS_HEX,
        label: "Message Is Hex Encoded String",
        type: 'boolean',
        isOptional: true,
      },
    ],
  },
  {
    command: 'signMessageByAddress',
    label: "Sign Message by Address",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.ADDRESS,
        label: "Address",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.MESSAGE,
        label: "Message",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.IS_HEX,
        label: "Message Is Hex Encoded String",
        type: 'boolean',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.SAFE_MODE,
        label: '',
        type: 'boolean',
        isOptional: true,
      },
    ],
  },
  {
    command: 'verifySignature',
    label: "Verify Signature",
    description: "Requests the verification status for a digital signature",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.MESSAGE,
        label: "Message",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.PUBKEY,
        label: "Public Key",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.SIGNATURE,
        label: "Signature",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.ADDRESS,
        label: "Address",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.SIGNING_MODE,
        label: "Signing Mode",
        type: 'string',
        isOptional: true,
      },
    ],
  },
  {
    command: 'getNextAddress',
    label: "Get Next Address",
    description: "Requests a new receive address associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        isOptional: true,
        defaultValue: 1,
        type: 'number',
        hide: true,
      },
      {
        name: WalletConnectCommandParamName.NEW_ADDRESS,
        label: "New Address",
        isOptional: true,
        defaultValue: true,
        type: 'boolean',
        hide: true,
      },
    ],
  },
  {
    command: 'getSyncStatus',
    label: "Get Wallet Sync Status",
    description: "Requests the syncing status of current wallet",
    service: ServiceName.WALLET,
    bypassConfirm: true,
  },
  {
    command: 'pushTx',
    label: "Push Transaction",
    description: "Push a spend bundle (transaction) to the blockchain",
    service: ServiceName.FULL_NODE,
    params: [
      {
        name: WalletConnectCommandParamName.SPEND_BUNDLE,
        label: "Spend Bundle",
        type: 'object',
      },
    ],
  },

  // offers
  {
    command: 'getAllOffers',
    label: "Get all Offers",
    description: "Requests a complete listing of the offers associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.START,
        label: "Start",
        isOptional: true,
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.END,
        label: "End",
        isOptional: true,
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.SORT_KEY,
        label: "Start Key",
        isOptional: true,
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.REVERSE,
        label: "Reverse",
        isOptional: true,
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.INCLUDE_MY_OFFERS,
        label: "Include My Offers",
        isOptional: true,
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.INCLUDE_TAKEN_OFFERS,
        label: "Include Taken Offers",
        isOptional: true,
        type: 'boolean',
      },
    ],
  },
  {
    command: 'getOffersCount',
    label: "Get Offers Count",
    description: "Requests the number of offers associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
  },
  {
    command: 'createOfferForIds',
    label: "Create Offer for Ids",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER,
        label: "Wallet Ids and Amounts",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.DRIVER_DICT,
        label: "Driver Dict",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.VALIDATE_ONLY,
        label: "Validate only",
        isOptional: true,
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.DISABLE_JSON_FORMATTING,
        label: "Disable JSON Formatting",
        isOptional: true,
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        isOptional: true,
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'cancelOffer',
    label: "Cancel Offer",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.TRADE_ID,
        label: "Trade Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.SECURE,
        label: "Secure",
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'checkOfferValidity',
    label: "Check Offer Validity",
    description: "Requests the validity status of a specific offer",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER,
        label: "Offer Data",
        type: 'string',
      },
    ],
  },
  {
    command: 'takeOffer',
    label: "Take Offer",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER,
        label: "Offer",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'getOfferSummary',
    label: "Get Offer Summary",
    description: "Requests the summarized details of a specific offer",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER_DATA,
        label: "Offer Data",
        type: 'string',
      },
    ],
  },
  {
    command: 'getOfferData',
    label: "Get Offer Data",
    description: "Requests the raw offer data for a specific offer",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER_ID,
        label: "Offer Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getOfferRecord',
    label: "Get Offer Record",
    service: ServiceName.WALLET,
    description: "Requests the details for a specific offer",
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER_ID,
        label: "Offer Id",
        type: 'string',
      },
    ],
  },

  // CAT
  {
    command: 'createNewCATWallet',
    label: 'Create new CAT Wallet',
    service: ServiceName.WALLET,
    bypassConfirm: false,
    params: [
      {
        name: WalletConnectCommandParamName.AMOUNT,
        label: "Amount",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      }
    ]
  },
  {
    command: 'getCATWalletInfo',
    label: "Get CAT Wallet Info",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ASSET_ID,
        label: "Asset Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getCATAssetId',
    label: "Get CAT Asset Id",
    description: "Requests the CAT asset ID for a specific CAT wallet",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        type: 'number',
      },
    ],
  },
  {
    command: 'spendCAT',
    label: "Spend CAT",
    service: ServiceName.WALLET,
    waitForSync: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.ADDRESS,
        label: "Address",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.AMOUNT,
        label: "Amount",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.MEMOS,
        label: "Memos",
        isOptional: true,
      },
    ],
  },
  {
    command: 'addCATToken',
    label: "Add CAT Token",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.ASSET_ID,
        label: "Asset Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.NAME,
        label: "Name",
        type: 'string',
      },
    ],
  },

  // NFTs
  {
    command: 'getNFTs',
    label: "Get NFTs",
    description: "Requests a full or paginated listing of NFTs associated with one or more wallets associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_IDS,
        label: "Wallet Ids",
      },
      {
        name: WalletConnectCommandParamName.NUM,
        label: "Number of NFTs",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.START_INDEX,
        label: "Start Index",
        type: 'number',
        isOptional: true,
      },
    ],
  },
  {
    command: 'getNFTInfo',
    label: "Get NFT Info",
    description: "Requests details for a specific NFT",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.COIN_ID,
        label: "Coin Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'mintBulk',
    label: "Mint Bulk",
    description: "Create a spend bundle to mint multiple NFTs",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.METADATA_LIST,
        label: "Metadata List",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.ROYALTY_PERCENTAGE,
        label: "Royalty Percentage",
        type: 'BigNumber',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.ROYALTY_ADDRESS,
        label: "Royalty Address",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.TARGET_LIST,
        label: "Target List",
        type: 'object',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MINT_NUMBER_START,
        label: "Mint Start Number",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MINT_TOTAL,
        label: "Mint Total",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.XCH_COINS,
        label: "XCH Coins",
        type: 'object',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.XCH_CHANGE_TARGET,
        label: "XCH Change Target",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.NEW_INNERPUZHASH,
        label: "New Inner Puzzle Hash",
        type: 'object',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.NEW_P2_PUZHASH,
        label: "New P2 Puzzle Hash",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.DID_COIN,
        label: "DID Coin Dictionary",
        type: 'object',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.DID_LINEAGE_PARENT,
        label: "DID Lineage Parent",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MINT_FROM_DID,
        label: "Mint From DID",
        type: 'boolean',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.REUSE_PUZHASH,
        label: "Reuse Puzzle Hash",
        type: 'boolean',
        isOptional: true,
      },
    ],
  },
  {
    command: 'mintNFT',
    label: "Mint NFT",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.ROYALTY_ADDRESS,
        label: "Royalty Address",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.ROYALTY_PERCENTAGE,
        label: "Royalty Percentage",
        type: 'BigNumber',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.TARGET_ADDRESS,
        label: "Target Address",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.URIS,
        label: "Uris",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.HASH,
        label: "Hash",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.META_URIS,
        label: "Meta Uris",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.META_HASH,
        label: "Meta Hash",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.LICENSE_URIS,
        label: "License Uris",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.LICENSE_HASH,
        label: "License Hash",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.EDITION_NUMBER,
        label: "Edition Number",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.EDITION_TOTAL,
        label: "Edition Total",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.DID_ID,
        label: "DID Id",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
        isOptional: true,
      },
    ],
  },
  {
    command: 'transferNFT',
    label: "Transfer NFT",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        label: "Wallet Id",
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.NFT_COIN_IDS,
        label: "NFT Coin Ids",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.TARGET_ADDRESS,
        label: "Target Address",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'getNFTsCount',
    label: "Get NFTs Count",
    description: "Requests the number of NFTs associated with one or more wallets associated with the current wallet key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_IDS,
        label: "Wallet Ids",
      },
    ],
  },

  // DataLayer
  {
    command: 'addMirror',
    label: "Add Mirror",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.URLS,
        label: "URLs",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.AMOUNT,
        label: "Amount",
        type: 'number',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'addMissingFiles',
    label: "Add Missing Files",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.IDS,
        label: "Store Ids",
        type: 'object',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.OVERWRITE,
        label: "Overwrite",
        type: 'boolean',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.FOLDER_NAME,
        label: "Folder Name",
        type: 'string',
        isOptional: true,
      },
    ],
  },
  {
    command: 'batchUpdate',
    label: "Batch Update",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.CHANGELIST,
        label: "Changelist",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.SUBMIT_ON_CHAIN,
        type: 'boolean',
        label: "Submit on chain",
        isOptional: true,
      },
    ],
  },
  {
    command: 'cancelDataLayerOffer',
    label: "Cancel DataLayer Offer",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.TRADE_ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.SECURE,
        label: "Secure",
        type: 'boolean',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'checkPlugins',
    label: "Check Plugins",
    service: ServiceName.DATALAYER,
    params: [],
  },
  {
    command: 'clearPendingRoots',
    label: "Clear Pending Roots",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.STORE_ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'createDataStore',
    label: "Create DataStore",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.VERBOSE,
        type: 'boolean',
        label: "Verbose",
        isOptional: true,
      },
    ],
  },
  {
    command: 'deleteKey',
    label: "Delete Key",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.KEY,
        label: "Key",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'deleteMirror',
    label: "Delete Mirror",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.COIN_ID,
        label: "Coin Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'getAncestors',
    label: "Get Ancestors",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.HASH,
        label: "Hash",
        type: 'string',
      },
    ],
  },
  {
    command: 'getKeys',
    label: "Get Keys",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.ROOT_HASH,
        label: "Root Hash",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.PAGE,
        label: "Page",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MAX_PAGE_SIZE,
        label: "Max page size",
        type: 'number',
        isOptional: true,
      },
    ],
  },
  {
    command: 'getKeysValues',
    label: "Get Keys Values",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.ROOT_HASH,
        label: "Root Hash",
        type: 'string',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.PAGE,
        label: "Page",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MAX_PAGE_SIZE,
        label: "Max page size",
        type: 'number',
        isOptional: true,
      },
    ],
  },
  {
    command: 'getKvDiff',
    label: "Get Kv Diff",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.HASH1,
        label: "Hash 1",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.HASH2,
        label: "Hash 2",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.PAGE,
        label: "Page",
        type: 'number',
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.MAX_PAGE_SIZE,
        label: "Max page size",
        type: 'number',
        isOptional: true,
      },
    ],
  },
  {
    command: 'getLocalRoot',
    label: "Get Local Root",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getMirrors',
    label: "Get Mirrors",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getOwnedStores',
    label: "Get Owned Stores",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [],
  },
  {
    command: 'getRoot',
    label: "Get Root",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getRoots',
    label: "Get Roots",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.IDS,
        label: "Store Ids",
        type: 'object',
      },
    ],
  },
  {
    command: 'getRootHistory',
    label: "Get Root History",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getDataLayerSyncStatus',
    label: "Get DataLayer Sync Status",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
    ],
  },
  {
    command: 'getValue',
    label: "Get Value",
    service: ServiceName.DATALAYER,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.KEY,
        label: "Key",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.ROOT_HASH,
        label: "Root Hash",
        type: 'string',
        isOptional: true,
      },
    ],
  },
  {
    command: 'insert',
    label: "Insert",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.KEY,
        label: "Key",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.VALUE,
        label: "Value",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'makeDataLayerOffer',
    label: "Make DataLayer Offer",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.MAKER,
        label: "Maker",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.TAKER,
        label: "Taker",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'removeSubscriptions',
    label: "Remove Subscriptions",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.URLS,
        label: "URLs",
        type: 'object',
      },
    ],
  },
  {
    command: 'subscribe',
    label: "Subscribe",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.URLS,
        label: "URLs",
        type: 'object',
      },
    ],
  },
  {
    command: 'subscriptions',
    label: "Subscriptions",
    service: ServiceName.DATALAYER,
    params: [],
  },
  {
    command: 'takeDataLayerOffer',
    label: "Take DataLayer Offer",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER,
        label: "Offer",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },
  {
    command: 'unsubscribe',
    label: "Unsubscribe",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.ID,
        label: "Store Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.RETAIN,
        label: "retain",
        type: 'boolean',
        isOptional: true,
      },
    ],
  },
  {
    command: 'verifyOffer',
    label: "Verify Offer",
    service: ServiceName.DATALAYER,
    params: [
      {
        name: WalletConnectCommandParamName.OFFER,
        label: "Offer",
        type: 'object',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
    ],
  },

  // DIDs
  {
    command: 'createNewDIDWallet',
    label: "Create new DID Wallet",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.AMOUNT,
        label: "Amount",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
      {
        name: WalletConnectCommandParamName.BACKUP_DIDS,
        label: "Backup DIDs",
      },
      {
        name: WalletConnectCommandParamName.NUM_OF_BACKUP_IDS_NEEDED,
        label: "Number of Backup Ids Needed",
        type: 'number',
      },
    ],
  },
  // {
  //   command: 'didCreateAttest',
  //   label: "Create DID Attest",
  //   service: ServiceName.WALLET,
  //   params: [
  //     {
  //       name: WalletConnectCommandParamName.WALLET_ID,
  //       type: 'number',
  //       label: "Wallet Id",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.COIN_NAME,
  //       type: 'string',
  //       label: "Coin Name",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.PUBKEY,
  //       type: 'string',
  //       label: "Public Key",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.PUZHASH,
  //       type: 'string',
  //       label: "Puzzle Hash",
  //     },
  //   ],
  // },
  // {
  //   command: 'didCreateBackupFile',
  //   label: "Create DID Backup File",
  //   service: ServiceName.WALLET,
  //   params: [
  //     {
  //       name: WalletConnectCommandParamName.WALLET_ID,
  //       type: 'number',
  //       label: "Wallet Id",
  //     },
  //   ],
  // },
  {
    command: 'findLostDID',
    label: "Find Lost DID",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.COIN_ID,
        type: 'string',
        label: "Coin Id",
      },
      {
        name: WalletConnectCommandParamName.RECOVERY_LIST_HASH,
        type: 'string',
        label: "Recovery List Hash",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.NUM_VERIFICATION,
        type: 'number',
        label: "Required Number of DIDs for Verification",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.METADATA,
        type: 'string',
        label: "DID Metadata",
        isOptional: true,
      },
    ],
  },
  {
    command: 'getDIDCurrentCoinInfo',
    label: "Get DID Current Coin Info",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'getDID',
    label: "Get DID",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'getDIDInfo',
    label: "Get DID Info",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.COIN_ID,
        type: 'string',
        label: "Coin Id",
      },
    ],
  },
  {
    command: 'getDIDInformationNeededForRecovery',
    label: "Get Information Needed For DID Recovery",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'getDIDMetadata',
    label: "Get DID Metadata",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'getDIDPubkey',
    label: "Get DID Public Key",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'getDIDRecoveryList',
    label: "Get DID Recovery List",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  // {
  //   command: 'didMessageSpend',
  //   label: "DID Message Spend",
  //   service: ServiceName.WALLET,
  //   params: [
  //     {
  //       name: WalletConnectCommandParamName.WALLET_ID,
  //       type: 'number',
  //       label: "Wallet Id",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.COIN_ANNOUNCEMENTS,
  //       type: 'object',
  //       label: "Coin Announcements",
  //       isOptional: true,
  //     },
  //     {
  //       name: WalletConnectCommandParamName.PUZZLE_ANNOUNCEMENTS,
  //       type: 'object',
  //       label: "Puzzle Announcements",
  //       isOptional: true,
  //     },
  //   ],
  // },
  // {
  //   command: 'didRecoverySpend',
  //   label: "DID Recovery Spend",
  //   service: ServiceName.WALLET,
  //   params: [
  //     {
  //       name: WalletConnectCommandParamName.WALLET_ID,
  //       type: 'number',
  //       label: "Wallet Id",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.ATTEST_DATA,
  //       type: 'object',
  //       label: "Attest Data",
  //     },
  //     {
  //       name: WalletConnectCommandParamName.PUBKEY,
  //       type: 'string',
  //       label: "DID Public Key",
  //       isOptional: true,
  //     },
  //     {
  //       name: WalletConnectCommandParamName.PUZHASH,
  //       type: 'string',
  //       label: "Puzzle Hash",
  //       isOptional: true,
  //     },
  //     {
  //       name: WalletConnectCommandParamName.FEE,
  //       type: 'BigNumber',
  //       label: "Fee",
  //       isOptional: true,
  //     },
  //   ],
  // },
  {
    command: 'transferDID',
    label: "Transfer DID",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
      {
        name: WalletConnectCommandParamName.INNER_ADDRESS,
        type: 'string',
        label: "Inner Address",
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.WITH_RECOVERY_INFO,
        type: 'boolean',
        label: "With Recovery Info",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.REUSE_PUZHASH,
        type: 'boolean',
        label: "Reuse Puzzle Hash",
        isOptional: true,
      },
    ],
  },
  {
    command: 'updateDIDMetadata',
    label: "Update DID Metadata",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
      {
        name: WalletConnectCommandParamName.METADATA,
        type: 'object',
        label: "DID Metadata",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.REUSE_PUZHASH,
        type: 'boolean',
        label: "Reuse Puzzle Hash",
        isOptional: true,
      },
    ],
  },
  {
    command: 'updateDIDRecoveryIds',
    label: "Update DID Recovery Ids",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
      {
        name: WalletConnectCommandParamName.NEW_LIST,
        type: 'object',
        label: "New Recovery DID List",
      },
      {
        name: WalletConnectCommandParamName.NUM_VERIFICATIONS_REQUIRED,
        type: 'number',
        label: "Number Of DIDs Required For Recovery",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'BigNumber',
        label: "Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.REUSE_PUZHASH,
        type: 'boolean',
        label: "Reuse Puzzle Hash",
        isOptional: true,
      },
    ],
  },
  {
    command: 'getDIDName',
    label: "Get DID Name",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
    ],
  },
  {
    command: 'setDIDName',
    label: "Set DID Name",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
      {
        name: WalletConnectCommandParamName.NAME,
        label: "Name",
        type: 'string',
      },
    ],
  },
  {
    command: 'setNFTDID',
    label: "Set NFT DID",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.WALLET_ID,
        type: 'number',
        label: "Wallet Id",
      },
      {
        name: WalletConnectCommandParamName.NFT_LAUNCHER_ID,
        label: "NFT Launcher Id",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.NFT_COIN_IDS,
        label: "NFT Coin Ids",
      },
      {
        name: WalletConnectCommandParamName.DID,
        label: "DID",
        type: 'string',
      },
      {
        name: WalletConnectCommandParamName.FEE,
        label: "Fee",
        type: 'BigNumber',
      },
    ],
  },
  {
    command: 'getNFTWalletsWithDIDs',
    label: "Get NFT Wallets with DIDs",
    service: ServiceName.WALLET,
    bypassConfirm: true,
  },
  {
    command: 'getVCList',
    label: "Get All Verifiable Credentials",
    service: ServiceName.WALLET,
    bypassConfirm: true,
  },
  {
    command: 'getVC',
    label: "Get Verifiable Credential",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.VC_ID,
        type: 'string',
        label: "Launcher Id",
      },
    ],
  },
  {
    command: 'spendVC',
    label: "Add Proofs To Verifiable Credential",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.VC_ID,
        type: 'string',
        label: "Launcher Id",
      },
      {
        name: WalletConnectCommandParamName.NEW_PUZHASH,
        type: 'string',
        label: "New Puzzle Hash",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.NEW_PROOF_HASH,
        type: 'string',
        label: "New Proof Hash",
      },
      {
        name: WalletConnectCommandParamName.PROVIDER_INNER_PUZHASH,
        type: 'string',
        label: "Provider Inner Puzzle Hash",
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'number',
        label: "Spend Fee",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.REUSE_PUZHASH,
        type: 'boolean',
        label: "Reuse Puzzle Hash",
        isOptional: true,
      },
    ],
  },
  {
    command: 'addVCProofs',
    label: "Add Proofs",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.PROOFS,
        type: 'object',
        label: "Proofs Object (Key Value Pairs)",
      },
    ],
  },
  {
    command: 'getProofsForRoot',
    label: "Get Proofs For Root Hash",
    service: ServiceName.WALLET,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.ROOT,
        type: 'string',
        label: "Proofs Hash",
      },
    ],
  },
  {
    command: 'revokeVC',
    label: "Revoke Verifiable Credential",
    service: ServiceName.WALLET,
    params: [
      {
        name: WalletConnectCommandParamName.VC_PARENT_ID,
        type: 'string',
        label: "Parent Coin Info",
      },
      {
        name: WalletConnectCommandParamName.FEE,
        type: 'number',
        label: "Fee",
      },
    ],
  },
  {
    command: 'showNotification',
    label: "Show notification with offer or general announcement",
    service: 'NOTIFICATION',
    params: [
      {
        name: WalletConnectCommandParamName.TYPE,
        type: 'string',
        label: "Type",
      },
      {
        name: WalletConnectCommandParamName.MESSAGE,
        type: 'string',
        label: "Message",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.URL,
        type: 'string',
        label: "URL",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.OFFER_DATA,
        type: 'string',
        label: "Offer Data",
        isOptional: true,
      },
      {
        name: WalletConnectCommandParamName.ALL_FINGERPRINTS,
        type: 'boolean',
        label: "Is notification visible to all paired fingerprints",
        isOptional: true,
      },
    ],
  },
  {
    command: 'getWalletAddresses',
    label: "Get wallet addresses for one or more wallet keys",
    service: ServiceName.DAEMON,
    bypassConfirm: true,
    params: [
      {
        name: WalletConnectCommandParamName.FINGERPRINTS,
        type: 'object', // number array
        label: "Fingerprints",
        isOptional: true,
        defaultValue: undefined,
      },
      {
        name: WalletConnectCommandParamName.INDEX,
        type: 'number',
        label: "Index",
        isOptional: true,
        defaultValue: undefined,
      },
      {
        name: WalletConnectCommandParamName.COUNT,
        type: 'number',
        label: "Count",
        isOptional: true,
        defaultValue: undefined,
      },
      {
        name: WalletConnectCommandParamName.NON_OBSERVER_DERIVATION,
        type: 'boolean',
        label: "Non Observer Derivation",
        isOptional: true,
        defaultValue: undefined,
      },
    ],
  },
  {
    command: 'getPublicKey',
    label: "Get public key",
    description: "Requests a master public key from your wallet",
    service: ServiceName.DAEMON,
    params: [
      {
        name: WalletConnectCommandParamName.FINGERPRINT,
        type: 'number',
        label: "Fingerprint",
      },
    ],
  }
];

export default walletConnectCommands;
