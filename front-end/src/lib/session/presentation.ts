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
  GameTerminalModel,
  GameTurnState,
  HandStatus,
} from './types';

export const INITIAL_GAME_TERMINAL_MODEL: GameTerminalModel = {
  type: 'none',
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
};
export const DEFAULT_GAME_COIN_MODEL: GameCoinModel = { coinHex: null, turnState: 'my-turn' };
export const ON_CHAIN_CHANNEL_STATES = new Set<ChannelStatus>([
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
]);

export interface GamePresentationModel {
  coin: GameCoinModel;
  handStatus: HandStatus;
}
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
export function isActivelyPlayingOnChain(current: GameTurnState): boolean {
  return current === 'playing-on-chain' || current === 'replaying';
}
export function gameCoinIdentityForGameStatus(
  previous: GameCoinModel,
  status: GameStatusState,
  hasNewCoinIdentity: boolean,
  retainOnChain = false,
): Pick<GameCoinModel, 'coinHex' | 'onChain'> {
  const onChain = [
    'on-chain-my-turn',
    'on-chain-their-turn',
    'replaying',
    'playing-move',
    'illegal-move-detected',
    'finishing-waiting-timeout',
    'finishing-spending',
  ].includes(status);
  return {
    coinHex: hasNewCoinIdentity ? null : previous.coinHex,
    onChain: onChain || (retainOnChain && previous.onChain === true),
  };
}

export function projectGameStatus({
  previous,
  payload,
  channelState,
}: {
  previous: GamePresentationModel;
  payload: NonTerminalGameStatusPayload;
  channelState: ChannelStatus;
}): GamePresentationModel {
  if (previous.coin.turnState === 'ended') return previous;
  const { status } = payload;
  const finishing = isFinishingGameStatus(status, payload.other_params?.game_finished);
  const preserveLocal =
    ON_CHAIN_CHANNEL_STATES.has(channelState) && (status === 'my-turn' || status === 'their-turn');
  const identity = gameCoinIdentityForGameStatus(
    previous.coin,
    status,
    payload.coin_id != null,
    preserveLocal,
  );
  if (
    preserveLocal ||
    (status === 'on-chain-my-turn' && isActivelyPlayingOnChain(previous.coin.turnState))
  ) {
    return { coin: { ...previous.coin, ...identity }, handStatus: previous.handStatus };
  }
  if (status === 'finishing-waiting-timeout') {
    return {
      coin: { ...identity, turnState: 'finishing-waiting-timeout', onChain: true },
      handStatus: 'finishing-waiting-timeout',
    };
  }
  if (status === 'finishing-spending') {
    return {
      coin: { ...identity, turnState: 'finishing-spending', onChain: true },
      handStatus: 'finishing-spending',
    };
  }
  if (status === 'my-turn' || status === 'on-chain-my-turn') {
    return {
      coin: { ...identity, turnState: finishing ? 'finishing' : 'my-turn' },
      handStatus: finishing ? 'finishing' : status === 'on-chain-my-turn' ? 'our-turn' : 'active',
    };
  }
  if (status === 'their-turn' || status === 'on-chain-their-turn') {
    const timeout = payload.other_params?.submitting_timeout_claim === true;
    return {
      coin: {
        ...identity,
        turnState: finishing ? 'finishing' : timeout ? 'submitting-timeout' : 'their-turn',
      },
      handStatus: finishing
        ? 'finishing'
        : timeout
          ? 'submitting-timeout'
          : status === 'on-chain-their-turn'
            ? 'their-turn'
            : 'active',
    };
  }
  if (status === 'replaying') {
    return { coin: { ...identity, turnState: 'replaying' }, handStatus: 'replaying-move' };
  }
  if (status === 'playing-move') {
    return { coin: { ...identity, turnState: 'playing-on-chain' }, handStatus: 'playing-move' };
  }
  if (status === 'illegal-move-detected') {
    return { coin: { ...identity, turnState: 'opponent-illegal-move' }, handStatus: 'slashing' };
  }
  throw new Error(`Unexpected game status: ${String(status)}`);
}

export function nextGameTurnAfterLocalTurn(
  current: GameTurnState,
  isMyTurn: boolean,
  channelState: ChannelStatus,
): GameTurnState {
  if (current !== 'my-turn' && current !== 'their-turn') return current;
  if (ON_CHAIN_CHANNEL_STATES.has(channelState)) return current;
  if (isMyTurn) return 'my-turn';
  return 'their-turn';
}
export function nextGamePresentationAfterLocalTurn(
  previous: GamePresentationModel,
  isMyTurn: boolean,
  channelState: ChannelStatus,
): GamePresentationModel {
  if (previous.coin.turnState !== 'my-turn' && previous.coin.turnState !== 'their-turn') {
    return previous;
  }
  const turnState = nextGameTurnAfterLocalTurn(previous.coin.turnState, isMyTurn, channelState);
  if (turnState === previous.coin.turnState) return previous;
  const handStatus = 'active';
  return turnState === previous.coin.turnState && handStatus === previous.handStatus
    ? previous
    : { coin: { ...previous.coin, turnState }, handStatus };
}

export function presentationFromView(instance: GameInstanceViewModel): GameProtocolPresentation {
  switch (instance.coin.turnState) {
    case 'my-turn':
      return instance.coin.onChain || instance.handStatus === 'our-turn'
        ? 'on-chain-my-turn'
        : 'off-chain-my-turn';
    case 'their-turn':
      return instance.coin.onChain || instance.handStatus === 'their-turn'
        ? 'on-chain-their-turn'
        : 'off-chain-their-turn';
    case 'playing-on-chain':
      return 'playing-move';
    case 'replaying':
      return 'replaying-move';
    case 'opponent-illegal-move':
      return 'illegal-move';
    case 'submitting-timeout':
      return 'submitting-timeout';
    case 'finishing':
      return 'finishing';
    case 'finishing-waiting-timeout':
      return 'finishing-waiting-timeout';
    case 'finishing-spending':
      return 'finishing-spending';
    case 'ended':
      return 'ended';
  }
}

export function gameInstanceFromView(instance: GameInstanceViewModel): GameInstanceModel {
  return {
    id: instance.id,
    amount: instance.amount,
    coinHex: instance.coin.coinHex,
    presentation: presentationFromView(instance),
    terminal: instance.terminal,
  };
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

export function nextGameInstanceAfterLocalTurn(
  instance: GameInstanceViewModel,
  isMyTurn: boolean,
  channelState: ChannelStatus,
): GameInstanceViewModel {
  const next = nextGamePresentationAfterLocalTurn(instance, isMyTurn, channelState);
  return next === instance ? instance : { ...instance, ...next };
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
