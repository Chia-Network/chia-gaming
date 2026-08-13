import type {
  ChannelStatus,
  ChannelStatusPayload,
  PeerLiveness,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { PersistedGameState } from './gameStateCodec';
import {
  DEFAULT_GAME_COIN_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  ON_CHAIN_CHANNEL_STATES,
  gameInstanceView,
  unrollActionDetail,
  unrollActionLabel,
} from './presentation';
import { RESOLVED_CHANNEL_STATES, WINDING_DOWN_CHANNEL_STATES } from './normalization';
import type {
  BetweenHandModeModel,
  ChannelStatusModel,
  GameCoinModel,
  GameDashboardViewModel,
  GameInstanceViewModel,
  GameTerminalModel,
  GameTurnState,
  HandStatus,
  ProposalGroupDisposition,
  ProposalGroupModel,
  QueuedNotificationModel,
  RegisteredGameType,
  SessionModel,
  StatusBarBalanceSegment,
} from './types';

/** Shared empty dashboard fields; setupPending / no-session override labels + action. */
export const EMPTY_DASHBOARD_VIEW_BASE: Omit<
  GameDashboardViewModel,
  'channelStatusLabel' | 'actionLabel' | 'actionEnabled' | 'actionKind'
> = {
  channelDetail: null,
  havePotato: false,
  handStatusLabel: 'No hand',
  handDetail: null,
  lifecycleRows: [],
};

export function selectProposalGroupByMemberId(
  model: SessionModel,
  memberId: string,
): ProposalGroupModel | null {
  return (
    model.betweenHand.proposalGroups.find((group) => group.memberIds.includes(memberId)) ?? null
  );
}

export function selectProposalGroupByDisposition(
  model: SessionModel,
  disposition: ProposalGroupDisposition,
): ProposalGroupModel | null {
  return (
    model.betweenHand.proposalGroups.find((group) => group.disposition === disposition) ?? null
  );
}

export function selectIncomingProposalGroup(model: SessionModel): ProposalGroupModel | null {
  return (
    selectProposalGroupByDisposition(model, 'incoming-review') ??
    selectProposalGroupByDisposition(model, 'incoming-cached')
  );
}

export function selectIProposedHand(model: SessionModel): boolean {
  if (model.game.currentHandOrigin !== null) {
    return model.game.currentHandOrigin === 'local';
  }
  if (model.game.currentHandIds.length > 0) {
    throw new Error('Game model invariant broken: current hand is missing its origin');
  }
  const proposal =
    selectProposalGroupByDisposition(model, 'accepted') ??
    selectProposalGroupByDisposition(model, 'incoming-review') ??
    selectProposalGroupByDisposition(model, 'incoming-cached') ??
    selectProposalGroupByDisposition(model, 'outgoing');
  return proposal?.origin === 'local';
}

/**
 * Per-game on-chain classifications become authoritative only once the unroll
 * result can no longer be preempted. This branch reports that boundary as a
 * resolved unroll, not as a separate "done unrolling" lifecycle state.
 */
const UNROLL_COMPLETED_HAND_STATES = new Set<ChannelStatus>(['ResolvedUnrolled', 'ResolvedStale']);

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
  | {
      state: ChannelStatusPayload['state'];
      session_disposition?: ChannelStatusPayload['session_disposition'];
    };

export function isTerminalChannelSnapshot(
  status: TerminalChannelSnapshot | null | undefined,
): boolean {
  const sessionDisposition =
    status &&
    ('sessionDisposition' in status ? status.sessionDisposition : status.session_disposition);
  return (
    sessionDisposition !== 'AwaitOutboundTerminal' &&
    (sessionDisposition === 'Abandoned' ||
      (status !== null && status !== undefined && RESOLVED_CHANNEL_STATES.has(status.state)))
  );
}

export function isPreActiveChannelStatus(state: string | null | undefined): boolean {
  return (
    state === null || state === undefined || PRE_ACTIVE_CHANNEL_STATES.has(state as ChannelStatus)
  );
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
  'finishing-waiting-timeout': 'Finalizing waiting for timeout',
  'finishing-spending': 'Finalizing spending',
  ended: 'Ended',
};

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
    (model.channel.status.state === 'ResolvedUnrolled' ||
      model.channel.status.state === 'ResolvedStale') &&
    model.game.activeIds.length > 0
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
  return (
    model.restore.restoring && (model.restore.status !== 'restored' || !model.restore.hubReconciled)
  );
}

