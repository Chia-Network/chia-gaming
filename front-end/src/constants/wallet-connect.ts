import { ProposalTypes } from '@walletconnect/types';

import {
  CHAIN_ID_OVERRIDE,
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
  GENESIS_CHALLENGE_OVERRIDE,
  MAINNET_GENESIS_CHALLENGE,
  TESTNET_GENESIS_CHALLENGE,
} from './env';
import { isTestnet } from './currency';
import { storageRepository } from '../lib/session/storageRepository';

export enum ChiaMethod {
  GetWallets = 'chia_getWallets',
  GetWalletBalance = 'chia_getWalletBalance',
  GetNextAddress = 'chia_getNextAddress',
  GetHeightInfo = 'chia_getHeightInfo',
  SelectCoins = 'chia_selectCoins',
  CreateOfferForIds = 'chia_createOfferForIds',
  CreateFeeTransaction = 'chia_createFeeTransaction',
  CancelOffer = 'chia_cancelOffer',
  PushTransactions = 'chia_pushTransactions',
  CreateNewRemoteWallet = 'chia_createNewRemoteWallet',
  RegisterRemoteCoins = 'chia_registerRemoteCoins',
  GetCoinRecordsByNames = 'chia_getCoinRecordsByNames',
  GetPuzzleAndSolution = 'chia_getPuzzleAndSolution',
  GetFullNodePeerCount = 'chia_getFullNodePeerCount',
}

/**
 * WalletConnect CAIP-2 chain id for the currently-selected Chia network.
 * A build-time/window override wins over the persisted network preference.
 */
export function getChainId(): string {
  if (CHAIN_ID_OVERRIDE) return CHAIN_ID_OVERRIDE;
  return storageRepository.query('network') === 'testnet' ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID;
}

/**
 * True when the repository-owned connection preference is the local simulator.
 */
function readBlockchainIsSimulator(): boolean {
  return storageRepository.query('blockchainType') === 'simulator';
}

/**
 * Genesis challenge (AGG_SIG_ME additional data) hex for the chain this session
 * will actually talk to. A build-time/window override wins.
 *
 * The local simulator always verifies spends against the hardcoded mainnet
 * `AGG_SIG_ME_ADDITIONAL_DATA` constant, so simulator sessions use the mainnet
 * challenge even if the UI network toggle is Testnet. That toggle still drives
 * WalletConnect chain id and currency labels; it is not a simulated network.
 *
 * Both preferences come from the repository-owned aggregate.
 */
export function getGenesisChallenge(): string {
  if (GENESIS_CHALLENGE_OVERRIDE) return GENESIS_CHALLENGE_OVERRIDE;
  if (readBlockchainIsSimulator()) return MAINNET_GENESIS_CHALLENGE;
  return isTestnet() ? TESTNET_GENESIS_CHALLENGE : MAINNET_GENESIS_CHALLENGE;
}

export function getRequiredNamespaces(): ProposalTypes.RequiredNamespaces {
  return {
    chia: {
      methods: Object.values(ChiaMethod).filter(
        (method) => method !== ChiaMethod.GetFullNodePeerCount,
      ),
      chains: [getChainId()],
      events: [],
    },
  };
}

export function getOptionalNamespaces(): ProposalTypes.OptionalNamespaces {
  return {
    chia: {
      methods: Object.values(ChiaMethod),
      chains: [getChainId()],
      events: [],
    },
  };
}
