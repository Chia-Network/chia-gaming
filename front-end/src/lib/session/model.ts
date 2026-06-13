import type {
  ChannelState,
  ChatMessage,
  GameConnectionState,
  SessionPhase,
} from '../../types/ChiaGaming';
import type { RestoreStatus } from '../../hooks/WasmBlobWrapper';
import type { PersistedGameState, SessionState } from '../../hooks/save';

export type GameTurnState =
  | 'my-turn'
  | 'their-turn'
  | 'playing-on-chain'
  | 'replaying'
  | 'opponent-illegal-move'
  | 'ended';

export type GameTerminalType =
  | 'none'
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
  chatMessages: ChatMessage[];
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
  | { type: 'game-terminal'; terminal: GameTerminalModel }
  | { type: 'between-hand'; state: Partial<BetweenHandModel> }
  | { type: 'history'; state: Partial<SessionHistoryModel> };

export type SessionIntent =
  | { type: 'go-on-chain' }
  | { type: 'clean-shutdown' }
  | { type: 'propose-game'; terms: HandTermsModel }
  | { type: 'accept-proposal'; id: string }
  | { type: 'reject-proposal'; id: string };

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

export const DEFAULT_HAND_TERMS_MODEL: HandTermsModel = {
  gameType: 'calpoker',
  myContribution: 0n,
  theirContribution: 0n,
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
      chatMessages: [],
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

export function selectShouldAutoGoOnChain(model: SessionModel, phase: SessionPhase): boolean {
  return model.peer.connected === false && phase === 'off-chain' && !selectRestoreBlocked(model);
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
  shouldAutoGoOnChain: boolean;
  sessionError: boolean;
}

export function selectShellView(model: SessionModel, phase: SessionPhase): ShellViewModel {
  const restoreBlocked = selectRestoreBlocked(model);
  return {
    restoreBlocked,
    canAdvertiseAvailable: selectShouldAdvertiseAvailable(model, phase),
    shouldAutoGoOnChain: selectShouldAutoGoOnChain(model, phase),
    sessionError: model.restore.status === 'failed',
  };
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

export function sessionAmountsFromSave(
  save: Pick<SessionState, 'amount' | 'perGameAmount'>,
  fallbackAmount: bigint,
  fallbackPerGameAmount: bigint,
): { amount: bigint; perGameAmount: bigint } {
  return {
    amount: parseBigintString(save.amount, fallbackAmount),
    perGameAmount: parseBigintString(save.perGameAmount, fallbackPerGameAmount),
  };
}

type SavedHandTerms = {
  my_contribution: string;
  their_contribution: string;
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
    betweenHand: {
      mode: (save.betweenHandMode as BetweenHandModeModel | undefined) ?? 'decision',
      cachedPeerProposal: parseProposalSnapshot(save.betweenHandCachedPeerProposal, lastTerms),
      reviewPeerProposal: parseProposalSnapshot(save.betweenHandReviewPeerProposal, lastTerms),
      rejectedOnceTerms: parseOptionalTermsSnapshot(save.betweenHandRejectedOnceTerms, lastTerms),
      lastTerms,
      composePerHandAmount: parseBigintString(save.betweenHandComposePerHand, perGameAmount),
      composeGameType: save.betweenHandComposeGameType ?? lastTerms.gameType,
      outgoingProposalTerms: save.outgoingProposalTerms
        ? Object.fromEntries(
            Object.entries(save.outgoingProposalTerms).map(
              ([id, saved]) => [id, parseTermsSnapshot(saved, lastTerms)]
            )
          )
        : {},
    },
    history: {
      humanHistory: save.humanHistory ?? save.history ?? [],
      wasmNotificationHistory: save.wasmNotificationHistory ?? [],
      diagnosticLog: save.diagnosticLog ?? save.log ?? [],
      chatMessages: save.chatMessages ?? [],
    },
    myRunningBalance: parseBigintString(save.myRunningBalance, 0n),
    lastOutcomeWin: save.lastOutcomeWin,
  });
}

export function snapshotFromSessionModel(model: SessionModel): Partial<SessionState> {
  const termsSnapshot = (terms: HandTermsModel) => ({
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_type: terms.gameType,
    spacepoker_unit_size: terms.spacepokerUnitSize?.toString(),
  });

  return {
    humanHistory: model.history.humanHistory.length > 0 ? model.history.humanHistory : undefined,
    wasmNotificationHistory: model.history.wasmNotificationHistory.length > 0 ? model.history.wasmNotificationHistory : undefined,
    diagnosticLog: model.history.diagnosticLog.length > 0 ? model.history.diagnosticLog : undefined,
    chatMessages: model.history.chatMessages.length > 0 ? model.history.chatMessages : undefined,
    gameCoinHex: model.game.coin.coinHex,
    gameTurnState: model.game.coin.turnState,
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
