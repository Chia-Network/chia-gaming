import type {
  ChannelStatus,
  ChannelStatusPayload,
  GameConnectionState,
  PeerLiveness,
  SessionDisposition,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { PersistedGameState, SessionSave } from '../../hooks/save';
import { coerceToBytes } from '../../util';
import type { SettlementOutcome } from '../settlement';
import { isSettlementOutcome } from '../settlement';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';

export type GameTurnState =
  | 'my-turn'
  | 'their-turn'
  | 'playing-on-chain'
  | 'replaying'
  | 'opponent-illegal-move'
  | 'submitting-timeout'
  | 'finishing'
  | 'ended';

export type HandStatus =
  | 'none'
  | 'active'
  | 'their-turn'
  | 'our-turn'
  | 'playing-move'
  | 'replaying-move'
  | 'slashing'
  | 'submitting-timeout'
  | 'finishing'
  | 'ended';

export type GameTerminalType =
  | 'none'
  | 'settled'
  | 'insufficient-balance'
  | 'ended-cancelled'
  | 'game-error';

export type NotificationKind =
  | 'channel-state'
  | 'action-failed'
  | 'infra-error'
  | 'durability-error'
  | 'game-terminal'
  | 'proposal-rejected'
  | 'insufficient-bal';

export interface ChannelStatusModel {
  state: ChannelStatus;
  sessionDisposition: SessionDisposition | null;
  advisory: string | null;
  coin: Uint8Array | null;
  coinHex: string | null;
  coinAmount: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
  havePotato: boolean | null;
  zeroPayout: boolean | null;
  unrollInitiator: 'us' | 'opponent' | null;
  semanticPhase: ChannelStatusPayload['semantic_phase'] | null;
}

export interface GameCoinModel {
  coinHex: string | null;
  turnState: GameTurnState;
  /** Latest GameStatus is on-chain; exact coin id may still be enriching. */
  onChain?: boolean;
}

export interface GameTerminalModel {
  type: GameTerminalType;
  outcome: SettlementOutcome | null;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
}

export interface GameInstanceModel {
  id: string;
  amount: string;
  coin: GameCoinModel;
  handStatus: HandStatus;
  terminal: GameTerminalModel;
}

export interface QueuedNotificationModel {
  id: bigint;
  kind: NotificationKind;
  title: string;
  message: string;
  payload?: ChannelStatusModel | {
    label: string;
    myReward: string | null;
    rewardCoinHex: string | null;
  };
}

export interface HandTermsModel {
  gameType: string;
  myContribution: bigint;
  theirContribution: bigint;
  gameTimeout: bigint;
  spacepokerUnitSize?: bigint;
}

export interface BetweenHandProposalModel {
  id: string;
  groupIds: string[];
  terms: HandTermsModel;
}

export type BetweenHandModeModel =
  | 'decision'
  | 'compose-proposal'
  | 'review-incoming-proposal';

export interface RestoreModel {
  restoring: boolean;
  status: RestoreStatus;
  error: string | null;
  hubReconciled: boolean;
}

export interface PeerModel {
  connected: boolean | null;
}

export interface ChannelModel {
  status: ChannelStatusModel;
  connection: GameConnectionState;
  cleanShutdownStarted: boolean;
  dismissedChannelStatus: ChannelStatus | null;
  queue: QueuedNotificationModel[];
}

export interface GameModel {
  coin: GameCoinModel;
  handStatus: HandStatus;
  terminal: GameTerminalModel;
  handKey: number;
  activeIds: string[];
  currentHandIds: string[];
  instances: Record<string, GameInstanceModel>;
  lastDisplayedId: string | null;
  activeGameType: string;
  handState: PersistedGameState | null;
  queue: QueuedNotificationModel[];
}

export interface BetweenHandModel {
  mode: BetweenHandModeModel;
  cachedPeerProposal: BetweenHandProposalModel | null;
  reviewPeerProposal: BetweenHandProposalModel | null;
  rejectedOnceTerms: HandTermsModel | null;
  lastTerms: HandTermsModel;
  composePerHandAmount: bigint;
  composeGameTimeout: bigint;
  composeGameType: string;
  composeProposalSent: boolean;
  newHandRequested: boolean;
  outgoingProposalIds: string[];
  outgoingProposalGroupIds: string[][];
  acceptedProposalGroupIds: string[][];
  outgoingProposalTerms: Record<string, HandTermsModel>;
  pendingRetryTerms: HandTermsModel | null;
}

export interface SessionHistoryModel {
  humanHistory: string[];
  wasmNotificationHistory: string[];
  diagnosticLog: string[];
}

export interface SessionModel {
  restore: RestoreModel;
  peer: PeerModel;
  channel: ChannelModel;
  game: GameModel;
  betweenHand: BetweenHandModel;
  history: SessionHistoryModel;
  myRunningBalance: bigint;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
}

export interface SessionModelInput {
  restore?: Partial<RestoreModel>;
  peer?: Partial<PeerModel>;
  channel?: Partial<ChannelModel>;
  game?: Partial<GameModel>;
  betweenHand?: Partial<BetweenHandModel>;
  history?: Partial<SessionHistoryModel>;
  myRunningBalance?: bigint;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
}

export type GameDashboardActionKind =
  | 'none'
  | 'cancel'
  | 'clean-shutdown'
  | 'go-on-chain'
  | 'abandon';

export type GameDashboardActionLabel =
  | 'No Session'
  | 'Cancel'
  | 'Waiting'
  | 'Clean Shutdown'
  | 'Go On-Chain'
  | 'Abandon'
  | 'Done';

export interface GameDashboardViewModel {
  channelStatusLabel: string;
  channelDetail: string | null;
  havePotato: boolean;
  handStatusLabel: string;
  handDetail: string | null;
  lifecycleRows: Array<{
    id: string;
    label: string;
    statusLabel: string;
    detail: string | null;
  }>;
  actionLabel: GameDashboardActionLabel;
  actionEnabled: boolean;
  actionKind: GameDashboardActionKind;
}

/// One labeled balance shown in the status bar header. `value` is a raw mojo
/// string the renderer formats, except for the error convention where it may be
/// a literal like `?`. `value2` is the opponent side of a terminal payout.
export interface StatusBarBalanceSegment {
  label: string;
  value: string;
  value2?: string;
}

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
};

