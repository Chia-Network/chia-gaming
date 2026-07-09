import type {
  ChannelState,
  GameConnectionState,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { RestoreStatus } from '../../hooks/SessionController';
import type { PersistedGameState, SessionState } from '../../hooks/save';

export type GameTurnState =
  | 'my-turn'
  | 'their-turn'
  | 'playing-on-chain'
  | 'replaying'
  | 'opponent-illegal-move'
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
  | 'finishing'
  | 'ended';

export type GameTerminalType =
  | 'none'
  | 'forfeit'
  | 'we-timed-out'
  | 'opponent-timed-out'
  | 'we-slashed-opponent'
  | 'opponent-slashed-us'
  | 'opponent-successfully-cheated'
  | 'insufficient-balance'
  | 'ended-cancelled'
  | 'game-error';

export type NotificationKind =
  | 'channel-state'
  | 'session-over'
  | 'action-failed'
  | 'infra-error'
  | 'game-terminal'
  | 'proposal-rejected'
  | 'insufficient-bal';

export interface ChannelStatusModel {
  state: ChannelState;
  advisory: string | null;
  coinHex: string | null;
  coinAmount: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
  havePotato: boolean | null;
}

export interface GameCoinModel {
  coinHex: string | null;
  turnState: GameTurnState;
}

export interface GameTerminalModel {
  type: GameTerminalType;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
  cleanEnd?: boolean;
}

export interface QueuedNotificationModel {
  id: bigint;
  kind: NotificationKind;
  title: string;
  message: string;
  payload?: any;
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
  trackerReconciled: boolean;
}

export interface PeerModel {
  connected: boolean | null;
}

export interface ChannelModel {
  status: ChannelStatusModel;
  connection: GameConnectionState;
  goOnChainPressed: boolean;
  cleanShutdownStarted: boolean;
  dismissedChannelState: ChannelState | null;
  queue: QueuedNotificationModel[];
}

export interface GameModel {
  coin: GameCoinModel;
  handStatus: HandStatus;
  terminal: GameTerminalModel;
  handKey: number;
  activeIds: string[];
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

export interface SessionSnapshot {
  restore?: Partial<RestoreModel>;
  peer?: Partial<PeerModel>;
  channel?: Partial<ChannelModel>;
  game?: Partial<GameModel>;
  betweenHand?: Partial<BetweenHandModel>;
  history?: Partial<SessionHistoryModel>;
  myRunningBalance?: string;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
}

export type SessionEvent =
  | { type: 'restore-status'; status: RestoreStatus; error: string | null }
  | { type: 'tracker-reconciled'; reconciled: boolean }
  | { type: 'peer-connected'; connected: boolean | null }
  | { type: 'channel-status'; status: ChannelStatusModel }
  | { type: 'game-coin'; coin: GameCoinModel }
  | { type: 'hand-status'; status: HandStatus }
  | { type: 'game-terminal'; terminal: GameTerminalModel }
  | { type: 'between-hand'; state: Partial<BetweenHandModel> }
  | { type: 'history'; state: Partial<SessionHistoryModel> };

export type SessionIntent =
  | { type: 'go-on-chain' }
  | { type: 'clean-shutdown' }
  | { type: 'propose-game'; terms: HandTermsModel }
  | { type: 'accept-proposal'; id: string }
  | { type: 'reject-proposal'; id: string };

export type GameDashboardActionKind =
  | 'none'
  | 'cancel'
  | 'clean-shutdown'
  | 'go-on-chain';

export type GameDashboardActionLabel =
  | 'No Session'
  | 'Cancel'
  | 'Waiting'
  | 'Clean Shutdown'
  | 'Go On-Chain'
  | 'Done';

export interface GameDashboardViewModel {
  channelStatusLabel: string;
  channelDetail: string | null;
  handStatusLabel: string;
  handDetail: string | null;
  actionLabel: GameDashboardActionLabel;
  actionEnabled: boolean;
  actionKind: GameDashboardActionKind;
}

/// One labeled balance shown in the status bar header. `value` is a raw mojo
/// string the renderer formats, except for the error convention where it may be
/// a literal like `?`. When `value2` is set the segment renders as
/// `value / value2` (used for the end-of-hand mine/opp split).
export interface StatusBarBalanceSegment {
  label: string;
  value: string;
  value2?: string;
}

export const INITIAL_CHANNEL_STATUS_MODEL: ChannelStatusModel = {
  state: 'Handshaking',
  advisory: null,
  coinHex: null,
  coinAmount: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
  havePotato: null,
};

export const INITIAL_GAME_TERMINAL_MODEL: GameTerminalModel = {
  type: 'none',
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

const RESOLVED_STATES = new Set<ChannelState>([
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
  'Failed',
]);

const WINDING_DOWN_STATES = new Set<ChannelState>([
  'ShutdownTransactionPending',
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
  'Failed',
]);

const ON_CHAIN_HAND_STATES = new Set<ChannelState>([
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
]);

const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  Handshaking: 'Handshaking',
  WaitingForHeightToOffer: 'Waiting For Height To Offer',
  WaitingForHeightToAccept: 'Waiting For Height To Accept',
  MakingOffer: 'Making Offer',
  MakingOfferAcceptance: 'Making Offer Acceptance',
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
      trackerReconciled: false,
      ...partial.restore,
    },
    peer: {
      connected: null,
      ...partial.peer,
    },
    channel: {
      status: INITIAL_CHANNEL_STATUS_MODEL,
      connection: { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
      goOnChainPressed: false,
      cleanShutdownStarted: false,
      dismissedChannelState: null,
      queue: [],
      ...channel,
    },
    game: {
      coin: { coinHex: null, turnState: 'my-turn' },
      handStatus: 'none',
      terminal: INITIAL_GAME_TERMINAL_MODEL,
      handKey: 0,
      activeIds: [],
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

export function updateSessionModel(model: SessionModel, event: SessionEvent): SessionModel {
  switch (event.type) {
    case 'restore-status':
      return {
        ...model,
        restore: { ...model.restore, status: event.status, error: event.error },
      };
    case 'tracker-reconciled':
      return {
        ...model,
        restore: { ...model.restore, trackerReconciled: event.reconciled },
      };
    case 'peer-connected':
      return { ...model, peer: { connected: event.connected } };
    case 'channel-status':
      return {
        ...model,
        channel: { ...model.channel, status: event.status },
      };
    case 'game-coin':
      return {
        ...model,
        game: { ...model.game, coin: event.coin },
      };
    case 'hand-status':
      return {
        ...model,
        game: { ...model.game, handStatus: event.status },
      };
    case 'game-terminal':
      return {
        ...model,
        game: { ...model.game, terminal: event.terminal },
      };
    case 'between-hand':
      return {
        ...model,
        betweenHand: { ...model.betweenHand, ...event.state },
      };
    case 'history':
      return {
        ...model,
        history: { ...model.history, ...event.state },
      };
  }
}

export function isWindingDownChannelState(state: ChannelState): boolean {
  return WINDING_DOWN_STATES.has(state);
}

export function selectSessionPhase(model: SessionModel): Exclude<SessionPhase, 'none'> {
  if (
    (model.channel.status.state === 'ResolvedUnrolled'
      || model.channel.status.state === 'ResolvedStale')
    && model.game.activeIds.length > 0
  ) {
    return 'on-chain';
  }
  if (RESOLVED_STATES.has(model.channel.status.state)) return 'resolved';
  if (model.channel.status.state === 'ShutdownTransactionPending') return 'off-chain';
  if (model.channel.goOnChainPressed || isWindingDownChannelState(model.channel.status.state)) {
    return 'on-chain';
  }
  return 'off-chain';
}

export function selectRestoreBlocked(model: SessionModel): boolean {
  return model.restore.restoring
    && (model.restore.status !== 'restored' || !model.restore.trackerReconciled);
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

export function selectDisplayGameId(model: SessionModel): string | null {
  return model.game.activeIds[0] ?? model.game.lastDisplayedId;
}

export function selectBetweenHands(model: SessionModel): boolean {
  return model.game.handKey > 0 && model.game.activeIds.length === 0;
}

export function selectHideGameInterfaceForBetweenHandDialog(
  betweenHands: boolean,
  betweenHandMode: BetweenHandModeModel,
): boolean {
  return betweenHands
    && (betweenHandMode === 'compose-proposal' || betweenHandMode === 'review-incoming-proposal');
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

export interface GameDashboardSelectorOptions {
  hasSession?: boolean;
  cleanShutdownGraceActive?: boolean;
}

function channelStatusDetail(model: SessionModel): string | null {
  const channel = model.channel.status;
  switch (channel.state) {
    case 'Failed':
      return channel.advisory ?? model.restore.error ?? 'Channel failed';
    default:
      return channel.advisory;
  }
}

function selectHandStatus(model: SessionModel): HandStatus {
  if (model.game.terminal.type !== 'none' || model.game.coin.turnState === 'ended') {
    return 'ended';
  }
  if (model.game.activeIds.length === 0) {
    return 'none';
  }
  if (!model.game.coin.coinHex) {
    return 'active';
  }
  if (ON_CHAIN_HAND_STATES.has(model.channel.status.state)) {
    switch (model.game.coin.turnState) {
      case 'my-turn':
        return 'our-turn';
      // We detected the opponent's illegal on-chain move and are now resolving
      // the slash; surface that explicitly rather than a generic "our turn".
      case 'opponent-illegal-move':
        return 'slashing';
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
  const terminal = model.game.terminal;
  if (terminal.type === 'none') {
    return null;
  }
  if (terminal.cleanEnd && terminal.label !== 'Forfeited') {
    return null;
  }
  return terminal.label;
}

function dashboardActionFor(
  model: SessionModel,
  cleanShutdownGraceActive: boolean,
): Pick<GameDashboardViewModel, 'actionLabel' | 'actionEnabled' | 'actionKind'> {
  switch (model.channel.status.state) {
    case 'Handshaking':
    case 'WaitingForHeightToOffer':
    case 'WaitingForHeightToAccept':
    case 'MakingOffer':
    case 'MakingOfferAcceptance':
      return { actionLabel: 'Cancel', actionEnabled: true, actionKind: 'cancel' };
    case 'OfferSent':
    case 'TransactionPending':
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
      if (cleanShutdownGraceActive) {
        return { actionLabel: 'Waiting', actionEnabled: false, actionKind: 'none' };
      }
      return { actionLabel: 'Go On-Chain', actionEnabled: true, actionKind: 'go-on-chain' };
    case 'ShutdownTransactionPending':
    case 'GoingOnChain':
    case 'Unrolling':
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
      handStatusLabel: 'No hand',
      handDetail: null,
      actionLabel: 'No Session',
      actionEnabled: false,
      actionKind: 'none',
    };
  }

  const channel = model.channel.status;
  const action = dashboardActionFor(model, options.cleanShutdownGraceActive ?? false);

  return {
    channelStatusLabel: CHANNEL_STATE_LABELS[channel.state],
    channelDetail: channelStatusDetail(model),
    handStatusLabel: collapsedHandStatusLabel(model),
    handDetail: collapsedHandDetail(model),
    ...action,
  };
}

const STATUS_BAR_ERROR_TERMINALS = new Set<GameTerminalType>([
  'forfeit',
  'opponent-successfully-cheated',
  'game-error',
  'opponent-slashed-us',
  'insufficient-balance',
]);

/// Derive the compact balance strip shown in the status bar header.
///
/// Layout is always `Me` / `Opp` / `Hand`:
/// - Active hand: `Hand` is the in-game pot.
/// - Hand end: `Hand` is the realized mine/opp split (`myReward / theirReward`),
///   still shown alongside the updated `Me`/`Opp` stacks.
/// - Clean shutdown: no hand, so `Me`/`Opp` show the final balances ("change").
/// - Error: `Me 0` / `Opp ?` (the convention for an unrecoverable channel/game).
export function selectStatusBarBalances(
  model: SessionModel | null,
): StatusBarBalanceSegment[] | null {
  if (!model) {
    return null;
  }

  const channel = model.channel.status;
  const terminal = model.game.terminal;

  const channelFailed = channel.state === 'Failed' || channel.state === 'ResolvedStale';
  if (channelFailed || STATUS_BAR_ERROR_TERMINALS.has(terminal.type)) {
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

  if (terminal.type !== 'none' && terminal.myReward != null) {
    // Hand ended: the pot (a zero-sum split of both contributions) is realized
    // as my reward vs theirs. game_allocated is already back to zero here, so
    // the pot comes from the hand's terms.
    const terms = model.betweenHand.lastTerms;
    const pot = terms.myContribution + terms.theirContribution;
    let theirReward = terminal.myReward;
    try {
      const rem = pot - BigInt(terminal.myReward);
      theirReward = (rem < 0n ? 0n : rem).toString();
    } catch {
      theirReward = theirs;
    }
    segments.push({ label: 'Hand', value: terminal.myReward, value2: theirReward });
  } else if (model.game.activeIds.length > 0) {
    // Active hand: show the running total in the pot as a single value.  The
    // pot is both players' contributions for the hand (the same total the
    // hand-end split is drawn from); derive it from the agreed terms rather
    // than game_allocated, which reads 0 mid-hand and so showed nothing until
    // the hand ended.
    const terms = model.betweenHand.lastTerms;
    const pot = terms.myContribution + terms.theirContribution;
    if (pot > 0n) {
      segments.push({ label: 'Hand', value: pot.toString() });
    }
  }

  return segments;
}

export interface GameSessionViewModel {
  channelStatus: ChannelStatusModel;
  gameCoin: GameCoinModel;
  gameTerminal: GameTerminalModel;
  currentHandAmount: bigint;
  activeGameId: string | null;
  activeGameType: string;
  displayGameId: string | null;
  betweenHands: boolean;
  channelQueue: QueuedNotificationModel[];
  gameQueue: QueuedNotificationModel[];
}

export function selectGameSessionView(model: SessionModel): GameSessionViewModel {
  return {
    channelStatus: model.channel.status,
    gameCoin: model.game.coin,
    gameTerminal: model.game.terminal,
    currentHandAmount: model.betweenHand.lastTerms.myContribution,
    activeGameId: model.game.activeIds[0] ?? null,
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
  return {
    gameType: model.game.activeGameType,
    displayGameId: selectDisplayGameId(model),
    handState: model.game.handState,
    turnState: model.game.coin.turnState,
    terminal: model.game.terminal,
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
  save: Pick<SessionState, 'myContribution' | 'theirContribution' | 'perGameAmount'>,
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

type SavedProposal = SavedHandTerms & { id: string };

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
  return {
    id: saved.id,
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
      return 0n;
    }
  }
  return 0n;
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

export function sessionModelFromSave(save: SessionState, perGameAmount = 0n): SessionModel {
  const fallbackTerms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: perGameAmount,
    theirContribution: perGameAmount,
    gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
  };
  const lastTerms = parseTermsSnapshot(save.betweenHandLastTerms, fallbackTerms);
  const activeIds = save.activeGameId ? [save.activeGameId] : [];

  return createSessionModel({
    restore: {
      restoring: !!save.serializedCradle,
      status: save.serializedCradle ? 'restoring' : 'idle',
      error: null,
      trackerReconciled: false,
    },
    channel: {
      status: save.channelStatus
        ? {
            state: save.channelStatus.state,
            advisory: save.channelStatus.advisory ?? null,
            coinHex: null,
            coinAmount: null,
            ourBalance: save.channelStatus.our_balance == null ? null : String(save.channelStatus.our_balance),
            theirBalance: save.channelStatus.their_balance == null ? null : String(save.channelStatus.their_balance),
            gameAllocated: save.channelStatus.game_allocated == null ? null : String(save.channelStatus.game_allocated),
            havePotato: save.channelStatus.have_potato ?? null,
          }
        : save.channelReady
          ? { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' }
          : INITIAL_CHANNEL_STATUS_MODEL,
      connection: save.channelReady
        ? { stateIdentifier: 'running', stateDetail: [] }
        : { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
      goOnChainPressed: save.goOnChainPressed ?? false,
      cleanShutdownStarted: save.cleanShutdownStarted ?? false,
      dismissedChannelState: (save.dismissedChannelState as ChannelState | undefined) ?? null,
      queue: parseQueuedNotifications(save.channelNotifQueue),
    },
    game: {
      coin: {
        coinHex: save.gameCoinHex ?? null,
        turnState: (save.gameTurnState as GameTurnState | undefined) ?? 'my-turn',
      },
      handStatus: (save.gameHandStatus as HandStatus | undefined) ?? 'none',
      terminal: save.gameTerminalType && save.gameTerminalType !== 'none'
        ? {
            type: save.gameTerminalType as GameTerminalType,
            label: save.gameTerminalLabel ?? null,
            myReward: save.gameTerminalReward ?? null,
            rewardCoinHex: save.gameTerminalRewardCoin ?? null,
            cleanEnd: save.gameTerminalCleanEnd,
          }
        : INITIAL_GAME_TERMINAL_MODEL,
      handKey: (save.activeGameId || save.handState || save.betweenHandLastTerms) ? 1 : 0,
      activeIds,
      lastDisplayedId: save.activeGameId ?? null,
      activeGameType: save.activeGameType ?? 'calpoker',
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
      const outgoingProposalIds = Object.keys(outgoingProposalTerms);
      const hasOutgoing = outgoingProposalIds.length > 0;
      return {
        mode,
        cachedPeerProposal: parseProposalSnapshot(save.betweenHandCachedPeerProposal, lastTerms),
        reviewPeerProposal: parseProposalSnapshot(save.betweenHandReviewPeerProposal, lastTerms),
        rejectedOnceTerms: parseOptionalTermsSnapshot(save.betweenHandRejectedOnceTerms, lastTerms),
        lastTerms,
        composePerHandAmount: parseBigintString(save.betweenHandComposePerHand, perGameAmount),
        composeGameTimeout: parsePositiveBigintString(save.betweenHandComposeGameTimeout, lastTerms.gameTimeout),
        composeGameType: save.betweenHandComposeGameType ?? lastTerms.gameType,
        composeProposalSent: hasOutgoing && mode === 'compose-proposal',
        newHandRequested: hasOutgoing && mode === 'decision',
        outgoingProposalIds,
        outgoingProposalTerms,
      };
    })(),
    history: {
      humanHistory: save.humanHistory ?? save.history ?? [],
      wasmNotificationHistory: save.wasmNotificationHistory ?? [],
      diagnosticLog: save.diagnosticLog ?? save.log ?? [],
    },
    myRunningBalance: parseBigintString(save.myRunningBalance, 0n),
    lastOutcomeWin: save.lastOutcomeWin,
  });
}

export function snapshotFromSessionModel(model: SessionModel): Partial<SessionState> {
  const termsSnapshot = (terms: HandTermsModel) => ({
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_timeout: terms.gameTimeout.toString(),
    game_type: terms.gameType,
    spacepoker_unit_size: terms.spacepokerUnitSize?.toString(),
  });

  return {
    humanHistory: model.history.humanHistory.length > 0 ? model.history.humanHistory : undefined,
    wasmNotificationHistory: model.history.wasmNotificationHistory.length > 0 ? model.history.wasmNotificationHistory : undefined,
    diagnosticLog: model.history.diagnosticLog.length > 0 ? model.history.diagnosticLog : undefined,
    gameCoinHex: model.game.coin.coinHex,
    gameTurnState: model.game.coin.turnState,
    gameHandStatus: model.game.handStatus !== 'none' ? model.game.handStatus : undefined,
    gameTerminalType: model.game.terminal.type !== 'none' ? model.game.terminal.type : undefined,
    gameTerminalLabel: model.game.terminal.label,
    gameTerminalReward: model.game.terminal.myReward,
    gameTerminalRewardCoin: model.game.terminal.rewardCoinHex,
    gameTerminalCleanEnd: model.game.terminal.cleanEnd,
    myRunningBalance: model.myRunningBalance !== 0n ? model.myRunningBalance.toString() : undefined,
    channelNotifQueue: model.channel.queue.length > 0
      ? model.channel.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
      : undefined,
    gameNotifQueue: model.game.queue.length > 0
      ? model.game.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
      : undefined,
    dismissedChannelState: model.channel.dismissedChannelState ?? undefined,
    goOnChainPressed: model.channel.goOnChainPressed || undefined,
    cleanShutdownStarted: model.channel.cleanShutdownStarted || undefined,
    betweenHandMode: model.betweenHand.mode,
    betweenHandComposePerHand: model.betweenHand.composePerHandAmount.toString(),
    betweenHandComposeGameTimeout: model.betweenHand.composeGameTimeout.toString(),
    betweenHandComposeGameType: model.betweenHand.composeGameType,
    betweenHandLastTerms: termsSnapshot(model.betweenHand.lastTerms),
    betweenHandRejectedOnceTerms: model.betweenHand.rejectedOnceTerms
      ? termsSnapshot(model.betweenHand.rejectedOnceTerms)
      : undefined,
    betweenHandCachedPeerProposal: model.betweenHand.cachedPeerProposal
      ? {
          id: model.betweenHand.cachedPeerProposal.id,
          ...termsSnapshot(model.betweenHand.cachedPeerProposal.terms),
        }
      : undefined,
    betweenHandReviewPeerProposal: model.betweenHand.reviewPeerProposal
      ? {
          id: model.betweenHand.reviewPeerProposal.id,
          ...termsSnapshot(model.betweenHand.reviewPeerProposal.terms),
        }
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
