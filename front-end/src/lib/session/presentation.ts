import type {
  ChannelSemanticPhase,
  ChannelStatus,
  GameStatusPayload,
  GameStatusState,
} from '../../types/ChiaGaming';
import type {
  ChannelStatusModel,
  GameCoinModel,
  GameInstanceModel,
  GameInstanceViewModel,
  GameProtocolPresentation,
} from './types';

export { EMPTY_GAME_TERMINAL_MODEL as INITIAL_GAME_TERMINAL_MODEL } from './types';
export const DEFAULT_GAME_COIN_MODEL: GameCoinModel = { coinHex: null, turnState: 'my-turn' };
export const ON_CHAIN_CHANNEL_STATES = new Set<ChannelStatus>([
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
]);

export type NonTerminalGameStatusState = Exclude<
  GameStatusState,
  'ended-cancelled' | 'ended-error'
>;
export type NonTerminalGameStatusPayload = Omit<GameStatusPayload, 'status'> & {
  status: NonTerminalGameStatusState;
};

export function isTerminalGameStatus(
  status: GameStatusState,
): status is Extract<GameStatusState, 'ended-cancelled' | 'ended-error'> {
  return status === 'ended-cancelled' || status === 'ended-error';
}
export function isFinishingGameStatus(
  status: NonTerminalGameStatusState,
  gameFinished: boolean | undefined,
): boolean {
  return (
    gameFinished === true &&
    ['my-turn', 'their-turn', 'on-chain-my-turn', 'on-chain-their-turn'].includes(status)
  );
}
export function projectGameStatus({
  previous,
  payload,
  channelState,
}: {
  previous: GameInstanceModel;
  payload: NonTerminalGameStatusPayload;
  channelState: ChannelStatus;
}): GameInstanceModel {
  if (previous.presentation === 'ended') return previous;
  const { status } = payload;
  const finishing = isFinishingGameStatus(status, payload.other_params?.game_finished);
  const preserveLocal =
    ON_CHAIN_CHANNEL_STATES.has(channelState) && (status === 'my-turn' || status === 'their-turn');
  const coinHex = payload.coin_id != null ? null : previous.coinHex;
  if (
    preserveLocal ||
    (status === 'on-chain-my-turn' &&
      (previous.presentation === 'playing-move' || previous.presentation === 'replaying-move'))
  ) {
    return coinHex === previous.coinHex ? previous : { ...previous, coinHex };
  }
  let presentation: GameProtocolPresentation;
  if (status === 'finishing-waiting-timeout') {
    presentation = 'finishing-waiting-timeout';
  } else if (status === 'finishing-spending') {
    presentation = 'finishing-spending';
  } else if (status === 'my-turn' || status === 'on-chain-my-turn') {
    presentation = finishing
      ? 'finishing'
      : status === 'on-chain-my-turn'
        ? 'on-chain-my-turn'
        : 'off-chain-my-turn';
  } else if (status === 'their-turn' || status === 'on-chain-their-turn') {
    const timeout = payload.other_params?.submitting_timeout_claim === true;
    presentation = finishing
      ? 'finishing'
      : timeout
        ? 'submitting-timeout'
        : status === 'on-chain-their-turn'
          ? 'on-chain-their-turn'
          : 'off-chain-their-turn';
  } else if (status === 'replaying') {
    presentation = 'replaying-move';
  } else if (status === 'playing-move') {
    presentation = 'playing-move';
  } else if (status === 'illegal-move-detected') {
    presentation = 'illegal-move';
  } else {
    throw new Error(`Unexpected game status: ${String(status)}`);
  }
  return presentation === previous.presentation && coinHex === previous.coinHex
    ? previous
    : { ...previous, coinHex, presentation };
}

export function nextGameInstanceAfterLocalTurn(
  instance: GameInstanceModel,
  isMyTurn: boolean,
  channelState: ChannelStatus,
): GameInstanceModel {
  if (
    ON_CHAIN_CHANNEL_STATES.has(channelState) ||
    (instance.presentation !== 'off-chain-my-turn' &&
      instance.presentation !== 'off-chain-their-turn')
  ) {
    return instance;
  }
  const presentation = isMyTurn ? 'off-chain-my-turn' : 'off-chain-their-turn';
  return presentation === instance.presentation ? instance : { ...instance, presentation };
}

