import type { ChannelStatus, ChannelStatusPayload } from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import { EMPTY_COMPOSE_DRAFT_STATE } from './composeDraft';
import { gameInstanceFromView } from './presentation';
import type {
  ChannelStatusModel,
  GameInstanceModel,
  GameInstanceViewModel,
  HandTermsModel,
  SessionModel,
  SessionModelInput,
} from './types';

export const INITIAL_CHANNEL_STATUS_MODEL: ChannelStatusModel = {
  state: 'Handshaking',
  sessionDisposition: null,
  advisory: null,
  coin: null,
  coinHex: null,
  coinAmount: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
  havePotato: null,
  zeroPayout: null,
  unrollInitiator: null,
  semanticPhase: null,
  stateNumber: null,
  unrollingStateNumber: null,
  preemptingStateNumber: null,
};
export const DEFAULT_GAME_TIMEOUT_BLOCKS = 15n;
export const DEFAULT_CHANNEL_TIMEOUT_BLOCKS = 15n;
export const DEFAULT_UNROLL_TIMEOUT_BLOCKS = 15n;
export const DEFAULT_HAND_TERMS_MODEL: HandTermsModel = {
  gameType: 'calpoker',
  myContribution: 0n,
  theirContribution: 0n,
  gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
};

function parseChannelAmount(coin: unknown): string | null {
  const bytes = coerceToBytes(coin);
  if (!bytes || bytes.length < 64) return null;
  let value = 0n;
  for (let i = 64; i < bytes.length; i += 1) value = (value << 8n) + BigInt(bytes[i] & 0xff);
  return value.toString();
}
function parseAmount(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'object' && 'Amount' in value
    ? String((value as { Amount: unknown }).Amount)
    : String(value);
}
export function channelStatusModelFromPayload(status: ChannelStatusPayload): ChannelStatusModel {
  const coinAmount = parseChannelAmount(status.coin);
  const resolved = status.state === 'ResolvedUnrolled' || status.state === 'ResolvedStale';
  return {
    state: status.state,
    sessionDisposition: status.session_disposition ?? null,
    advisory: status.advisory ?? null,
    coin: coerceToBytes(status.coin),
    coinHex: null,
    coinAmount,
    ourBalance: resolved ? (coinAmount ?? '0') : parseAmount(status.our_balance),
    theirBalance: parseAmount(status.their_balance),
    gameAllocated: parseAmount(status.game_allocated),
    havePotato: status.have_potato ?? null,
    zeroPayout: status.zero_payout ?? null,
    unrollInitiator: status.unroll_initiator ?? null,
    semanticPhase: status.semantic_phase ?? null,
    stateNumber: status.state_number ?? null,
    unrollingStateNumber: status.unrolling_state_number ?? null,
    preemptingStateNumber: status.preempting_state_number ?? null,
  };
}
export function channelStatusPayloadFromModel(status: ChannelStatusModel): ChannelStatusPayload {
  return {
    state: status.state,
    session_disposition: status.sessionDisposition,
    advisory: status.advisory,
    coin: status.coin,
    our_balance: status.ourBalance,
    their_balance: status.theirBalance,
    game_allocated: status.gameAllocated,
    have_potato: status.havePotato,
    zero_payout: status.zeroPayout,
    unroll_initiator: status.unrollInitiator,
    semantic_phase: status.semanticPhase,
    state_number: status.stateNumber,
    unrolling_state_number: status.unrollingStateNumber,
    preempting_state_number: status.preemptingStateNumber,
  };
}

function canonicalInstance(instance: GameInstanceModel | GameInstanceViewModel): GameInstanceModel {
  return 'presentation' in instance ? instance : gameInstanceFromView(instance);
}

export function createSessionModel(partial: SessionModelInput = {}): SessionModel {
  const game = partial.game ?? {};
  const instances = Object.fromEntries(
    Object.entries(game.instances ?? {}).map(([id, instance]) => [id, canonicalInstance(instance)]),
  );
  return {
    restore: {
      restoring: false,
      status: 'idle',
      error: null,
      hubReconciled: false,
      ...partial.restore,
    },
    peer: { connected: null, ...partial.peer },
    channel: {
      status: INITIAL_CHANNEL_STATUS_MODEL,
      connection: { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
      cleanShutdownStarted: false,
      dismissedChannelStatus: null,
      queue: [],
      ...partial.channel,
    },
    game: {
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      currentHandOrigin: null,
      lastDisplayedId: null,
      activeGameType: 'calpoker',
      handState: null,
      queue: [],
      ...game,
      instances,
    },
    betweenHand: {
      mode: 'decision',
      proposalGroups: [],
      rejectedOnceTerms: null,
      lastTerms: DEFAULT_HAND_TERMS_MODEL,
      compose: EMPTY_COMPOSE_DRAFT_STATE,
      newHandRequested: false,
      pendingRetryTerms: null,
      ...partial.betweenHand,
    },
    history: {
      humanHistory: [],
      wasmNotificationHistory: [],
      diagnosticLog: [],
      ...partial.history,
    },
    myRunningBalance: partial.myRunningBalance ?? 0n,
    lastOutcomeWin: partial.lastOutcomeWin,
  };
}
export function clearDerivedGamePresentation(model: SessionModel): SessionModel {
  return {
    ...model,
    game: {
      ...model.game,
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      currentHandOrigin: null,
      instances: {},
      lastDisplayedId: null,
      handState: null,
    },
  };
}
export function normalizeSessionPresentation(model: SessionModel): SessionModel {
  return model.channel.status.sessionDisposition === 'Abandoned'
    ? clearDerivedGamePresentation(model)
    : model;
}

export const RESOLVED_CHANNEL_STATES = new Set<ChannelStatus>([
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
  'Failed',
]);
export const WINDING_DOWN_CHANNEL_STATES = new Set<ChannelStatus>([
  'ShutdownTransactionPending',
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
  'Failed',
]);
