import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Subject, Observable } from 'rxjs';
import { Program } from 'clvm-lib';
import {
  GameConnectionState,
  GameSessionParams,
  CalpokerOutcome,
  PeerConnectionResult,
  WasmEvent,
  WasmNotification,
  ChannelState,
  ChannelStatusPayload,
  GameStatusPayload,
  GameStatusState,
  SessionPhase,
} from '../types/ChiaGaming';
import {
  getOrCreateSessionController,
  initStarted,
  setInitStarted,
} from './blobSingleton';
import { SessionController, RestoreStatus } from './SessionController';
import type { BlockchainPoller } from './BlockchainPoller';
import { SessionState, saveSession, getDefaultFee, getBlockchainType, uint8ToBase64 } from './save';
import { coinIdFromBytes, coerceToBytes } from '../util';
import { log } from '../services/log';
import {
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  createSessionModel,
  selectDefaultCalpokerInitialTurn,
  selectDefaultCalpokerProposalMyTurn,
  selectGameSessionView,
  selectGameSpecificView,
  selectSessionPhase,
  sessionModelFromSave,
  type HandStatus,
  type SessionModel,
  snapshotFromSessionModel,
} from '../lib/session/model';

export type GameplayEvent =
  | { ProposalAccepted: { id: bigint | number | string } }
  | { OpponentMoved: { readable: Uint8Array | number[] } }
  | { GameMessage: { readable: Uint8Array | number[] } }
  | { Timeout: { byUs: boolean; forfeited: boolean } }
  | { GameError: { reason: string } };

function asBytes(value: unknown): Uint8Array | null {
  return coerceToBytes(value);
}

export function terminalEventForInfo(info: GameTerminalInfo, status: GameStatusState): GameplayEvent | null {
  if (info.cleanEnd) return null;

  switch (info.type) {
    case 'forfeit':
      // A forfeit is a timeout-based terminal where the loser intentionally
      // skipped its final move (no point paying for an on-chain move that wins
      // nothing). Carry the distinction so games can label it "Forfeit" rather
      // than the misleading "Timed Out". Direction follows the status: our own
      // forfeit arrives as ended-we-timed-out, the opponent's as
      // ended-opponent-timed-out.
      return { Timeout: { byUs: status === 'ended-we-timed-out', forfeited: true } };
    case 'we-timed-out':
      return { Timeout: { byUs: true, forfeited: false } };
    case 'opponent-timed-out':
      return { Timeout: { byUs: false, forfeited: false } };
    default:
      return { GameError: { reason: info.label ?? info.type } };
  }
}

export function gameplayEventsForGameStatus(
  notification: WasmNotification,
  activeIds: string[],
  terminalEvent: GameplayEvent | null,
): GameplayEvent[] {
  const gs = notification.GameStatus as GameStatusPayload | undefined;
  if (!gs) return [];
  const gid = String(gs.id);
  const other = gs.other_params ?? null;
  const readable = other?.readable;
  const readableArr = asBytes(readable);
  const events: GameplayEvent[] = [];
  if (readableArr) {
    const hasMoverShare = other?.mover_share != null;
    if (hasMoverShare) {
      events.push({ OpponentMoved: { readable: readableArr } });
    } else if (activeIds.includes(gid)) {
      events.push({ GameMessage: { readable: readableArr } });
    }
  }
  if (terminalEvent) {
    events.push(terminalEvent);
  }
  return events;
}

function parseCoinAmount(coin: unknown): string | null {
  const bytes = asBytes(coin);
  if (!bytes || bytes.length < 64) {
    return null;
  }
  let value = 0n;
  for (let i = 64; i < bytes.length; i++) {
    value = (value << 8n) + BigInt(bytes[i] & 0xff);
  }
  return value.toString();
}

async function coinIdHex(coin: unknown): Promise<string | null> {
  const bytes = asBytes(coin);
  return bytes ? coinIdFromBytes(bytes) : null;
}

export type GameTurnState = 'my-turn' | 'their-turn' | 'playing-on-chain' | 'replaying' | 'opponent-illegal-move' | 'finishing' | 'ended';

export interface GameCoinInfo {
  coinHex: string | null;
  turnState: GameTurnState;
}

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

export interface GameTerminalInfo {
  type: GameTerminalType;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
  cleanEnd?: boolean;
}

export interface GameTerminalAttentionInfo {
  label: string;
  myReward: string | null;
  rewardCoinHex: string | null;
}

export type NotificationKind =
  | 'channel-state'
  | 'session-over'
  | 'action-failed'
  | 'infra-error'
  | 'game-terminal'
  | 'proposal-rejected'
  | 'insufficient-bal';

export interface QueuedNotification {
  id: bigint;
  kind: NotificationKind;
  title: string;
  message: string;
  payload?: ChannelStatusInfo | GameTerminalAttentionInfo;
}

export interface ChannelStatusInfo {
  state: ChannelState;
  advisory: string | null;
  coinHex: string | null;
  coinAmount: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
  havePotato: boolean | null;
}

const INITIAL_CHANNEL_STATUS: ChannelStatusInfo = {
  state: 'Handshaking',
  advisory: null,
  coinHex: null,
  coinAmount: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
  havePotato: null,
};

function channelStatusFromPayload(cs: ChannelStatusPayload, coinHex: string | null): ChannelStatusInfo {
  const amount = parseCoinAmount(cs.coin);
  const isResolvedFromUnroll = cs.state === 'ResolvedUnrolled' || cs.state === 'ResolvedStale';
  const resolvedShare = isResolvedFromUnroll
    ? (amount ?? '0')
    : parseAmount(cs.our_balance);
  return {
    state: cs.state,
    advisory: cs.advisory ?? null,
    coinHex,
    coinAmount: amount,
    ourBalance: resolvedShare,
    theirBalance: parseAmount(cs.their_balance),
    gameAllocated: parseAmount(cs.game_allocated),
    havePotato: cs.have_potato ?? null,
  };
}

const INITIAL_GAME_TERMINAL: GameTerminalInfo = {
  type: 'none',
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

// Channel states that still warrant a pop-up. Routine transitions are shown in
// the status bar instead; only error resolutions interrupt the user.
const ERROR_CHANNEL_STATES: ChannelState[] = ['ResolvedStale', 'Failed'];

const WINDING_DOWN_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'ShutdownTransactionPending', 'GoingOnChain', 'Unrolling',
  'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale', 'Failed',
]);

const ON_CHAIN_FLOW_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'GoingOnChain', 'Unrolling', 'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale',
]);

export function nextGameTurnAfterLocalTurn(
  current: GameTurnState,
  isMyTurn: boolean,
  channelState: ChannelState,
): GameTurnState {
  if (current === 'ended') {
    return 'ended';
  }
  if (isMyTurn) {
    return 'my-turn';
  }
  return ON_CHAIN_FLOW_STATES.has(channelState) ? 'playing-on-chain' : 'their-turn';
}

// While we are actively (re)playing our move on-chain the game hook owns the
// turn state ('playing-on-chain' once it fires a move; 'replaying' once the
// channel handler signals a redo). An `on-chain-my-turn` for that same coin is
// just confirming the turn is ours — it must NOT downgrade the display to 'Your
// turn'. The hook advances us to 'their-turn' once the move lands, and a genuine
// new (manual) my-turn arrives from a 'their-turn' state, so this only
// suppresses the spurious "Your turn" flicker during play/replay.
export function isActivelyPlayingOnChain(current: GameTurnState): boolean {
  return current === 'playing-on-chain' || current === 'replaying';
}