export function gameInstanceView(instance: GameInstanceModel): GameInstanceViewModel {
  const base = { id: instance.id, amount: instance.amount, terminal: instance.terminal };
  const mapping: Record<
    GameProtocolPresentation,
    Pick<GameInstanceViewModel, 'coin' | 'handStatus'>
  > = {
    'off-chain-my-turn': {
      coin: { coinHex: instance.coinHex, turnState: 'my-turn', onChain: false },
      handStatus: 'active',
    },
    'off-chain-their-turn': {
      coin: { coinHex: instance.coinHex, turnState: 'their-turn', onChain: false },
      handStatus: 'active',
    },
    'on-chain-my-turn': {
      coin: { coinHex: instance.coinHex, turnState: 'my-turn', onChain: true },
      handStatus: 'our-turn',
    },
    'on-chain-their-turn': {
      coin: { coinHex: instance.coinHex, turnState: 'their-turn', onChain: true },
      handStatus: 'their-turn',
    },
    'playing-move': {
      coin: { coinHex: instance.coinHex, turnState: 'playing-on-chain', onChain: true },
      handStatus: 'playing-move',
    },
    'replaying-move': {
      coin: { coinHex: instance.coinHex, turnState: 'replaying', onChain: true },
      handStatus: 'replaying-move',
    },
    'illegal-move': {
      coin: { coinHex: instance.coinHex, turnState: 'opponent-illegal-move', onChain: true },
      handStatus: 'slashing',
    },
    'submitting-timeout': {
      coin: { coinHex: instance.coinHex, turnState: 'submitting-timeout', onChain: true },
      handStatus: 'submitting-timeout',
    },
    finishing: {
      coin: { coinHex: instance.coinHex, turnState: 'finishing' },
      handStatus: 'finishing',
    },
    'finishing-waiting-timeout': {
      coin: {
        coinHex: instance.coinHex,
        turnState: 'finishing-waiting-timeout',
        onChain: true,
      },
      handStatus: 'finishing-waiting-timeout',
    },
    'finishing-spending': {
      coin: { coinHex: instance.coinHex, turnState: 'finishing-spending', onChain: true },
      handStatus: 'finishing-spending',
    },
    ended: { coin: { coinHex: instance.coinHex, turnState: 'ended' }, handStatus: 'ended' },
  };
  return { ...base, ...mapping[instance.presentation] };
}

type UnrollCopyChannel = Pick<
  ChannelStatusModel,
  'semanticPhase' | 'unrollInitiator' | 'unrollingStateNumber' | 'preemptingStateNumber'
>;

const finishingUnrollLabel = (opponent: boolean) =>
  opponent ? 'Finishing opponent unroll' : 'Finishing unroll';

const UNROLL_PHASE_LABEL: Record<ChannelSemanticPhase, (opponent: boolean) => string | null> = {
  submitting_channel_spend: () => null,
  unrolling: () => 'Unrolling',
  finding_state: (opponent) => (opponent ? 'Opponent unrolled' : 'Unrolled'),
  preempting: () => 'Preempting',
  finishing_waiting_timeout: finishingUnrollLabel,
  finishing_spending: finishingUnrollLabel,
  resolving: () => null,
};

const UNROLL_PHASE_DETAIL: Record<
  ChannelSemanticPhase,
  (channel: UnrollCopyChannel) => string | null
> = {
  submitting_channel_spend: () => 'Submitting channel spend',
  unrolling: (channel) =>
    channel.unrollingStateNumber != null ? `to state ${channel.unrollingStateNumber}` : null,
  finding_state: () => 'finding state',
  preempting: (channel) => {
    const landed = channel.unrollingStateNumber;
    const preempting = channel.preemptingStateNumber;
    if (landed != null && preempting != null) return `from ${landed} to ${preempting}`;
    if (landed != null) return `from ${landed}`;
    return null;
  },
  finishing_waiting_timeout: (channel) =>
    channel.unrollingStateNumber != null
      ? `waiting for timeout state ${channel.unrollingStateNumber}`
      : 'waiting for timeout',
  finishing_spending: (channel) =>
    channel.unrollingStateNumber != null ? `spending state ${channel.unrollingStateNumber}` : null,
  resolving: () => 'Resolving',
};

export function unrollActionLabel(channel: UnrollCopyChannel): string | null {
  return channel.semanticPhase
    ? UNROLL_PHASE_LABEL[channel.semanticPhase](channel.unrollInitiator === 'opponent')
    : null;
}

export function unrollActionDetail(channel: UnrollCopyChannel): string | null {
  return channel.semanticPhase ? UNROLL_PHASE_DETAIL[channel.semanticPhase](channel) : null;
}