export function selectShouldAdvertiseAvailable(model: SessionModel, phase: SessionPhase): boolean {
  return !selectRestoreBlocked(model) && (phase === 'none' || phase === 'resolved');
}

export function selectDisplayGameId(model: SessionModel): string | null {
  return model.game.activeIds[0] ?? model.game.lastDisplayedId;
}

export function selectDisplayedGameInstance(model: SessionModel): GameInstanceViewModel | null {
  const id = selectDisplayGameId(model);
  const instance = id === null ? null : model.game.instances[id];
  return instance ? gameInstanceView(instance) : null;
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
  return (
    overlayIsActive &&
    betweenHands &&
    (betweenHandMode === 'compose-proposal' ||
      (betweenHandMode === 'review-incoming-proposal' && hasReviewPeerProposal))
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
  return (
    model.channel.cleanShutdownStarted ||
    state === 'ShuttingDown' ||
    state === 'ShutdownTransactionPending'
  );
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
  setupPending?: boolean;
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
  const unrollLabel = unrollActionLabel(channel);
  if (unrollLabel) {
    const unrollDetail = unrollActionDetail(channel);
    if (unrollDetail) {
      return channel.advisory ? `${unrollDetail}: ${channel.advisory}` : unrollDetail;
    }
    return channel.advisory;
  }
  if (channel.semanticPhase) {
    const detail = unrollActionDetail(channel);
    if (detail) {
      return channel.advisory ? `${detail}: ${channel.advisory}` : detail;
    }
  }
  switch (channel.state) {
    case 'Active':
      if (channel.stateNumber != null) {
        const stateDetail = `state ${channel.stateNumber}`;
        return channel.advisory ? `${stateDetail}: ${channel.advisory}` : stateDetail;
      }
      return channel.advisory;
    case 'Failed':
      return channel.advisory ?? model.restore.error ?? 'Channel failed';
    default:
      return channel.advisory;
  }
}

function selectHandStatus(model: SessionModel): HandStatus {
  const displayed = selectDisplayedGameInstance(model);
  const terminal = displayed?.terminal ?? INITIAL_GAME_TERMINAL_MODEL;
  const coin = displayed?.coin ?? DEFAULT_GAME_COIN_MODEL;
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
      case 'finishing-waiting-timeout':
        return 'finishing-waiting-timeout';
      case 'finishing-spending':
        return 'finishing-spending';
    }
  }
  return 'active';
}

function collapsedHandStatusLabel(model: SessionModel): string {
  return HAND_STATUS_LABELS[selectHandStatus(model)];
}

function collapsedHandDetail(model: SessionModel): string | null {
  const terminal = selectDisplayedGameInstance(model)?.terminal ?? INITIAL_GAME_TERMINAL_MODEL;
  if (terminal.type === 'none') {
    return null;
  }
  return terminal.label;
}

function instanceHandStatus(instance: GameInstanceViewModel): HandStatus {
  if (instance.terminal.type !== 'none' || instance.coin.turnState === 'ended') {
    return 'ended';
  }
  return instance.handStatus;
}

function instanceTerminalDetail(instance: GameInstanceViewModel): string | null {
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
    const stored = model.game.instances[id];
    if (!stored) return [];
    const instance = gameInstanceView(stored);
    return [
      {
        id,
        label: multiple ? `Hand ${index + 1}` : 'Hand',
        statusLabel: HAND_STATUS_LABELS[instanceHandStatus(instance)],
        detail: instanceTerminalDetail(instance),
      },
    ];
  });
}