const LOCAL_CANCEL_REASONS: ReadonlySet<string> = new Set([
  'SupersededByIncoming',
  'PeerProposalPending',
  'GameActive',
]);

export function isWindingDown(state: ChannelState): boolean {
  return WINDING_DOWN_STATES.has(state);
}

const RESOLVED_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale', 'Failed',
]);

export function deriveSessionPhase(
  channelState: ChannelState,
  goOnChainPressed: boolean,
  activeGameId?: string | null,
): Exclude<SessionPhase, 'none'> {
  if ((channelState === 'ResolvedUnrolled' || channelState === 'ResolvedStale') && activeGameId) {
    return 'on-chain';
  }
  if (RESOLVED_STATES.has(channelState)) return 'resolved';
  if (channelState === 'ShutdownTransactionPending') return 'off-chain';
  if (goOnChainPressed || isWindingDown(channelState)) return 'on-chain';
  return 'off-chain';
}

function parseAmount(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'Amount' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).Amount);
  }
  return String(v);
}

function parseTimeoutBlocks(v: unknown): bigint | null {
  if (v == null) return DEFAULT_GAME_TIMEOUT_BLOCKS;
  const raw = typeof v === 'object' && v !== null && 'Timeout' in (v as Record<string, unknown>)
    ? (v as Record<string, unknown>).Timeout
    : v;
  try {
    const timeout = BigInt(String(raw));
    return timeout > 0n ? timeout : null;
  } catch {
    return null;
  }
}