function parseChannelAmount(coin: unknown): string | null {
  const bytes = coerceToBytes(coin);
  if (!bytes || bytes.length < 64) return null;
  let value = 0n;
  for (let i = 64; i < bytes.length; i += 1) {
    value = (value << 8n) + BigInt(bytes[i] & 0xff);
  }
  return value.toString();
}

function parseChannelAmountValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'Amount' in value) {
    return String((value as { Amount: unknown }).Amount);
  }
  return String(value);
}

export function channelStatusModelFromPayload(status: ChannelStatusPayload): ChannelStatusModel {
  const coin = coerceToBytes(status.coin);
  const coinAmount = parseChannelAmount(status.coin);
  const resolvedFromUnroll = status.state === 'ResolvedUnrolled' || status.state === 'ResolvedStale';
  return {
    state: status.state,
    sessionDisposition: status.session_disposition ?? null,
    advisory: status.advisory ?? null,
    coin,
    coinHex: null,
    coinAmount,
    ourBalance: resolvedFromUnroll ? (coinAmount ?? '0') : parseChannelAmountValue(status.our_balance),
    theirBalance: parseChannelAmountValue(status.their_balance),
    gameAllocated: parseChannelAmountValue(status.game_allocated),
    havePotato: status.have_potato ?? null,
    zeroPayout: status.zero_payout ?? null,
    unrollInitiator: status.unroll_initiator ?? null,
    semanticPhase: status.semantic_phase ?? null,
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
  };
}

export const INITIAL_GAME_TERMINAL_MODEL: GameTerminalModel = {
  type: 'none',
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
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

export const ON_CHAIN_CHANNEL_STATES = new Set<ChannelStatus>([
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
]);

/**
 * Per-game on-chain classifications become authoritative only once the unroll
 * result can no longer be preempted. This branch reports that boundary as a
 * resolved unroll, not as a separate "done unrolling" lifecycle state.
 */
const UNROLL_COMPLETED_HAND_STATES = new Set<ChannelStatus>([
  'ResolvedUnrolled',
  'ResolvedStale',
]);

export const PRE_ACTIVE_CHANNEL_STATES = new Set<ChannelStatus>([
  'Handshaking',
  'WaitingForHeightToOffer',
  'WaitingForHeightToAccept',
  'OurWalletMakingOffer',
  'OurWalletMakingOfferAcceptance',
  'OfferSent',
  'TransactionPending',
]);

type TerminalChannelSnapshot =
  | Pick<ChannelStatusModel, 'state' | 'sessionDisposition'>
  | Pick<ChannelStatusPayload, 'state' | 'session_disposition'>;

export function isTerminalChannelSnapshot(
  status: TerminalChannelSnapshot | null | undefined,
): boolean {
  const sessionDisposition = status && ('sessionDisposition' in status
    ? status.sessionDisposition
    : status.session_disposition);
  return sessionDisposition !== 'AwaitOutboundTerminal'
    && (sessionDisposition === 'Abandoned'
      || (status !== null && status !== undefined && RESOLVED_CHANNEL_STATES.has(status.state)));
}

export function isPreActiveChannelStatus(state: string | null | undefined): boolean {
  return state === null || state === undefined || PRE_ACTIVE_CHANNEL_STATES.has(state as ChannelStatus);
}

const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  Handshaking: 'Handshaking',
  WaitingForHeightToOffer: 'Waiting For Height To Offer',
  WaitingForHeightToAccept: 'Waiting For Height To Accept',
  OurWalletMakingOffer: 'Our Wallet Making Offer',
  OurWalletMakingOfferAcceptance: 'Our Wallet Making Offer Acceptance',
  OfferSent: 'Offer Sent',
  TransactionPending: 'Making Channel',
  Active: 'Active',
  ShuttingDown: 'Shutting Down',
  ShutdownTransactionPending: 'Shutting Down',
  GoingOnChain: 'Going On Chain',
  Unrolling: 'Unrolling',
  ResolvedClean: 'Resolved Clean',
  ResolvedUnrolled: 'Resolved Unrolled',
  ResolvedStale: 'Resolved Stale',
  Failed: 'Failed',
};

const HAND_STATUS_LABELS: Record<HandStatus, string> = {
  none: 'No hand',
  active: 'Active',
  'their-turn': 'Their turn',
  'our-turn': 'Your turn',
  'playing-move': 'Playing move',
  'replaying-move': 'Replaying move',
  slashing: 'Slashing cheater',
  'submitting-timeout': 'Submitting timeout claim',
  finishing: 'Finishing',
  ended: 'Ended',
};

