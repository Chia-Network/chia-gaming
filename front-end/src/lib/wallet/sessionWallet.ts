import type { ChannelFundingRuntime } from '../session/channelFundingRuntime';
import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import type { BlockchainPoller } from './BlockchainPoller';

/** Session execution can use queued chain operations, never provider setup or credentials. */
export type SessionWallet = Pick<
  BlockchainPoller,
  | 'resolveProviderOwner'
  | 'notifyProviderReadiness'
  | 'attachGameSession'
  | 'detachGameSession'
  | 'snapshotGameSessionCoinInterest'
  | 'watchCoin'
  | 'unwatchCoin'
  | 'stop'
> & {
  readonly channelFundingRuntime: SessionFunding;
  readonly rpc: Pick<
    InternalBlockchainInterface,
    'getAddress' | 'getPuzzleAndSolution' | 'isReadyForPlay' | 'onPlayReadinessChange' | 'spend'
  >;
};

/** Funding operations available to a session; provider/recovery lifetime stays with the wallet. */
export type SessionFunding = Pick<
  ChannelFundingRuntime,
  | 'subscribe'
  | 'providerScopeKeys'
  | 'supersedeOperation'
  | 'createOffer'
  | 'cancelIdentifiedReservation'
  | 'channelCoinConfirmed'
  | 'channelCreationTimedOut'
>;
