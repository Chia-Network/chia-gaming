import { ProposalTypes } from '@walletconnect/types';

import { CHAIN_ID } from './env';

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
  GetPuzzleAndSolution = 'chia_getPuzzleAndSolution',
}

export const REQUIRED_NAMESPACES: ProposalTypes.RequiredNamespaces = {
  chia: {
    methods: Object.values(ChiaMethod),
    chains: [CHAIN_ID],
    events: [],
  },
};