export const ABANDON_WAITING_STATES = new Set<ChannelStatus>([
  'OfferSent',
  'TransactionPending',
  'ShutdownTransactionPending',
  'GoingOnChain',
  'Unrolling',
]);

export function isChannelAbandonable(
  status: ChannelStatusModel | null | undefined,
  abandonEnabled: boolean,
): boolean {
  return (
    status?.sessionDisposition !== 'AwaitOutboundTerminal' &&
    ((status?.state === 'ShuttingDown' && status.zeroPayout === true) ||
      (abandonEnabled &&
        status !== null &&
        status !== undefined &&
        ABANDON_WAITING_STATES.has(status.state)))
  );
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
  // setupPending must win even when a finished freeze model is still mounted.
  // Accepting a new session after a terminal display leaves that model in place
  // until retireTerminalDisplay runs after async replaceSession; without this
  // override the dashboard would keep a disabled Done action for that window.
  if (options.setupPending) {
    return {
      ...EMPTY_DASHBOARD_VIEW_BASE,
      channelStatusLabel: 'Setting Up',
      actionLabel: 'Cancel',
      actionEnabled: true,
      actionKind: 'cancel',
    };
  }
  if (!model || options.hasSession === false) {
    return {
      ...EMPTY_DASHBOARD_VIEW_BASE,
      channelStatusLabel: 'No Session',
      actionLabel: 'No Session',
      actionEnabled: false,
      actionKind: 'none',
    };
  }

  const channel = model.channel.status;
  const action = dashboardActionFor(
    model,
    options.cleanShutdownGraceActive ?? false,
    options.abandonEnabled ?? false,
  );

  return {
    channelStatusLabel:
      channel.sessionDisposition === 'Abandoned'
        ? 'Abandoned'
        : channel.sessionDisposition === 'AwaitOutboundTerminal'
          ? 'Waiting for Peer'
          : (unrollActionLabel(channel) ?? CHANNEL_STATUS_LABELS[channel.state]),
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

  const onChain = ON_CHAIN_CHANNEL_STATES.has(channel.state) && channel.state !== 'ResolvedClean';
  const displayedIds = onChain ? model.game.currentHandIds : model.game.activeIds;
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
  activeGameType: RegisteredGameType;
  displayGameId: string | null;
  betweenHands: boolean;
  channelQueue: QueuedNotificationModel[];
  gameQueue: QueuedNotificationModel[];
  incomingProposalGroup: ProposalGroupModel | null;
}

export function selectGameSessionView(model: SessionModel): GameSessionViewModel {
  const displayed = selectDisplayedGameInstance(model);
  return {
    channelStatus: model.channel.status,
    gameCoin: displayed?.coin ?? DEFAULT_GAME_COIN_MODEL,
    gameTerminal: displayed?.terminal ?? INITIAL_GAME_TERMINAL_MODEL,
    currentHandAmount: model.betweenHand.lastTerms.myContribution,
    activeGameId: model.game.activeIds[0] ?? null,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    betweenHands: selectBetweenHands(model),
    channelQueue: model.channel.queue,
    gameQueue: model.game.queue,
    incomingProposalGroup: selectIncomingProposalGroup(model),
  };
}

export interface GameSpecificViewModel {
  gameType: RegisteredGameType;
  displayGameId: string | null;
  handState: PersistedGameState | null;
  turnState: GameTurnState;
  terminal: GameTerminalModel;
  terminalsById: Record<string, GameTerminalModel>;
  amountsById: Record<string, string>;
}

export function selectGameSpecificView(model: SessionModel): GameSpecificViewModel {
  const displayed = selectDisplayedGameInstance(model);
  return {
    gameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    handState: model.game.handState,
    turnState: displayed?.coin.turnState ?? DEFAULT_GAME_COIN_MODEL.turnState,
    terminal: displayed?.terminal ?? INITIAL_GAME_TERMINAL_MODEL,
    terminalsById: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [id, instance.terminal]),
    ),
    amountsById: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [id, instance.amount]),
    ),
  };
}