export function createSessionModel(partial: SessionModelInput = {}): SessionModel {
  const channel = partial.channel ?? {};
  const game = partial.game ?? {};
  const betweenHand = partial.betweenHand ?? {};
  const history = partial.history ?? {};

  return {
    restore: {
      restoring: false,
      status: 'idle',
      error: null,
      hubReconciled: false,
      ...partial.restore,
    },
    peer: {
      connected: null,
      ...partial.peer,
    },
    channel: {
      status: INITIAL_CHANNEL_STATUS_MODEL,
      connection: { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
      cleanShutdownStarted: false,
      dismissedChannelStatus: null,
      queue: [],
      ...channel,
    },
    game: {
      coin: { coinHex: null, turnState: 'my-turn' },
      handStatus: 'none',
      terminal: INITIAL_GAME_TERMINAL_MODEL,
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      instances: {},
      lastDisplayedId: null,
      activeGameType: 'calpoker',
      handState: null,
      queue: [],
      ...game,
    },
    betweenHand: {
      mode: 'decision',
      cachedPeerProposal: null,
      reviewPeerProposal: null,
      rejectedOnceTerms: null,
      lastTerms: DEFAULT_HAND_TERMS_MODEL,
      composePerHandAmount: 0n,
      composeGameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
      composeGameType: 'calpoker',
      composeProposalSent: false,
      newHandRequested: false,
      outgoingProposalIds: [],
      outgoingProposalGroupIds: [],
      acceptedProposalGroupIds: [],
      outgoingProposalTerms: {},
      pendingRetryTerms: null,
      ...betweenHand,
    },
    history: {
      humanHistory: [],
      wasmNotificationHistory: [],
      diagnosticLog: [],
      ...history,
    },
    myRunningBalance: partial.myRunningBalance ?? 0n,
    lastOutcomeWin: partial.lastOutcomeWin,
  };
}

/**
 * Abandonment is a terminal session disposition, not a per-game outcome. Keep
 * the authoritative channel snapshot but discard local game/hand presentation
 * that cannot receive a corresponding terminal game event.
 */
export function clearDerivedGamePresentation(model: SessionModel): SessionModel {
  return {
    ...model,
    game: {
      ...model.game,
      coin: { coinHex: null, turnState: 'my-turn' },
      handStatus: 'none',
      terminal: INITIAL_GAME_TERMINAL_MODEL,
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      instances: {},
      lastDisplayedId: null,
      handState: null,
    },
  };
}

export function isWindingDownChannelStatus(state: ChannelStatus): boolean {
  return WINDING_DOWN_CHANNEL_STATES.has(state);
}

export function selectSessionPhase(
  model: SessionModel,
  hostOnChain = false,
): Exclude<SessionPhase, 'none'> {
  if (model.channel.status.sessionDisposition === 'Abandoned') return 'resolved';
  if (model.channel.status.sessionDisposition === 'AwaitOutboundTerminal') return 'off-chain';
  if (
    (model.channel.status.state === 'ResolvedUnrolled'
      || model.channel.status.state === 'ResolvedStale')
    && model.game.activeIds.length > 0
  ) {
    return 'on-chain';
  }
  if (isTerminalChannelSnapshot(model.channel.status)) return 'resolved';
  // `go_on_chain` reports success synchronously, but the authoritative
  // GoingOnChain notification follows through the asynchronous event queue.
  // The controller-only result prevents that gap from downgrading Shell back
  // to off-chain; it is intentionally never persisted.
  if (hostOnChain) return 'on-chain';
  if (model.channel.status.state === 'ShutdownTransactionPending') return 'off-chain';
  if (isWindingDownChannelStatus(model.channel.status.state)) {
    return 'on-chain';
  }
  return 'off-chain';
}

export function selectRestoreBlocked(model: SessionModel): boolean {
  return model.restore.restoring
    && (model.restore.status !== 'restored' || !model.restore.hubReconciled);
}

export function selectShouldAdvertiseAvailable(model: SessionModel, phase: SessionPhase): boolean {
  return !selectRestoreBlocked(model) && (phase === 'none' || phase === 'resolved');
}

export function selectDefaultCalpokerProposalMyTurn(iStarted: boolean): boolean {
  return !iStarted;
}

export function selectDefaultCalpokerInitialTurn(iStarted: boolean): GameTurnState {
  return iStarted ? 'their-turn' : 'my-turn';
}

export function selectComposeAmountAfterGameTypeChoice(
  currentGameType: string,
  selectedGameType: string,
  currentAmount: bigint,
): bigint {
  return selectedGameType === 'krunk' && currentGameType !== 'krunk'
    ? 100n
    : currentAmount;
}

export function selectDisplayGameId(model: SessionModel): string | null {
  return model.game.activeIds[0] ?? model.game.lastDisplayedId;
}

function selectDisplayedGameInstance(model: SessionModel): GameInstanceModel | null {
  const id = selectDisplayGameId(model);
  return id === null ? null : model.game.instances[id] ?? null;
}

export function selectBetweenHands(model: SessionModel): boolean {
  return model.game.handKey > 0 && model.game.activeIds.length === 0;
}

/**
 * A compose/review dialog leaves the completed hand mounted beneath it so the
 * terminal presentation remains visible and preserves its local state. The
 * background must be inert while the modal owns interaction and focus.
 */
export function selectInertGameInterfaceForBetweenHandDialog(
  betweenHands: boolean,
  betweenHandMode: BetweenHandModeModel,
  hasReviewPeerProposal: boolean,
  overlayIsActive: boolean,
): boolean {
  return overlayIsActive
    && betweenHands
    && (
      betweenHandMode === 'compose-proposal'
      || (betweenHandMode === 'review-incoming-proposal' && hasReviewPeerProposal)
    );
}

export interface ShellViewModel {
  restoreBlocked: boolean;
  canAdvertiseAvailable: boolean;
  sessionError: boolean;
}

export function selectShellView(model: SessionModel, phase: SessionPhase): ShellViewModel {
  const restoreBlocked = selectRestoreBlocked(model);
  return {
    restoreBlocked,
    canAdvertiseAvailable: selectShouldAdvertiseAvailable(model, phase),
    sessionError: model.restore.status === 'failed',
  };
}

export type GameTabDotColor = 'green' | 'yellow' | 'red' | 'gray';

/** True while a cooperative close is in flight (not yet terminal). */
export function isCleanShutdownInProgress(model: SessionModel | null): boolean {
  if (!model) return false;
  const state = model.channel.status.state;
  return model.channel.cleanShutdownStarted
    || state === 'ShuttingDown'
    || state === 'ShutdownTransactionPending';
}

/**
 * Game-tab connectivity dot. Clean shutdown keeps the peer live (keepalives
 * continue); yellow only if the peer becomes unreachable. Red is for genuine
 * errors / FOAD-style peer death outside cooperative close.
 */
export function selectGameTabDotColor(args: {
  sessionPhase: SessionPhase;
  sessionError: boolean;
  peerLiveness: PeerLiveness;
  cleanShutdownInProgress: boolean;
}): GameTabDotColor {
  const { sessionPhase, sessionError, peerLiveness, cleanShutdownInProgress } = args;
  if (sessionPhase === 'none' || sessionPhase === 'resolved') return 'gray';
  if (sessionError) return 'red';
  if (cleanShutdownInProgress) {
    // Peer should not be marked dead during cooperative close; if liveness
    // still reports dead/degraded, treat it as unreachable rather than error.
    if (peerLiveness === 'dead' || peerLiveness === 'degraded') return 'yellow';
    return 'green';
  }
  if (peerLiveness === 'dead') return 'red';
  if (sessionPhase === 'on-chain' || peerLiveness === 'degraded') return 'yellow';
  if (peerLiveness === 'connected') return 'green';
  return 'gray';
}

export interface GameDashboardSelectorOptions {
  hasSession?: boolean;
  cleanShutdownGraceActive?: boolean;
  abandonEnabled?: boolean;
}

function channelStatusDetail(model: SessionModel): string | null {
  const channel = model.channel.status;
  if (channel.sessionDisposition === 'Abandoned') {
    return channel.advisory ?? 'Session abandoned';
  }
  if (channel.sessionDisposition === 'AwaitOutboundTerminal') {
    return channel.advisory ?? 'Waiting for peer to acknowledge close';
  }
  const phaseLabels: Record<NonNullable<ChannelStatusModel['semanticPhase']>, string> = {
    submitting_channel_spend: 'Submitting channel spend',
    resolving_opponent_channel_spend: 'Resolving opponent channel spend',
    preempting: 'Preempting unroll',
    waiting_timeout: 'Waiting for timeout',
    submitting_timeout_finish: 'Submitting timeout finish',
    resolving: 'Resolving',
  };
  if (channel.semanticPhase) {
    const phase = phaseLabels[channel.semanticPhase];
    const initiator = channel.unrollInitiator === 'us'
      ? ' (initiated by you)'
      : channel.unrollInitiator === 'opponent'
        ? ' (initiated by opponent)'
        : '';
    const detail = `${phase}${initiator}`;
    return channel.advisory ? `${detail}: ${channel.advisory}` : detail;
  }
  switch (channel.state) {
    case 'Failed':
      return channel.advisory ?? model.restore.error ?? 'Channel failed';
    default:
      return channel.advisory;
  }
}

function selectHandStatus(model: SessionModel): HandStatus {
  const displayed = selectDisplayedGameInstance(model);
  const terminal = displayed?.terminal ?? model.game.terminal;
  const coin = displayed?.coin ?? model.game.coin;
  if (terminal.type !== 'none' || coin.turnState === 'ended') {
    return 'ended';
  }
  if (model.game.activeIds.length === 0) {
    return 'none';
  }
  // The unroll commitment can still be preempted while GoingOnChain or
  // Unrolling. Per-game coin/turn classifications are not authoritative until
  // the unroll coin resolves, irrespective of asynchronous coin-id enrichment.
  if (!UNROLL_COMPLETED_HAND_STATES.has(model.channel.status.state)) {
    return 'active';
  }
  if (ON_CHAIN_CHANNEL_STATES.has(model.channel.status.state)) {
    switch (coin.turnState) {
      case 'my-turn':
        return 'our-turn';
      // We detected the opponent's illegal on-chain move and are now resolving
      // the slash; surface that explicitly rather than a generic "our turn".
      case 'opponent-illegal-move':
        return 'slashing';
      case 'submitting-timeout':
        return 'submitting-timeout';
      case 'their-turn':
        return 'their-turn';
      case 'playing-on-chain':
        return 'playing-move';
      case 'replaying':
        return 'replaying-move';
      case 'finishing':
        return 'finishing';
    }
  }
  return 'active';
}

function collapsedHandStatusLabel(model: SessionModel): string {
  return HAND_STATUS_LABELS[selectHandStatus(model)];
}

function collapsedHandDetail(model: SessionModel): string | null {
  const terminal = selectDisplayedGameInstance(model)?.terminal ?? model.game.terminal;
  if (terminal.type === 'none') {
    return null;
  }
  return terminal.label;
}

function instanceHandStatus(instance: GameInstanceModel): HandStatus {
  if (instance.terminal.type !== 'none' || instance.coin.turnState === 'ended') {
    return 'ended';
  }
  return instance.handStatus;
}

function instanceTerminalDetail(instance: GameInstanceModel): string | null {
  const terminal = instance.terminal;
  if (terminal.type === 'none') {
    return null;
  }
  return terminal.label;
}

function selectLifecycleRows(model: SessionModel): GameDashboardViewModel['lifecycleRows'] {
  if (!UNROLL_COMPLETED_HAND_STATES.has(model.channel.status.state)) {
    return [];
  }
  const multiple = model.game.currentHandIds.length > 1;
  return model.game.currentHandIds.flatMap((id, index) => {
    const instance = model.game.instances[id];
    if (!instance) return [];
    return [{
      id,
      label: multiple ? `Hand ${index + 1}` : 'Hand',
      statusLabel: HAND_STATUS_LABELS[instanceHandStatus(instance)],
      detail: instanceTerminalDetail(instance),
    }];
  });
}

export const ABANDON_WAITING_STATES = new Set<ChannelStatus>([
  'OfferSent', 'TransactionPending', 'ShutdownTransactionPending',
  'GoingOnChain', 'Unrolling',
]);

export function isChannelAbandonable(
  status: ChannelStatusModel | null | undefined,
  abandonEnabled: boolean,
): boolean {
  return status?.sessionDisposition !== 'AwaitOutboundTerminal'
    && ((status?.state === 'ShuttingDown' && status.zeroPayout === true)
    || (abandonEnabled && status !== null && status !== undefined
      && ABANDON_WAITING_STATES.has(status.state)));
}

function dashboardActionFor(
  model: SessionModel,
  cleanShutdownGraceActive: boolean,
  abandonEnabled: boolean,
): Pick<GameDashboardViewModel, 'actionLabel' | 'actionEnabled' | 'actionKind'> {
  if (isTerminalChannelSnapshot(model.channel.status)) {
    return { actionLabel: 'Done', actionEnabled: false, actionKind: 'none' };
  }
  if (model.channel.status.sessionDisposition === 'AwaitOutboundTerminal') {
    return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
  }
  switch (model.channel.status.state) {
    case 'Handshaking':
    case 'WaitingForHeightToOffer':
    case 'WaitingForHeightToAccept':
    case 'OurWalletMakingOffer':
    case 'OurWalletMakingOfferAcceptance':
      return { actionLabel: 'Cancel', actionEnabled: true, actionKind: 'cancel' };
    case 'OfferSent':
    case 'TransactionPending':
      if (abandonEnabled) {
        return { actionLabel: 'Abandon', actionEnabled: true, actionKind: 'abandon' };
      }
      return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
    case 'Active':
      if (model.game.activeIds.length > 0) {
        return { actionLabel: 'Go On-Chain', actionEnabled: true, actionKind: 'go-on-chain' };
      }
      if (cleanShutdownGraceActive) {
        return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
      }
      return { actionLabel: 'Clean Shutdown', actionEnabled: true, actionKind: 'clean-shutdown' };
    case 'ShuttingDown':
      if (model.channel.status.zeroPayout) {
        return { actionLabel: 'Abandon', actionEnabled: true, actionKind: 'abandon' };
      }
      if (cleanShutdownGraceActive) {
        return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
      }
      return { actionLabel: 'Go On-Chain', actionEnabled: true, actionKind: 'go-on-chain' };
    case 'ShutdownTransactionPending':
      if (model.channel.status.zeroPayout) {
        return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
      }
      if (abandonEnabled) {
        return { actionLabel: 'Abandon', actionEnabled: true, actionKind: 'abandon' };
      }
      return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
    case 'GoingOnChain':
    case 'Unrolling':
      if (abandonEnabled) {
        return { actionLabel: 'Abandon', actionEnabled: true, actionKind: 'abandon' };
      }
      return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
    case 'ResolvedClean':
    case 'ResolvedUnrolled':
    case 'ResolvedStale':
    case 'Failed':
      return { actionLabel: 'Done', actionEnabled: false, actionKind: 'none' };
  }
}

export function selectGameDashboardView(
  model: SessionModel | null,
  options: GameDashboardSelectorOptions = {},
): GameDashboardViewModel {
  if (!model || options.hasSession === false) {
    return {
      channelStatusLabel: 'No Session',
      channelDetail: null,
      havePotato: false,
      handStatusLabel: 'No hand',
      handDetail: null,
      lifecycleRows: [],
      actionLabel: 'No Session',
      actionEnabled: false,
      actionKind: 'none',
    };
  }

  const channel = model.channel.status;
  const action = dashboardActionFor(model, options.cleanShutdownGraceActive ?? false, options.abandonEnabled ?? false);

  return {
    channelStatusLabel: channel.sessionDisposition === 'Abandoned'
      ? 'Abandoned'
      : channel.sessionDisposition === 'AwaitOutboundTerminal'
        ? 'Waiting for Peer'
        : CHANNEL_STATUS_LABELS[channel.state],
    channelDetail: channelStatusDetail(model),
    havePotato: channel.havePotato === true,
    handStatusLabel: collapsedHandStatusLabel(model),
    handDetail: collapsedHandDetail(model),
    lifecycleRows: selectLifecycleRows(model),
    ...action,
  };
}

/// Derive the compact balance strip shown in the status bar header.
///
/// Layout starts with `Me` / `Opp`, followed by one segment per accepted game:
/// - `Me` / `Opp` are the channel's out-of-game balances.
/// - off-chain, only unresolved games show their individual total amount.
/// - on-chain, the current hand may show terminal player/opponent payout splits.
/// - Clean shutdown: no hand, so `Me`/`Opp` show the final balances ("change").
/// - Channel error: `Me 0` / `Opp ?`.
export function selectStatusBarBalances(
  model: SessionModel | null,
): StatusBarBalanceSegment[] | null {
  if (!model) {
    return null;
  }

  const channel = model.channel.status;

  if (channel.state === 'Failed') {
    return [
      { label: 'Me', value: '0' },
      { label: 'Opp', value: '?' },
    ];
  }

  const ours = channel.ourBalance;
  const theirs = channel.theirBalance;
  if (ours == null || theirs == null) {
    return null;
  }

  // A *channel* clean shutdown (distinct from a hand ending) has no hand pot;
  // Me/Opp show the final balances ("change").
  const cleanShutdown =
    channel.state === 'ShuttingDown' ||
    channel.state === 'ShutdownTransactionPending' ||
    channel.state === 'ResolvedClean';
  if (cleanShutdown) {
    return [
      { label: 'Me', value: ours },
      { label: 'Opp', value: theirs },
    ];
  }

  const segments: StatusBarBalanceSegment[] = [
    { label: 'Me', value: ours },
    { label: 'Opp', value: theirs },
  ];

  const onChain =
    ON_CHAIN_CHANNEL_STATES.has(channel.state)
    && channel.state !== 'ResolvedClean';
  const displayedIds = onChain
    ? model.game.currentHandIds
    : model.game.activeIds;
  const multiple = displayedIds.length > 1;
  displayedIds.forEach((id, index) => {
    const instance = model.game.instances[id];
    if (!instance) return;
    const label = multiple ? `Hand ${index + 1}` : 'Hand';
    try {
      const amount = BigInt(instance.amount);
      if (amount < 0n) return;
      if (instance.terminal.type === 'none') {
        segments.push({ label, value: amount.toString() });
        return;
      }
      if (instance.terminal.myReward == null) return;
      const myReward = BigInt(instance.terminal.myReward);
      if (myReward < 0n || myReward > amount) return;
      segments.push({
        label,
        value: myReward.toString(),
        value2: (amount - myReward).toString(),
      });
    } catch {
      // A malformed game amount/reward cannot produce a trustworthy display.
    }
  });

  return segments;
}

export interface GameSessionViewModel {
  channelStatus: ChannelStatusModel;
  gameCoin: GameCoinModel;
  gameTerminal: GameTerminalModel;
  currentHandAmount: bigint;
  activeGameId: string | null;
  activeGameIds: string[];
  activeGameType: string;
  displayGameId: string | null;
  betweenHands: boolean;
  channelQueue: QueuedNotificationModel[];
  gameQueue: QueuedNotificationModel[];
}

export function selectGameSessionView(model: SessionModel): GameSessionViewModel {
  const displayed = selectDisplayedGameInstance(model);
  return {
    channelStatus: model.channel.status,
    gameCoin: displayed?.coin ?? model.game.coin,
    gameTerminal: displayed?.terminal ?? model.game.terminal,
    currentHandAmount: model.betweenHand.lastTerms.myContribution,
    activeGameId: model.game.activeIds[0] ?? null,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    betweenHands: selectBetweenHands(model),
    channelQueue: model.channel.queue,
    gameQueue: model.game.queue,
  };
}

export interface GameSpecificViewModel {
  gameType: string;
  displayGameId: string | null;
  handState: PersistedGameState | null;
  turnState: GameTurnState;
  terminal: GameTerminalModel;
}

export function selectGameSpecificView(model: SessionModel): GameSpecificViewModel {
  const displayed = selectDisplayedGameInstance(model);
  return {
    gameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    handState: model.game.handState,
    turnState: displayed?.coin.turnState ?? model.game.coin.turnState,
    terminal: displayed?.terminal ?? model.game.terminal,
  };
}

function parseBigintString(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function parsePositiveBigintString(value: string | undefined, fallback: bigint): bigint {
  const parsed = parseBigintString(value, fallback);
  return parsed > 0n ? parsed : fallback;
}

function requireBigintString(value: string | undefined, label: string): bigint {
  if (!value) throw new Error(`Garbled save: missing ${label}`);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Garbled save: invalid ${label}: ${value}`);
  }
}

export function sessionAmountsFromSave(
  save: Pick<SessionSave, 'myContribution' | 'theirContribution' | 'perGameAmount'>,
): { myContribution: bigint; theirContribution: bigint; perGameAmount: bigint } {
  const myContribution = requireBigintString(save.myContribution, 'myContribution');
  const theirContribution = requireBigintString(save.theirContribution, 'theirContribution');
  const perGameAmount = requireBigintString(save.perGameAmount, 'perGameAmount');
  return {
    myContribution,
    theirContribution,
    perGameAmount,
  };
}

type SavedHandTerms = {
  my_contribution: string;
  their_contribution: string;
  game_timeout?: string;
  game_type?: string;
  spacepoker_unit_size?: string;
};

type SavedProposal = SavedHandTerms & { id: string; groupIds: string[] };

function parseTermsSnapshot(
  saved: SavedHandTerms | null | undefined,
  fallback: HandTermsModel,
): HandTermsModel {
  if (!saved) return fallback;
  const gameType = saved.game_type ?? fallback.gameType;
  const myContribution = parseBigintString(saved.my_contribution, fallback.myContribution);
  return {
    gameType,
    myContribution,
    theirContribution: parseBigintString(saved.their_contribution, fallback.theirContribution),
    gameTimeout: parsePositiveBigintString(saved.game_timeout, fallback.gameTimeout),
    spacepokerUnitSize: gameType === 'spacepoker'
      ? parseBigintString(saved.spacepoker_unit_size, myContribution / 10n) || undefined
      : undefined,
  };
}

function parseOptionalTermsSnapshot(
  saved: SavedHandTerms | null | undefined,
  fallback: HandTermsModel,
): HandTermsModel | null {
  return saved ? parseTermsSnapshot(saved, fallback) : null;
}

function parseProposalSnapshot(
  saved: SavedProposal | null | undefined,
  fallbackTerms: HandTermsModel,
): BetweenHandProposalModel | null {
  if (!saved) return null;
  if (!Array.isArray(saved.groupIds) || saved.groupIds.length === 0) {
    throw new Error(`Garbled save: proposal ${saved.id} missing non-empty groupIds`);
  }
  return {
    id: saved.id,
    groupIds: saved.groupIds,
    terms: parseTermsSnapshot(saved, fallbackTerms),
  };
}

function parseNotificationId(id: unknown): bigint {
  if (typeof id === 'bigint') return id;
  if (typeof id === 'number' && Number.isInteger(id)) return BigInt(id);
  if (typeof id === 'string') {
    try {
      return BigInt(id);
    } catch {
      throw new Error(`Garbled save: invalid notification id: ${id}`);
    }
  }
  throw new Error(`Garbled save: missing notification id`);
}

function parseQueuedNotifications(queue: unknown): QueuedNotificationModel[] {
  if (!Array.isArray(queue)) return [];
  return queue.map((notification) => {
    const n = notification as QueuedNotificationModel & { id?: unknown };
    return {
      ...n,
      id: parseNotificationId(n.id),
    };
  });
}

export function sessionModelFromSave(save: SessionSave, perGameAmount = 0n): SessionModel {
  const fallbackTerms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: perGameAmount,
    theirContribution: perGameAmount,
    gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
  };
  const lastTerms = parseTermsSnapshot(save.betweenHandLastTerms, fallbackTerms);
  const activeIds = save.activeGameIds
    ?? (isTerminalChannelSnapshot(save.channelStatus) ? [] : undefined);
  if (activeIds === undefined) {
    throw new Error('Garbled save: missing activeGameIds');
  }
  if (!Array.isArray(activeIds)) {
    throw new Error('Garbled save: invalid activeGameIds');
  }
  const restoredActiveIds = [...activeIds];
  const currentHandIds = save.currentHandGameIds ?? restoredActiveIds;
  const instances: Record<string, GameInstanceModel> = Object.fromEntries(
    Object.entries(save.gameInstances ?? {}).map(([id, instance]) => [
      id,
      {
        id: instance.id,
        amount: instance.amount,
        coin: {
          coinHex: instance.coinHex,
          turnState: instance.turnState as GameTurnState,
          onChain: instance.onChain,
        },
        handStatus: instance.handStatus as HandStatus,
        terminal: {
          type: instance.terminal.type as GameTerminalType,
          outcome: isSettlementOutcome(instance.terminal.outcome)
            ? instance.terminal.outcome
            : null,
          label: instance.terminal.label,
          myReward: instance.terminal.myReward,
          rewardCoinHex: instance.terminal.rewardCoinHex,
        },
      },
    ]),
  );

  return createSessionModel({
    restore: {
      restoring: !!save.serializedGameSession,
      status: save.serializedGameSession ? 'restoring' : 'idle',
      error: null,
      hubReconciled: false,
    },
    channel: {
      status: save.channelStatus
        ? channelStatusModelFromPayload(save.channelStatus)
        : INITIAL_CHANNEL_STATUS_MODEL,
      connection: save.channelStatus
        ? { stateIdentifier: 'running', stateDetail: [] }
        : { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
      cleanShutdownStarted: save.cleanShutdownStarted ?? false,
      dismissedChannelStatus: (save.dismissedChannelStatus as ChannelStatus | undefined) ?? null,
      queue: parseQueuedNotifications(save.channelNotifQueue),
    },
    game: {
      coin: {
        coinHex: save.gameCoinHex ?? null,
        turnState: (() => {
          if (save.gameTurnState === undefined || save.gameTurnState === null) {
            if (restoredActiveIds.length === 0) return 'my-turn' as GameTurnState;
            throw new Error('Garbled save: missing gameTurnState');
          }
          return save.gameTurnState as GameTurnState;
        })(),
        onChain: save.gameOnChain,
      },
      handStatus: (save.gameHandStatus as HandStatus | undefined) ?? 'none',
      terminal: save.gameTerminalType && save.gameTerminalType !== 'none'
        ? {
            type: save.gameTerminalType as GameTerminalType,
            outcome: isSettlementOutcome(save.gameTerminalOutcome)
              ? save.gameTerminalOutcome
              : null,
            label: save.gameTerminalLabel ?? null,
            myReward: save.gameTerminalReward ?? null,
            rewardCoinHex: save.gameTerminalRewardCoin ?? null,
          }
        : INITIAL_GAME_TERMINAL_MODEL,
      handKey: (restoredActiveIds.length > 0 || save.handState || save.betweenHandLastTerms) ? 1 : 0,
      activeIds: restoredActiveIds,
      currentHandIds,
      instances,
      lastDisplayedId: restoredActiveIds[0] ?? null,
      activeGameType: (() => {
        if (save.activeGameType) return save.activeGameType;
        if (restoredActiveIds.length === 0) return 'calpoker';
        throw new Error('Garbled save: missing activeGameType');
      })(),
      handState: save.handState ?? null,
      queue: parseQueuedNotifications(save.gameNotifQueue),
    },
    betweenHand: (() => {
      const mode = (save.betweenHandMode as BetweenHandModeModel | undefined) ?? 'decision';
      const outgoingProposalTerms = save.outgoingProposalTerms
        ? Object.fromEntries(
            Object.entries(save.outgoingProposalTerms).map(
              ([id, saved]) => [id, parseTermsSnapshot(saved, lastTerms)]
            )
          )
        : {};
      if (
        Object.keys(outgoingProposalTerms).length > 0
        && save.outgoingProposalGroupIds === undefined
      ) {
        throw new Error('Garbled save: outgoing proposal terms missing group IDs');
      }
      const outgoingProposalGroupIds = (save.outgoingProposalGroupIds ?? []).map((groupIds, index) => {
        if (!Array.isArray(groupIds) || groupIds.length === 0) {
          throw new Error(`Garbled save: outgoing proposal group ${index} missing IDs`);
        }
        return [...groupIds];
      });
      const groupedOutgoingIds = outgoingProposalGroupIds.flat();
      const outgoingProposalIds = [
        ...groupedOutgoingIds,
        ...Object.keys(outgoingProposalTerms).filter(id => !groupedOutgoingIds.includes(id)),
      ];
      const hasOutgoing = outgoingProposalIds.length > 0;
      const acceptedProposalGroupIds = (save.acceptedProposalGroupIds ?? []).map((groupIds, index) => {
        if (!Array.isArray(groupIds) || groupIds.length === 0) {
          throw new Error(`Garbled save: accepted proposal group ${index} missing IDs`);
        }
        return [...groupIds];
      });
      return {
        mode,
        cachedPeerProposal: parseProposalSnapshot(save.betweenHandCachedPeerProposal, lastTerms),
        reviewPeerProposal: parseProposalSnapshot(save.betweenHandReviewPeerProposal, lastTerms),
        rejectedOnceTerms: parseOptionalTermsSnapshot(save.betweenHandRejectedOnceTerms, lastTerms),
        pendingRetryTerms: parseOptionalTermsSnapshot(save.betweenHandPendingRetryTerms, lastTerms),
        lastTerms,
        composePerHandAmount: parseBigintString(save.betweenHandComposePerHand, perGameAmount),
        composeGameTimeout: parsePositiveBigintString(save.betweenHandComposeGameTimeout, lastTerms.gameTimeout),
        composeGameType: save.betweenHandComposeGameType ?? lastTerms.gameType,
        composeProposalSent: hasOutgoing && mode === 'compose-proposal',
        newHandRequested: hasOutgoing && mode === 'decision',
        outgoingProposalIds,
        outgoingProposalGroupIds,
        acceptedProposalGroupIds,
        outgoingProposalTerms,
      };
    })(),
    history: {
      humanHistory: recentEntries(save.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
      wasmNotificationHistory: recentEntries(
        save.wasmNotificationHistory ?? [],
        WASM_NOTIFICATION_HISTORY_LIMIT,
      ),
      diagnosticLog: recentEntries(save.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT),
    },
    myRunningBalance: parseBigintString(save.myRunningBalance, 0n),
    lastOutcomeWin: save.lastOutcomeWin,
  });
}

export function snapshotFromSessionModel(model: SessionModel): Partial<SessionSave> {
  const termsSnapshot = (terms: HandTermsModel) => ({
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_timeout: terms.gameTimeout.toString(),
    game_type: terms.gameType,
    spacepoker_unit_size: terms.spacepokerUnitSize?.toString(),
  });

  return {
    humanHistory: model.history.humanHistory.length > 0
      ? recentEntries(model.history.humanHistory, HUMAN_HISTORY_LIMIT)
      : undefined,
    wasmNotificationHistory: model.history.wasmNotificationHistory.length > 0
      ? recentEntries(model.history.wasmNotificationHistory, WASM_NOTIFICATION_HISTORY_LIMIT)
      : undefined,
    diagnosticLog: model.history.diagnosticLog.length > 0
      ? recentEntries(model.history.diagnosticLog, DIAGNOSTIC_LOG_LIMIT)
      : undefined,
    gameCoinHex: model.game.coin.coinHex,
    gameTurnState: model.game.coin.turnState,
    gameOnChain: model.game.coin.onChain ?? undefined,
    gameHandStatus: model.game.handStatus !== 'none' ? model.game.handStatus : undefined,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    handState: model.game.handState,
    currentHandGameIds: model.game.currentHandIds.length > 0
      ? model.game.currentHandIds
      : undefined,
    gameInstances: model.game.currentHandIds.length > 0
      ? Object.fromEntries(model.game.currentHandIds.flatMap(id => {
          const instance = model.game.instances[id];
          if (!instance) return [];
          return [[id, {
            id: instance.id,
            amount: instance.amount,
            coinHex: instance.coin.coinHex,
            turnState: instance.coin.turnState,
            onChain: instance.coin.onChain ?? undefined,
            handStatus: instance.handStatus,
            terminal: instance.terminal,
          }]];
        }))
      : undefined,
    gameTerminalType: model.game.terminal.type !== 'none' ? model.game.terminal.type : undefined,
    gameTerminalOutcome: model.game.terminal.outcome ?? undefined,
    gameTerminalLabel: model.game.terminal.label,
    gameTerminalReward: model.game.terminal.myReward,
    gameTerminalRewardCoin: model.game.terminal.rewardCoinHex,
    myRunningBalance: model.myRunningBalance !== 0n ? model.myRunningBalance.toString() : undefined,
    channelNotifQueue: model.channel.queue.length > 0
      ? model.channel.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
      : undefined,
    gameNotifQueue: model.game.queue.length > 0
      ? model.game.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
      : undefined,
    dismissedChannelStatus: model.channel.dismissedChannelStatus ?? undefined,
    cleanShutdownStarted: model.channel.cleanShutdownStarted || undefined,
    betweenHandMode: model.betweenHand.mode,
    betweenHandComposePerHand: model.betweenHand.composePerHandAmount.toString(),
    betweenHandComposeGameTimeout: model.betweenHand.composeGameTimeout.toString(),
    betweenHandComposeGameType: model.betweenHand.composeGameType,
    betweenHandLastTerms: termsSnapshot(model.betweenHand.lastTerms),
    betweenHandRejectedOnceTerms: model.betweenHand.rejectedOnceTerms
      ? termsSnapshot(model.betweenHand.rejectedOnceTerms)
      : undefined,
    betweenHandPendingRetryTerms: model.betweenHand.pendingRetryTerms
      ? termsSnapshot(model.betweenHand.pendingRetryTerms)
      : undefined,
    betweenHandCachedPeerProposal: model.betweenHand.cachedPeerProposal
      ? {
          id: model.betweenHand.cachedPeerProposal.id,
          groupIds: model.betweenHand.cachedPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.cachedPeerProposal.terms),
        }
      : undefined,
    betweenHandReviewPeerProposal: model.betweenHand.reviewPeerProposal
      ? {
          id: model.betweenHand.reviewPeerProposal.id,
          groupIds: model.betweenHand.reviewPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.reviewPeerProposal.terms),
        }
      : undefined,
    outgoingProposalGroupIds: model.betweenHand.outgoingProposalGroupIds.length > 0
      ? model.betweenHand.outgoingProposalGroupIds.map(groupIds => [...groupIds])
      : undefined,
    acceptedProposalGroupIds: model.betweenHand.acceptedProposalGroupIds.length > 0
      ? model.betweenHand.acceptedProposalGroupIds.map(groupIds => [...groupIds])
      : undefined,
    outgoingProposalTerms: Object.keys(model.betweenHand.outgoingProposalTerms).length > 0
      ? Object.fromEntries(
          Object.entries(model.betweenHand.outgoingProposalTerms).map(
            ([id, terms]) => [id, termsSnapshot(terms)]
          )
        )
      : undefined,
  };
}
