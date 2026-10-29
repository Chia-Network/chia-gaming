import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import type { BlockchainPoller } from './BlockchainPoller';

/** Session execution can use queued chain operations, never provider setup or credentials. */
export type SessionWallet = Pick<
  BlockchainPoller,
  | 'channelFundingRuntime'
  | 'resolveProviderOwner'
  | 'notifyProviderReadiness'
  | 'attachGameSession'
  | 'detachGameSession'
  | 'snapshotGameSessionCoinInterest'
  | 'watchCoin'
  | 'unwatchCoin'
  | 'stop'
> & {
  readonly rpc: Pick<
    InternalBlockchainInterface,
    'getAddress' | 'getPuzzleAndSolution' | 'isReadyForPlay' | 'onPlayReadinessChange' | 'spend'
  >;
};