export function parseGameStatusTerminalInfo(gs: GameStatusPayload, rewardCoinHex: string | null, turnState: GameTurnState): GameTerminalInfo {
  if (gs.status === 'ended-we-timed-out') {
    const clean = !!gs.other_params?.game_finished;
    const forfeited = !!gs.other_params?.forfeited;
    const offChainAccept = !clean && !gs.coin_id && gs.reason !== 'move too late';
    if (forfeited) {
      return {
        type: 'forfeit',
        label: 'Forfeited',
        myReward: parseAmount(gs.my_reward),
        rewardCoinHex,
      };
    }
    let label: string;
    if (clean) {
      label = 'Ended cleanly';
    } else if (offChainAccept) {
      label = 'Folded';
    } else if (turnState === 'replaying' || turnState === 'their-turn') {
      label = 'Move too late';
    } else {
      label = 'We took too long to move';
    }
    return {
      type: 'we-timed-out',
      label,
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
      cleanEnd: clean,
    };
  }

  if (gs.status === 'ended-opponent-timed-out') {
    const clean = !!gs.other_params?.game_finished;
    const forfeited = !!gs.other_params?.forfeited;
    const offChainAccept = !clean && !gs.coin_id;
    if (forfeited) {
      return {
        type: 'forfeit',
        label: 'Forfeited',
        myReward: parseAmount(gs.my_reward),
        rewardCoinHex,
      };
    }
    return {
      type: 'opponent-timed-out',
      label: clean ? 'Ended cleanly' : offChainAccept ? 'Opponent folded' : 'Opponent took too long to move',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
      cleanEnd: clean,
    };
  }

  if (gs.status === 'ended-we-slashed-opponent') {
    return {
      type: 'we-slashed-opponent',
      label: 'Slashed opponent',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-opponent-slashed-us') {
    return {
      type: 'opponent-slashed-us',
      label: 'Opponent slashed us',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (gs.status === 'ended-opponent-successfully-cheated') {
    return {
      type: 'opponent-successfully-cheated',
      label: 'Opponent cheated',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-cancelled') {
    return {
      type: 'ended-cancelled',
      label: 'Cancelled',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (gs.status === 'ended-error') {
    return {
      type: 'game-error',
      label: gs.reason ?? 'Error',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  return INITIAL_GAME_TERMINAL;
}

function isTerminalStatus(status: GameStatusState): boolean {
  return status.startsWith('ended-');
}

export interface HandTerms {
  gameType: string;
  myContribution: bigint;
  theirContribution: bigint;
  gameTimeout: bigint;
  spacepokerUnitSize?: bigint;
}

export interface BetweenHandProposal {
  id: string;
  terms: HandTerms;
}

export type BetweenHandMode =
  | 'decision'
  | 'compose-proposal'
  | 'review-incoming-proposal';

function termsEqual(a: HandTerms | null, b: HandTerms | null): boolean {
  return !!a
    && !!b
    && a.gameType === b.gameType
    && a.myContribution === b.myContribution
    && a.theirContribution === b.theirContribution
    && a.gameTimeout === b.gameTimeout
    && (a.spacepokerUnitSize ?? null) === (b.spacepokerUnitSize ?? null);
}

function balanceCanCover(balance: string | null, amount: bigint): boolean {
  if (balance == null) return true;
  try {
    return BigInt(balance) >= amount;
  } catch {
    return true;
  }
}

function hexToString(hex: string): string {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return String.fromCharCode(...bytes);
}

function parseGameTypeFromNotification(value: Record<string, unknown>): string {
  const raw = value.game_type;
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^[0-9a-f]+$/i.test(raw)) return hexToString(raw);
    return raw;
  }
  return 'calpoker';
}

function parseProgramBigInt(value: unknown): bigint | undefined {
  // The wasm bridge serializes a CLVM Program's bytes with serde's
  // serialize_bytes, which serde-wasm-bindgen renders as a Uint8Array. That is
  // the only shape that actually arrives here.
  if (!(value instanceof Uint8Array)) {
    return undefined;
  }
  try {
    return Program.deserialize(value).toBigInt();
  } catch {
    return undefined;
  }
}

function parseTermsFromNotificationValue(value: unknown, gameType?: string): HandTerms | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const mine = parseAmount(obj.my_contribution);
  const theirs = parseAmount(obj.their_contribution);
  if (!mine || !theirs) return null;
  const resolvedGameType = gameType ?? parseGameTypeFromNotification(obj);
  try {
    const timeout = parseTimeoutBlocks(obj.timeout);
    if (timeout == null) return null;
    return {
      gameType: resolvedGameType,
      myContribution: BigInt(mine),
      theirContribution: BigInt(theirs),
      gameTimeout: timeout,
      spacepokerUnitSize: resolvedGameType === 'spacepoker'
        ? parseProgramBigInt(obj.initial_state)
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseIncomingProposal(value: unknown): BetweenHandProposal | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const idRaw = obj.id;
  const gameType = parseGameTypeFromNotification(obj);
  const terms = parseTermsFromNotificationValue(value, gameType);
  if (!terms || (typeof idRaw !== 'bigint' && typeof idRaw !== 'number' && typeof idRaw !== 'string')) return null;
  return {
    id: String(idRaw),
    terms,
  };
}

function maxQueuedNotificationId(...queues: QueuedNotification[][]): bigint {
  let max = 0n;
  for (const queue of queues) {
    for (const notification of queue) {
      if (notification.id > max) max = notification.id;
    }
  }
  return max;
}

export interface UseGameSessionResult {
  sessionModel: SessionModel;
  gameConnectionState: GameConnectionState;
  amount: bigint;
  perGameAmount: bigint;
  currentHandAmount: bigint;
  myRunningBalance: bigint;
  iStarted: boolean;
  playerNumber: number;
  channelStatus: ChannelStatusInfo;
  gameCoin: GameCoinInfo;
  gameTerminal: GameTerminalInfo;
  handKey: number;
  activeGameId: string | null;
  activeGameType: string;
  displayGameId: string | null;
  sessionController: SessionController;
  gameplayEvent$: Observable<GameplayEvent>;
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  betweenHandMode: BetweenHandMode;
  cachedPeerProposal: BetweenHandProposal | null;
  reviewPeerProposal: BetweenHandProposal | null;
  lastHandTerms: HandTerms;
  composePerHandAmount: bigint;
  composeGameTimeout: bigint;
  chooseNewHandSameTerms: () => void;
  chooseDoNotUseCurrentProposal: () => void;
  openComposeProposal: () => void;
  setComposePerHandAmount: (value: bigint) => void;
  setComposeGameTimeout: (value: bigint) => void;
  composeGameType: string;
  setComposeGameType: (value: string) => void;
  composeProposalSent: boolean;
  newHandRequested: boolean;
  submitComposedProposal: (perHandAmount: bigint, gameType: string, gameTimeout: bigint, spacepokerUnitSize?: bigint) => void;
  acceptReviewedProposal: () => void;
  rejectReviewedProposal: () => void;
  startCleanShutdown: () => void;
  cleanShutdownStarted: boolean;
  goOnChain: () => void;
  betweenHands: boolean;
  lastOutcome: CalpokerOutcome | undefined;
  restoredOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  goOnChainPressed: boolean;
  restoreStatus: RestoreStatus;
  restoreError: string | null;
  sessionPhase: Exclude<SessionPhase, 'none'>;
  channelQueue: QueuedNotification[];
  gameQueue: QueuedNotification[];
  dismissChannel: () => void;
  dismissGame: () => void;
  gameSpecificView: ReturnType<typeof selectGameSpecificView>;
}

export function useGameSession(
  params: GameSessionParams,
  uniqueId: string,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void,
  appendGameLog: (line: string) => void,
  sessionSave?: SessionState,
  blockchain: BlockchainPoller | null = null,
  onTerminal?: () => void,
): UseGameSessionResult {
  const { iStarted, amount, perGameAmount } = params;
  const playerNumber = iStarted ? 1 : 2;

  const { sessionController: sc } = getOrCreateSessionController(
    blockchain,
    peerConn,
    registerMessageHandler,
    uniqueId,
    amount,
    iStarted,
    sessionSave,
    params.pairingToken,
    perGameAmount,
    getDefaultFee,
    Number(params.channelTimeout ?? DEFAULT_CHANNEL_TIMEOUT_BLOCKS),
    Number(params.unrollTimeout ?? DEFAULT_UNROLL_TIMEOUT_BLOCKS),
    onTerminal,
  );

  if (params.myAlias) sc.myAlias = params.myAlias;
  if (params.opponentAlias) sc.opponentAlias = params.opponentAlias;
  const restoredModel = sessionSave ? sessionModelFromSave(sessionSave, perGameAmount) : null;

  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>(() => sc.getRestoreStatus());
  const [restoreError, setRestoreError] = useState<string | null>(() => sc.getRestoreError());

  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>(() =>
      restoredModel?.channel.connection
        ?? { stateIdentifier: 'starting' as const, stateDetail: ['before handshake'] }
    );
  const [myRunningBalance, setMyRunningBalance] = useState(() =>
    restoredModel?.myRunningBalance ?? 0n
  );
  const [goOnChainPressed, setGoOnChainPressed] = useState(
    () => restoredModel?.channel.goOnChainPressed ?? false
  );
  const [channelStatus, setChannelStatus] = useState<ChannelStatusInfo>(() => {
    return restoredModel?.channel.status ?? INITIAL_CHANNEL_STATUS;
  });
  const channelStateRef = useRef<ChannelState>(
    restoredModel?.channel.status.state ?? INITIAL_CHANNEL_STATUS.state
  );

  const [dismissedChannelState, setDismissedChannelState] = useState<ChannelState | null>(
    () => restoredModel?.channel.dismissedChannelState ?? null
  );
  const dismissedChannelStateRef = useRef<ChannelState | null>(dismissedChannelState);
  dismissedChannelStateRef.current = dismissedChannelState;

  const [channelQueue, setChannelQueue] = useState<QueuedNotification[]>(() =>
    restoredModel?.channel.queue as QueuedNotification[] ?? []
  );
  const [gameQueue, setGameQueue] = useState<QueuedNotification[]>(() =>
    restoredModel?.game.queue as QueuedNotification[] ?? []
  );
  const notifIdRef = useRef(
    maxQueuedNotificationId(
      (restoredModel?.channel.queue ?? []) as QueuedNotification[],
      (restoredModel?.game.queue ?? []) as QueuedNotification[],
    )
  );

  const pushChannel = useCallback((n: Omit<QueuedNotification, 'id'>) => {
    setChannelQueue(prev => {
      if (n.kind === 'channel-state') {
        const withoutOldState = prev.filter(e => e.kind !== 'channel-state');
        return [...withoutOldState, { ...n, id: ++notifIdRef.current }];
      }
      return [...prev, { ...n, id: ++notifIdRef.current }];
    });
  }, []);

  const pushGame = useCallback((n: Omit<QueuedNotification, 'id'>) => {
    setGameQueue(prev => [...prev, { ...n, id: ++notifIdRef.current }]);
  }, []);

  const dismissChannel = useCallback(() => {
    setChannelQueue(prev => {
      const dismissed = prev[0];
      if (dismissed?.kind === 'channel-state') {
        // Remember: user dismissed the notification for the current channel
        // state. Don't re-notify for the same state on reload or re-event.
        setDismissedChannelState(channelStateRef.current);
      }
      return prev.slice(1);
    });
  }, []);

  const dismissGame = useCallback(() => {
    setGameQueue(prev => prev.slice(1));
  }, []);
  const [gameCoin, setGameCoin] = useState<GameCoinInfo>(() => ({
    coinHex: restoredModel?.game.coin.coinHex ?? null,
    turnState: restoredModel?.game.coin.turnState ?? 'my-turn',
  }));
  const [handStatus, setHandStatus] = useState<HandStatus>(() =>
    restoredModel?.game.handStatus ?? 'none'
  );
  const turnStateRef = useRef<GameTurnState>(
    restoredModel?.game.coin.turnState ?? 'my-turn'
  );
  const gameCoinRef = useRef<GameCoinInfo>({
    coinHex: restoredModel?.game.coin.coinHex ?? null,
    turnState: restoredModel?.game.coin.turnState ?? 'my-turn',
  });
  const [gameTerminal, setGameTerminal] = useState<GameTerminalInfo>(() => {
    return restoredModel?.game.terminal ?? INITIAL_GAME_TERMINAL;
  });
  const [handKey, setHandKey] = useState(() =>
    restoredModel?.game.handKey ?? 0
  );
  const [gameIds, setGameIds] = useState<string[]>(() =>
    restoredModel?.game.activeIds ?? []
  );
  const [lastDisplayedGameId, setLastDisplayedGameId] = useState<string | null>(() =>
    restoredModel?.game.lastDisplayedId ?? null
  );
  const [activeGameType, setActiveGameType] = useState<string>(() =>
    restoredModel?.game.activeGameType ?? 'calpoker'
  );
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const restoredOutcomeWin = sessionSave?.lastOutcomeWin;
  const [betweenHandMode, setBetweenHandMode] = useState<BetweenHandMode>(() => {
    const mode = restoredModel?.betweenHand.mode;
    if (mode === 'decision' || mode === 'compose-proposal' || mode === 'review-incoming-proposal') {
      return mode;
    }
    return 'decision';
  });
  const [cachedPeerProposal, setCachedPeerProposal] = useState<BetweenHandProposal | null>(() => {
    return restoredModel?.betweenHand.cachedPeerProposal ?? null;
  });
  const [reviewPeerProposal, setReviewPeerProposal] = useState<BetweenHandProposal | null>(() => {
    return restoredModel?.betweenHand.reviewPeerProposal ?? null;
  });
  const [rejectedOnceTerms, setRejectedOnceTerms] = useState<HandTerms | null>(() => {
    return restoredModel?.betweenHand.rejectedOnceTerms ?? null;
  });
  const [lastHandTerms, setLastHandTerms] = useState<HandTerms>(() => {
    return restoredModel?.betweenHand.lastTerms ?? {
      gameType: 'calpoker',
      myContribution: perGameAmount,
      theirContribution: perGameAmount,
      gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
    };
  });
  const [composePerHandAmount, setComposePerHandAmount] = useState<bigint>(() => {
    return restoredModel?.betweenHand.composePerHandAmount ?? perGameAmount;
  });
  const [composeGameTimeout, setComposeGameTimeout] = useState<bigint>(() =>
    restoredModel?.betweenHand.composeGameTimeout ?? lastHandTerms.gameTimeout
  );
  const [composeGameType, setComposeGameType] = useState<string>(() =>
    restoredModel?.betweenHand.composeGameType ?? lastHandTerms.gameType
  );
  const [composeProposalSent, setComposeProposalSent] = useState(
    () => restoredModel?.betweenHand.composeProposalSent ?? false
  );
  const [newHandRequested, setNewHandRequested] = useState(
    () => restoredModel?.betweenHand.newHandRequested ?? false
  );
  const [cleanShutdownStarted, setCleanShutdownStarted] = useState(
    () => restoredModel?.channel.cleanShutdownStarted ?? sc.cleanShutdownCalled
  );

  const lastOutcomeRef = useRef<CalpokerOutcome | undefined>(undefined);
  const handKeyRef = useRef<number>(restoredModel?.game.handKey ?? 0);
  const gameIdsRef = useRef<string[]>(restoredModel?.game.activeIds ?? []);
  const sameTermsRequestedRef = useRef<boolean>(false);
  const firstGameAcceptedRef = useRef<boolean>(!!sessionSave?.channelReady);
  const betweenHandModeRef = useRef<BetweenHandMode>(betweenHandMode);
  const cachedPeerProposalRef = useRef<BetweenHandProposal | null>(cachedPeerProposal);
  const reviewPeerProposalRef = useRef<BetweenHandProposal | null>(reviewPeerProposal);
  const rejectedOnceTermsRef = useRef<HandTerms | null>(rejectedOnceTerms);
  const lastHandTermsRef = useRef<HandTerms>(lastHandTerms);
  const proposalTermsByIdRef = useRef<Record<string, HandTerms>>((() => {
    const terms: Record<string, HandTerms> = {
      ...(restoredModel?.betweenHand.outgoingProposalTerms ?? {}),
    };
    const cached = restoredModel?.betweenHand.cachedPeerProposal;
    if (cached) terms[cached.id] = cached.terms;
    const review = restoredModel?.betweenHand.reviewPeerProposal;
    if (review) terms[review.id] = review.terms;
    return terms;
  })());
  const outgoingProposalIdsRef = useRef<Set<string>>(
    new Set(restoredModel?.betweenHand.outgoingProposalIds)
  );
  const pendingRetryTermsRef = useRef<HandTerms | null>(null);
  const expectingCounterProposalRef = useRef<boolean>(false);
  const rejectionFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameplayEventSubject = useRef(new Subject<GameplayEvent>()).current;

  const clearExpectingCounterProposal = useCallback(() => {
    expectingCounterProposalRef.current = false;
    if (rejectionFallbackTimerRef.current) {
      clearTimeout(rejectionFallbackTimerRef.current);
      rejectionFallbackTimerRef.current = null;
    }
  }, []);

  gameIdsRef.current = gameIds;
  handKeyRef.current = handKey;
  gameCoinRef.current = gameCoin;
  betweenHandModeRef.current = betweenHandMode;
  cachedPeerProposalRef.current = cachedPeerProposal;
  reviewPeerProposalRef.current = reviewPeerProposal;
  rejectedOnceTermsRef.current = rejectedOnceTerms;
  lastHandTermsRef.current = lastHandTerms;

  const scRef = useRef<SessionController>(sc);
  scRef.current = sc;

  useEffect(() => {
    return sc.onRestoreStatusChange((status, error) => {
      setRestoreStatus(status);
      setRestoreError(error);
    });
  }, [sc]);

  const cancelStalePeerProposals = useCallback((exceptId?: string) => {
    const go = scRef.current;
    const cached = cachedPeerProposalRef.current;
    if (cached && cached.id !== exceptId) {
      try { go?.cancel_proposal(cached.id); } catch (_) { /* already cancelled */ }
    }
    const review = reviewPeerProposalRef.current;
    if (review && review.id !== exceptId) {
      try { go?.cancel_proposal(review.id); } catch (_) { /* already cancelled */ }
    }
  }, []);

  const persistFullSession = useCallback(() => {
    const go = scRef.current;
    const wasm = go?.getWasmFields();
    if (!wasm) return;
    const model = createSessionModel({
      channel: {
        status: channelStatus,
        connection: gameConnectionState,
        goOnChainPressed,
        cleanShutdownStarted,
        dismissedChannelState,
        queue: channelQueue,
      },
      game: {
        coin: gameCoin,
        handStatus,
        terminal: gameTerminal,
        handKey,
        activeIds: gameIds,
        lastDisplayedId: lastDisplayedGameId,
        activeGameType,
        handState: wasm.handState,
        queue: gameQueue,
      },
      betweenHand: {
        mode: betweenHandMode,
        cachedPeerProposal,
        reviewPeerProposal,
        rejectedOnceTerms,
        lastTerms: lastHandTerms,
        composePerHandAmount,
        composeGameTimeout,
        composeGameType,
        composeProposalSent,
        newHandRequested,
        outgoingProposalIds: Array.from(outgoingProposalIdsRef.current),
        outgoingProposalTerms: { ...proposalTermsByIdRef.current },
        pendingRetryTerms: pendingRetryTermsRef.current,
      },
      history: {
        humanHistory: [],
        wasmNotificationHistory: wasm.history,
        diagnosticLog: wasm.log,
      },
      myRunningBalance,
      lastOutcomeWin: wasm.lastOutcomeWin,
    });
    const modelSnapshot = snapshotFromSessionModel(model);
    // Shell owns the human transcript and global diagnostic log.
    delete modelSnapshot.humanHistory;
    delete modelSnapshot.diagnosticLog;

    const save: Partial<SessionState> = {
      blockchainType: getBlockchainType(),
      serializedCradle: uint8ToBase64(wasm.serializedCradle),
      pairingToken: wasm.pairingToken,
      messageNumber: wasm.messageNumber,
      remoteNumber: wasm.remoteNumber,
      channelReady: wasm.channelReady,
      iStarted: wasm.iStarted,
      amount: wasm.amount,
      perGameAmount: wasm.perGameAmount,
      unackedMessages: wasm.unackedMessages.map(m => ({ msgno: m.msgno, msg: uint8ToBase64(m.msg) })),
      activeGameId: wasm.activeGameId,
      activeGameType,
      handState: wasm.handState,
      channelStatus: wasm.channelStatus,
      myAlias: wasm.myAlias,
      opponentAlias: wasm.opponentAlias,
      lastOutcomeWin: wasm.lastOutcomeWin,
      ...modelSnapshot,
    };
    saveSession(save);
  }, [
    gameConnectionState, channelStatus, goOnChainPressed, cleanShutdownStarted,
    gameCoin, handStatus, gameTerminal, handKey, gameIds, lastDisplayedGameId,
    myRunningBalance, betweenHandMode,
    composePerHandAmount, composeGameTimeout, composeGameType, lastHandTerms, rejectedOnceTerms,
    activeGameType, composeProposalSent, newHandRequested,
    cachedPeerProposal, reviewPeerProposal,
    channelQueue, dismissedChannelState, gameQueue,
  ]);

  // Save when JS-side state changes
  useEffect(() => {
    persistFullSession();
  }, [persistFullSession]);

  // Wire up the wasm-side save trigger
  useEffect(() => {
    const go = scRef.current;
    if (!go) return;
    go.onSaveNeeded = persistFullSession;
    return () => { go.onSaveNeeded = null; };
  }, [persistFullSession]);

  const proposeNewGame = useCallback((terms: HandTerms) => {
    const go = scRef.current;
    if (!go || !go.isChannelReady()) return;
    if (gameIdsRef.current.length > 0) {
      log('[notify] proposeNewGame blocked — game active');
      return;
    }
    log(`[notify] proposeNewGame sending proposal myContrib=${terms.myContribution} theirContrib=${terms.theirContribution} timeout=${terms.gameTimeout}`);
    try {
      const ids = go.proposeGame({
        game_type: terms.gameType,
        timeout: terms.gameTimeout,
        amount: terms.myContribution + terms.theirContribution,
        my_contribution: terms.myContribution,
        my_turn: selectDefaultCalpokerProposalMyTurn(iStarted),
        parameters: terms.gameType === 'spacepoker' && terms.spacepokerUnitSize
          ? Program.fromBigInt(terms.spacepokerUnitSize)
          : null,
      });
      for (const id of ids) {
        proposalTermsByIdRef.current[id] = terms;
        outgoingProposalIdsRef.current.add(id);
      }
    } catch (_) {
      // proposal can fail if channel isn't ready yet; user can retry
    }
  }, [iStarted]);

  const onHandOutcome = useCallback((outcome: CalpokerOutcome) => {
    setLastOutcome(outcome);
    lastOutcomeRef.current = outcome;
    const go = scRef.current;
    if (go) {
      go.lastOutcomeWin = outcome.my_win_outcome;
    }
  }, []);

  const onTurnChanged = useCallback((isMyTurn: boolean) => {
    const ts = nextGameTurnAfterLocalTurn(
      turnStateRef.current,
      isMyTurn,
      channelStateRef.current,
    );
    if (ts === turnStateRef.current) {
      return;
    }
    turnStateRef.current = ts;
    setGameCoin(prev => ({ coinHex: prev.coinHex, turnState: ts }));
    if (!gameCoinRef.current.coinHex) {
      setHandStatus(prev => prev === 'ended' ? prev : 'active');
    } else if (isMyTurn) {
      setHandStatus('our-turn');
    } else if (ON_CHAIN_FLOW_STATES.has(channelStateRef.current)) {
      setHandStatus('playing-move');
    } else {
      setHandStatus('active');
    }
  }, []);

  const triggerGoOnChain = useCallback(() => {
    log('[game] going on chain');
    setGoOnChainPressed(true);
    scRef.current?.goOnChain();
  }, []);

  const handleNotification = useCallback(async (n: WasmNotification) => {
    const go = scRef.current;
    if (typeof n !== 'object' || n === null) return;

    // ChannelStatus: persistent display, no toast
    if ('ChannelStatus' in n) {
      const cs = n.ChannelStatus as ChannelStatusPayload | undefined;
      if (!cs) return;
      const coinHex = await coinIdHex(cs.coin);
      const info = channelStatusFromPayload(cs, coinHex);
      channelStateRef.current = info.state;
      setChannelStatus(info);
      // If the channel state has moved away from (or to something other than)
      // the state the user previously dismissed a notification for, forget
      // that dismissal so future events for this state will notify again.
      if (dismissedChannelStateRef.current !== null
          && dismissedChannelStateRef.current !== cs.state) {
        dismissedChannelStateRef.current = null;
        setDismissedChannelState(null);
      }
      if (ERROR_CHANNEL_STATES.includes(cs.state)
          && dismissedChannelStateRef.current !== cs.state) {
        pushChannel({ kind: 'channel-state', title: 'Error', message: info.advisory ?? '', payload: info });
      }
      if (cs.state === 'Active' && info.gameAllocated === '0') {
        const ours = BigInt(info.ourBalance ?? '0');
        const theirs = BigInt(info.theirBalance ?? '0');
        if (ours <= 0n || theirs <= 0n) {
          const msg = theirs <= 0n
            ? 'Session over — you won everything!'
            : 'Session over — you lost everything.';
          pushChannel({ kind: 'session-over', title: 'Session Over', message: msg });
          scRef.current?.cleanShutdown();
          return;
        }
      }
      if (cs.state === 'Active' && gameConnectionState.stateIdentifier !== 'running') {
        setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      }
      if (cs.state === 'ShuttingDown' || cs.state === 'ShutdownTransactionPending') {
        setCleanShutdownStarted(true);
      }
      if (cs.state === 'GoingOnChain' || cs.state === 'Unrolling') {
        setGoOnChainPressed(true);
      }
      if (cs.state === 'Active' && !firstGameAcceptedRef.current) {
        firstGameAcceptedRef.current = true;
        if (handKeyRef.current === 0) {
          setHandKey(1);
          handKeyRef.current = 1;
        }
        setBetweenHandMode('compose-proposal');
      }
      return;
    }

    // Session lifecycle and game flow
    if ('ProposalMade' in n) {
      const incoming = parseIncomingProposal(n.ProposalMade);
      if (!incoming) {
        log('[notify] ProposalMade parse failed; going on-chain');
        triggerGoOnChain();
        return;
      }
      proposalTermsByIdRef.current[incoming.id] = incoming.terms;

      const betweenHandsNow = handKeyRef.current > 0 && gameIdsRef.current.length === 0;
      if (!betweenHandsNow) {
        log(`[notify] rejecting proposal id=${incoming.id} — game active`);
        try { go?.cancel_proposal(incoming.id); } catch (_) { /* already gone */ }
        return;
      }

      const matchesLastTerms = termsEqual(incoming.terms, lastHandTermsRef.current);
      switch (betweenHandModeRef.current) {
        case 'decision': {
          const retryTerms = pendingRetryTermsRef.current;
          if (expectingCounterProposalRef.current) {
            // Peer rejected our same-terms "New Hand" proposal and is counter-proposing.
            // Route directly to review so the user sees the accept/reject dialog with
            // no flicker through compose-proposal.
            clearExpectingCounterProposal();
            pendingRetryTermsRef.current = null;
            sameTermsRequestedRef.current = false;
            setNewHandRequested(false);
            setReviewPeerProposal(incoming);
            setBetweenHandMode('review-incoming-proposal');
          } else if (matchesLastTerms && sameTermsRequestedRef.current) {
            pendingRetryTermsRef.current = null;
            try {
              go?.acceptProposal(incoming.id);
              sameTermsRequestedRef.current = false;
              setNewHandRequested(false);
            } catch (e) {
              console.error('acceptProposal failed:', e);
            }
          } else if (sameTermsRequestedRef.current && !matchesLastTerms) {
            // We requested "New Hand" (same terms) but peer independently proposed
            // different terms. Withdraw our outgoing proposal so peer can't accept it
            // while we're reviewing theirs, and prompt the user to accept/reject.
            log(`[notify] ProposalMade id=${incoming.id} different terms after New Hand; cancelling ours and reviewing theirs`);
            sameTermsRequestedRef.current = false;
            setNewHandRequested(false);
            pendingRetryTermsRef.current = null;
            for (const id of Array.from(outgoingProposalIdsRef.current)) {
              if (id === incoming.id) continue;
              try { go?.cancel_proposal(id); } catch (_) { /* already gone */ }
            }
            outgoingProposalIdsRef.current.clear();
            setReviewPeerProposal(incoming);
            setBetweenHandMode('review-incoming-proposal');
          } else if (retryTerms) {
            pendingRetryTermsRef.current = null;
            sameTermsRequestedRef.current = false;
            setNewHandRequested(false);
            if (matchesLastTerms) {
              log(`[notify] ProposalMade id=${incoming.id} auto-rejecting stale proposal, re-sending ours`);
              try { go?.cancel_proposal(incoming.id); } catch (_) { /* already gone */ }
              proposeNewGame(retryTerms);
            } else {
              setReviewPeerProposal(incoming);
              setBetweenHandMode('review-incoming-proposal');
            }
          } else {
            setCachedPeerProposal(incoming);
          }
          break;
        }
        case 'compose-proposal': {
          const retryTerms = pendingRetryTermsRef.current;
          if (retryTerms) {
            pendingRetryTermsRef.current = null;
            if (termsEqual(incoming.terms, lastHandTermsRef.current)) {
              log(`[notify] ProposalMade id=${incoming.id} auto-rejecting stale proposal, re-sending ours`);
              try { go?.cancel_proposal(incoming.id); } catch (_) { /* already gone */ }
              proposeNewGame(retryTerms);
            } else {
              setComposeProposalSent(false);
              sameTermsRequestedRef.current = false;
              setNewHandRequested(false);
              setReviewPeerProposal(incoming);
              setBetweenHandMode('review-incoming-proposal');
            }
          } else if (termsEqual(incoming.terms, rejectedOnceTermsRef.current)) {
            log(`[notify] ProposalMade id=${incoming.id} auto-rejecting one-shot remembered terms`);
            try { go?.cancel_proposal(incoming.id); } catch (_) { /* already gone */ }
            setRejectedOnceTerms(null);
          } else {
            setReviewPeerProposal(incoming);
            setBetweenHandMode('review-incoming-proposal');
          }
          break;
        }
        case 'review-incoming-proposal':
          // Latest inbound proposal replaces currently reviewed one.
          setReviewPeerProposal(incoming);
          break;
      }
    } else if ('ProposalAccepted' in n) {
      firstGameAcceptedRef.current = true;
      sameTermsRequestedRef.current = false;
      setNewHandRequested(false);
      pendingRetryTermsRef.current = null;
      clearExpectingCounterProposal();
      const gpa = n.ProposalAccepted!;
      const newId = String(gpa.id);
      log(`[notify] ProposalAccepted id=${newId} handKey will increment`);
      outgoingProposalIdsRef.current.delete(newId);
      cancelStalePeerProposals(newId);
      setGameIds(prev => [...prev, newId]);
      gameIdsRef.current = [...gameIdsRef.current, newId];
      setLastDisplayedGameId(newId);
      const acceptedTerms = proposalTermsByIdRef.current[newId];
      if (acceptedTerms) {
        setLastHandTerms(acceptedTerms);
        setComposePerHandAmount(acceptedTerms.myContribution);
        setComposeGameTimeout(acceptedTerms.gameTimeout);
        setActiveGameType(acceptedTerms.gameType);
      }
      go?.setHandState(null);
      setHandKey(prev => prev + 1);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      const startTurn: GameTurnState = selectDefaultCalpokerInitialTurn(iStarted);
      turnStateRef.current = startTurn;
      setGameCoin({ coinHex: null, turnState: startTurn });
      setHandStatus('active');
      setGameTerminal(INITIAL_GAME_TERMINAL);
      setCachedPeerProposal(null);
      setReviewPeerProposal(null);
      setRejectedOnceTerms(null);
      setGameQueue(prev => prev.filter(n => n.kind !== 'proposal-rejected'));
      setBetweenHandMode('decision');
      gameplayEventSubject.next({ ProposalAccepted: { id: gpa.id as bigint | number | string } });
    } else if ('GameStatus' in n) {
      const gs = n.GameStatus as GameStatusPayload | undefined;
      if (!gs) return;
      const status = gs.status;
      const inOnChainFlow = ON_CHAIN_FLOW_STATES.has(channelStateRef.current);
      const isOnChainTurnStatus =
        status === 'on-chain-my-turn' || status === 'on-chain-their-turn' || status === 'replaying';
      const isLocalTurnStatus = status === 'my-turn' || status === 'their-turn';
      const ignoreLocalTurnDuringOnChain = inOnChainFlow && isLocalTurnStatus;

      if (isTerminalStatus(status)) {
        const terminalTurnState = turnStateRef.current;
        for (const event of gameplayEventsForGameStatus(n, gameIdsRef.current, null)) {
          gameplayEventSubject.next(event);
        }

        const rewardCoinHex = await coinIdHex(gs.coin_id);
        const terminalInfo = parseGameStatusTerminalInfo(gs, rewardCoinHex, terminalTurnState);
        setGameTerminal(terminalInfo);
        turnStateRef.current = 'ended';
        setGameCoin(prev => ({ ...prev, coinHex: null, turnState: 'ended' }));
        setHandStatus('ended');
        const hadActiveGame = gameIdsRef.current.length > 0;
        if (hadActiveGame) {
          setGameIds(prev => prev.slice(1));
          gameIdsRef.current = gameIdsRef.current.slice(1);
          cancelStalePeerProposals();
          setBetweenHandMode('decision');
          setCachedPeerProposal(null);
          setReviewPeerProposal(null);
          // Routine end-of-hand transitions no longer pop up; the result is
          // shown in the status-bar balances and (for Space Poker) on the table.
        }
        const terminalEvent = terminalEventForInfo(terminalInfo, status);
        if (terminalEvent) {
          gameplayEventSubject.next(terminalEvent);
        }
        return;
      }

      const coinHex = await coinIdHex(gs.coin_id);
      if (turnStateRef.current === 'ended') {
        return;
      }

      if (ignoreLocalTurnDuringOnChain) {
        // During on-chain flow, on-chain turn statuses are authoritative.
        // Keep any known coin id if local status messages continue to arrive.
        if (coinHex) {
          setGameCoin(prev => ({ ...prev, coinHex }));
        }
      } else if (status === 'my-turn' || status === 'on-chain-my-turn') {
        if (isActivelyPlayingOnChain(turnStateRef.current)) {
          // We're mid play/replay of our move on-chain; keep showing 'Playing
          // move'/'Replaying' rather than reverting to 'Your turn'. Just refresh
          // the coin id.
          if (coinHex) {
            setGameCoin(prev => ({ ...prev, coinHex }));
          }
        } else {
          turnStateRef.current = 'my-turn';
          setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'my-turn' }));
          setHandStatus(status === 'on-chain-my-turn' && coinHex ? 'our-turn' : 'active');
        }
      } else if (status === 'their-turn' || status === 'on-chain-their-turn') {
        // After we play a terminal move on-chain the game is over (the next
        // coin nominally passes the turn to the opponent, but its validation
        // program is nil). We're not waiting on the opponent — we're waiting to
        // settle our win — so present this as 'Finishing' rather than 'Their
        // turn'. This is driven generically by game_finished, not anything
        // game-specific.
        const weFinishedTheGame =
          status === 'on-chain-their-turn' && gs.other_params?.game_finished === true;
        if (weFinishedTheGame) {
          turnStateRef.current = 'finishing';
          setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'finishing' }));
          setHandStatus('finishing');
        } else {
          turnStateRef.current = 'their-turn';
          setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'their-turn' }));
          setHandStatus(status === 'on-chain-their-turn' && coinHex ? 'their-turn' : 'active');
        }
      } else if (status === 'replaying') {
        turnStateRef.current = 'replaying';
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'replaying' }));
        setHandStatus(coinHex ? 'replaying-move' : 'active');
      } else if (status === 'illegal-move-detected') {
        turnStateRef.current = 'opponent-illegal-move';
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'opponent-illegal-move' }));
        setHandStatus(coinHex ? 'slashing' : 'active');
      }

      for (const event of gameplayEventsForGameStatus(n, gameIdsRef.current, null)) {
        gameplayEventSubject.next(event);
      }
    } else if ('InsufficientBalance' in n) {
      const ib = n.InsufficientBalance as Record<string, unknown> | undefined;
      const ibId = String(ib?.id ?? '');
      log(`[notify] InsufficientBalance id=${ibId} ours=${ib?.our_balance_short} theirs=${ib?.their_balance_short}`);
      if (gameIdsRef.current.includes(ibId)) {
        setGameIds(prev => prev.filter(id => id !== ibId));
        gameIdsRef.current = gameIdsRef.current.filter(id => id !== ibId);
      }
      setHandStatus('ended');
      cancelStalePeerProposals();
      setCachedPeerProposal(null);
      setReviewPeerProposal(null);
      pushGame({ kind: 'insufficient-bal', title: 'Notice', message: 'Insufficient balance for that proposal. The hand could not start.' });
      setBetweenHandMode('compose-proposal');
    } else if ('ProposalCancelled' in n) {
      const proposalId = String(n.ProposalCancelled?.id ?? '');
      const reason = String((n.ProposalCancelled as Record<string, unknown>)?.reason ?? '');
      const isLocal = LOCAL_CANCEL_REASONS.has(reason);
      log(`[notify] ProposalCancelled id=${proposalId} reason=${reason} local=${isLocal}`);

      const cancelledTerms = proposalId ? proposalTermsByIdRef.current[proposalId] ?? null : null;
      const wasOurs = proposalId ? outgoingProposalIdsRef.current.has(proposalId) : false;
      if (proposalId) {
        delete proposalTermsByIdRef.current[proposalId];
        outgoingProposalIdsRef.current.delete(proposalId);
        if (cachedPeerProposalRef.current?.id === proposalId) {
          setCachedPeerProposal(null);
        }
        if (reviewPeerProposalRef.current?.id === proposalId) {
          setReviewPeerProposal(null);
          setBetweenHandMode('compose-proposal');
        }
      }

      if (isLocal && cancelledTerms) {
        pendingRetryTermsRef.current = cancelledTerms;
      } else if (reason === 'CancelledByPeer') {
        pendingRetryTermsRef.current = null;
        setComposeProposalSent(false);
        const wasSameTermsReq = sameTermsRequestedRef.current && wasOurs;
        sameTermsRequestedRef.current = false;
        setNewHandRequested(false);
        if (wasSameTermsReq) {
          // Our "New Hand" same-terms proposal was rejected by the peer — most
          // likely because they're about to send a counter-proposal. Don't show
          // a scary toast; stay in 'decision' mode briefly so that when their
          // proposal arrives, the 'decision' handler routes it to review with
          // no flicker. If no counter-proposal arrives quickly, fall back to
          // compose-proposal mode so the user isn't stuck.
          log('[notify] our same-terms proposal rejected; awaiting counter-proposal');
          clearExpectingCounterProposal();
          expectingCounterProposalRef.current = true;
          rejectionFallbackTimerRef.current = setTimeout(() => {
            rejectionFallbackTimerRef.current = null;
            if (!expectingCounterProposalRef.current) return;
            expectingCounterProposalRef.current = false;
            setComposePerHandAmount(lastHandTermsRef.current.myContribution);
            setComposeGameTimeout(lastHandTermsRef.current.gameTimeout);
            setBetweenHandMode('compose-proposal');
          }, 300);
        } else {
          pushGame({ kind: 'proposal-rejected', title: 'Notice', message: 'Your proposal was rejected by the other side.' });
        }
      } else {
        pendingRetryTermsRef.current = null;
      }
    } else if ('ActionFailed' in n) {
      const reason = String(n.ActionFailed?.reason ?? 'Unknown error');
      log(`[game] action failed: ${reason}`);
      pushChannel({ kind: 'action-failed', title: 'Error', message: reason });
    }
  }, [iStarted, proposeNewGame, gameplayEventSubject, gameConnectionState.stateIdentifier, triggerGoOnChain, pushChannel, pushGame, clearExpectingCounterProposal, cancelStalePeerProposals]);

  // Subscribe to WASM events
  useEffect(() => {
    const subscription = sc.getObservable().subscribe({
      next: (evt: WasmEvent) => {
        switch (evt.type) {
          case 'notification':
            handleNotification(evt.data);
            break;
          case 'error':
            pushChannel({ kind: 'infra-error', title: 'Error', message: evt.error });
            break;
          case 'address':
            break;
          case 'log':
            log(`[wasm] ${evt.message}`);
            break;
          case 'terminal':
            break;
          default: {
            const _exhaustive: never = evt;
            console.warn('unhandled event type:', _exhaustive);
            break;
          }
        }
      }
    });

    if (!initStarted) {
      setInitStarted(true);
    }

    return () => {
      subscription.unsubscribe();
    };
  }, [sc, handleNotification, pushChannel]);

  // Drive the cradle's coin polling: the poller asks the cradle which coins to
  // watch and feeds raw chain state back via report_coin_states.
  useEffect(() => {
    if (!sc || !blockchain) return;
    sc.attachBlockchain(blockchain);
    return () => {
      sc.detachBlockchain(blockchain);
    };
  }, [sc, blockchain]);

  useEffect(() => {
    return () => {
      if (rejectionFallbackTimerRef.current) {
        clearTimeout(rejectionFallbackTimerRef.current);
        rejectionFallbackTimerRef.current = null;
      }
    };
  }, []);

  const chooseNewHandSameTerms = useCallback(() => {
    const lastTerms = lastHandTermsRef.current;
    const cached = cachedPeerProposalRef.current;
    if (cached) {
      if (termsEqual(cached.terms, lastTerms)) {
        try {
          scRef.current?.acceptProposal(cached.id);
        } catch (e) {
          console.error('acceptProposal failed:', e);
        }
        sameTermsRequestedRef.current = false;
        setNewHandRequested(false);
        return;
      }
      setReviewPeerProposal(cached);
      setCachedPeerProposal(null);
      setBetweenHandMode('review-incoming-proposal');
      return;
    }

    if (
      !balanceCanCover(channelStatus.ourBalance, lastTerms.myContribution) ||
      !balanceCanCover(channelStatus.theirBalance, lastTerms.theirContribution)
    ) {
      sameTermsRequestedRef.current = false;
      setNewHandRequested(false);
      setComposeProposalSent(false);
      setComposePerHandAmount(lastTerms.myContribution);
      setComposeGameTimeout(lastTerms.gameTimeout);
      setComposeGameType(lastTerms.gameType);
      setBetweenHandMode('compose-proposal');
      return;
    }
    sameTermsRequestedRef.current = true;
    setNewHandRequested(true);
    proposeNewGame(lastTerms);
  }, [channelStatus.ourBalance, channelStatus.theirBalance, proposeNewGame]);

  const chooseDoNotUseCurrentProposal = useCallback(() => {
    const cached = cachedPeerProposalRef.current;
    if (cached) {
      if (!termsEqual(cached.terms, lastHandTermsRef.current)) {
        setReviewPeerProposal(cached);
        setCachedPeerProposal(null);
        setBetweenHandMode('review-incoming-proposal');
        return;
      }
      try {
        scRef.current?.cancel_proposal(cached.id);
      } catch (e) {
        console.error('cancel_proposal failed:', e);
      }
      setCachedPeerProposal(null);
    }
    setRejectedOnceTerms(lastHandTermsRef.current);
    setComposeProposalSent(false);
    setComposePerHandAmount(lastHandTermsRef.current.myContribution);
    setComposeGameTimeout(lastHandTermsRef.current.gameTimeout);
    setBetweenHandMode('compose-proposal');
  }, []);

  const openComposeProposal = useCallback(() => {
    setComposeProposalSent(false);
    setComposePerHandAmount(lastHandTermsRef.current.myContribution);
    setComposeGameTimeout(lastHandTermsRef.current.gameTimeout);
    setComposeGameType(lastHandTermsRef.current.gameType);
    setBetweenHandMode('compose-proposal');
  }, []);

  const submitComposedProposal = useCallback((perHandAmount: bigint, gameType: string, gameTimeout: bigint, spacepokerUnitSize?: bigint) => {
    if (perHandAmount <= 0n || gameTimeout <= 0n) return;
    proposeNewGame({
      gameType,
      myContribution: perHandAmount,
      theirContribution: perHandAmount,
      gameTimeout,
      spacepokerUnitSize: gameType === 'spacepoker' ? spacepokerUnitSize : undefined,
    });
    setComposeProposalSent(true);
  }, [proposeNewGame]);

  const acceptReviewedProposal = useCallback(() => {
    const review = reviewPeerProposalRef.current;
    if (!review) return;
    try {
      scRef.current?.acceptProposal(review.id);
    } catch (e) {
      console.error('acceptProposal failed:', e);
    }
    setBetweenHandMode('decision');
  }, []);

  const rejectReviewedProposal = useCallback(() => {
    const review = reviewPeerProposalRef.current;
    if (review) {
      try {
        scRef.current?.cancel_proposal(review.id);
      } catch (e) {
        console.error('cancel_proposal failed:', e);
      }
    }
    setReviewPeerProposal(null);
    setComposeProposalSent(false);
    setBetweenHandMode('compose-proposal');
  }, []);

  const startCleanShutdown = useCallback(() => {
    setCleanShutdownStarted(true);
    scRef.current?.cleanShutdown();
  }, []);

  const goOnChain = useCallback(() => {
    triggerGoOnChain();
  }, [triggerGoOnChain]);

  const sessionModel = useMemo(() => createSessionModel({
    restore: {
      restoring: params.restoring ?? false,
      status: restoreStatus,
      error: restoreError,
      trackerReconciled: restoreStatus === 'restored',
    },
    channel: {
      status: channelStatus,
      connection: gameConnectionState,
      goOnChainPressed,
      cleanShutdownStarted,
      dismissedChannelState,
      queue: channelQueue,
    },
    game: {
      coin: gameCoin,
      handStatus,
      terminal: gameTerminal,
      handKey,
      activeIds: gameIds,
      lastDisplayedId: lastDisplayedGameId,
      activeGameType,
      handState: sc.handState,
      queue: gameQueue,
    },
    betweenHand: {
      mode: betweenHandMode,
      cachedPeerProposal,
      reviewPeerProposal,
      rejectedOnceTerms,
      lastTerms: lastHandTerms,
      composePerHandAmount,
      composeGameTimeout,
      composeGameType,
      composeProposalSent,
      newHandRequested,
      outgoingProposalIds: Array.from(outgoingProposalIdsRef.current),
      outgoingProposalTerms: { ...proposalTermsByIdRef.current },
      pendingRetryTerms: pendingRetryTermsRef.current,
    },
    history: {
      humanHistory: [],
      wasmNotificationHistory: sc.history,
      diagnosticLog: sc.logHistory,
    },
    myRunningBalance,
    lastOutcomeWin: sc.lastOutcomeWin,
  }), [
    params.restoring, restoreStatus, restoreError,
    channelStatus, gameConnectionState, goOnChainPressed, cleanShutdownStarted,
    dismissedChannelState, channelQueue, gameCoin, handStatus, gameTerminal, handKey,
    gameIds, lastDisplayedGameId, activeGameType, sc.handState,
    gameQueue, betweenHandMode, cachedPeerProposal, reviewPeerProposal,
    rejectedOnceTerms, lastHandTerms, composePerHandAmount, composeGameTimeout,
    composeGameType, composeProposalSent, newHandRequested, myRunningBalance,
    sc.history, sc.logHistory,
    sc.lastOutcomeWin,
  ]);
  const gameSessionView = selectGameSessionView(sessionModel);
  const gameSpecificView = selectGameSpecificView(sessionModel);
  const sessionPhase = selectSessionPhase(sessionModel);

  return {
    sessionModel,
    gameConnectionState,
    amount,
    perGameAmount,
    currentHandAmount: gameSessionView.currentHandAmount,
    myRunningBalance,
    iStarted,
    playerNumber,
    channelStatus: gameSessionView.channelStatus,
    gameCoin: gameSessionView.gameCoin,
    gameTerminal: gameSessionView.gameTerminal,
    handKey,
    activeGameId: gameSessionView.activeGameId,
    activeGameType: gameSessionView.activeGameType,
    displayGameId: gameSessionView.displayGameId,
    sessionController: sc,
    gameplayEvent$: gameplayEventSubject.asObservable(),
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    betweenHandMode,
    cachedPeerProposal,
    reviewPeerProposal,
    lastHandTerms,
    composePerHandAmount,
    composeGameTimeout,
    composeGameType,
    setComposeGameType,
    composeProposalSent,
    newHandRequested,
    chooseNewHandSameTerms,
    chooseDoNotUseCurrentProposal,
    openComposeProposal,
    setComposePerHandAmount,
    setComposeGameTimeout,
    submitComposedProposal,
    acceptReviewedProposal,
    rejectReviewedProposal,
    startCleanShutdown,
    cleanShutdownStarted,
    goOnChain,
    betweenHands: gameSessionView.betweenHands,
    lastOutcome,
    restoredOutcomeWin,
    goOnChainPressed,
    restoreStatus,
    restoreError,
    sessionPhase,
    channelQueue: gameSessionView.channelQueue,
    gameQueue: gameSessionView.gameQueue,
    dismissChannel,
    dismissGame,
    gameSpecificView,
  };
}
