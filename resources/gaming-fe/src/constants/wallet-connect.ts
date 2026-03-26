import { CoreTypes, ProposalTypes } from '@walletconnect/types';

export enum ChiaMethod {
  GetWallets = 'chia_getWallets',
  GetWalletBalance = 'chia_getWalletBalance',
  GetCurrentAddress = 'chia_getCurrentAddress',
  GetHeightInfo = 'chia_getHeightInfo',
  SelectCoins = 'chia_selectCoins',
  CreateOfferForIds = 'chia_createOfferForIds',
  WalletPushTx = 'chia_walletPushTx',
  CreateNewRemoteWallet = 'chia_createNewRemoteWallet',
  RegisterRemoteCoins = 'chia_registerRemoteCoins',
  GetCoinRecordsByNames = 'chia_getCoinRecordsByNames',
}

export const REQUIRED_NAMESPACES: ProposalTypes.RequiredNamespaces = {
  chia: {
    methods: Object.values(ChiaMethod),
    chains: ['chia:mainnet', 'chia:testnet'],
    events: [],
  },
};

export const METADATA: CoreTypes.Metadata = {
  name: 'Test App',
  description: 'A test application for WalletConnect.',
  url: '#',
  icons: ['https://walletconnect.com/walletconnect-logo.png'],
};
