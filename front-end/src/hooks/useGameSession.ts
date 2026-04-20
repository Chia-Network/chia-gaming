import { useState, useEffect, useCallback, useRef } from 'react';
import { Subject, Observable } from 'rxjs';
import {
  GameConnectionState,
  GameSessionParams,
  CalpokerOutcome,
  BlockchainReport,
  PeerConnectionResult,
  WasmEvent,
  WasmNotification,
  ChannelState,
  ChannelStatusPayload,
  GameStatusPayload,
  GameStatusState,
} from '../types/ChiaGaming';
import { getActiveBlockchain } from './activeBlockchain';
import {
  getBlobSingleton,
  initStarted,
  setInitStarted,
} from './blobSingleton';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { SessionSave, saveSession, getDefaultFee, getBlockchainType } from './save';
import { coinIdFromBytes } from '../util';
import { log } from '../services/log';

export type GameplayEvent =
  | { ProposalAccepted: { id: number | string } }
  | { OpponentMoved: { readable: number[] } }
  | { GameMessage: { readable: number[] } }
  | { _terminal: true; notification: WasmNotification };

function parseCoinAmount(coin: unknown): string | null {
  if (!Array.isArray(coin) || coin.length < 64 || !coin.every((b): b is number => typeof b === 'number')) {
    return null;
  }
  let value = 0n;
  for (let i = 64; i < coin.length; i++) {
    value = (value << 8n) + BigInt(coin[i] & 0xff);
  }
  return value.toString();
}

function asCoinBytes(coin: unknown): number[] | null {
  if (!Array.isArray(coin) || coin.length === 0 || !coin.every((b): b is number => typeof b === 'number')) {
    return null;
  }
  return coin;
}

async function coinIdHex(coin: unknown): Promise<string | null> {
  const bytes = asCoinBytes(coin);
  return bytes ? coinIdFromBytes(bytes) : null;
}

export type GameTurnState = 'my-turn' | 'their-turn' | 'playing-on-chain' | 'replaying' | 'opponent-illegal-move' | 'ended';

export interface GameCoinInfo {
  coinHex: string | null;
  turnState: GameTurnState;
}

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

export interface GameTerminalInfo {
  type: GameTerminalType;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
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
  id: number;
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

const ATTENTION_STATES: ChannelState[] = [
  'GoingOnChain', 'Unrolling', 'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale', 'Failed',
];

const WINDING_DOWN_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'ShutdownTransactionPending', 'GoingOnChain', 'Unrolling',
  'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale', 'Failed',
]);

const ON_CHAIN_FLOW_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'GoingOnChain', 'Unrolling', 'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale',
]);

const LOCAL_CANCEL_REASONS: ReadonlySet<string> = new Set([
  'SupersededByIncoming',
  'PeerProposalPending',
  'GameActive',
]);

export function isWindingDown(state: ChannelState): boolean {
  return WINDING_DOWN_STATES.has(state);
}

function parseAmount(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'Amount' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>).Amount);
  }
  return String(v);
}

function parseGameStatusTerminalInfo(gs: GameStatusPayload, rewardCoinHex: string | null): GameTerminalInfo {
  if (gs.status === 'ended-we-timed-out') {
    const clean = gs.other_params?.game_finished;
    return {
      type: 'we-timed-out',
      label: clean ? 'Game ended cleanly' : 'Ended: we timed out',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-opponent-timed-out') {
    const clean = gs.other_params?.game_finished;
    return {
      type: 'opponent-timed-out',
      label: clean ? 'Game ended cleanly' : 'Ended: opponent timed out',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-we-slashed-opponent') {
    return {
      type: 'we-slashed-opponent',
      label: 'Ended: we slashed opponent',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-opponent-slashed-us') {
    return {
      type: 'opponent-slashed-us',
      label: 'Ended: opponent slashed us',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (gs.status === 'ended-opponent-successfully-cheated') {
    return {
      type: 'opponent-successfully-cheated',
      label: 'Ended: opponent successfully cheated',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex,
    };
  }

  if (gs.status === 'ended-cancelled') {
    return {
      type: 'ended-cancelled',
      label: 'Ended: cancelled',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (gs.status === 'ended-error') {
    return {
      type: 'game-error',
      label: gs.reason ? `Ended: ${gs.reason}` : 'Ended: error',
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
  myContribution: bigint;
  theirContribution: bigint;
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
  return !!a && !!b && a.myContribution === b.myContribution && a.theirContribution === b.theirContribution;
}

function parseTermsFromNotificationValue(value: unknown): HandTerms | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const mine = parseAmount(obj.my_contribution);
  const theirs = parseAmount(obj.their_contribution);
  if (!mine || !theirs) return null;
  try {
    return {
      myContribution: BigInt(mine),
      theirContribution: BigInt(theirs),
    };
  } catch {
    return null;
  }
}

function parseIncomingProposal(value: unknown): BetweenHandProposal | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const idRaw = obj.id;
  const terms = parseTermsFromNotificationValue(value);
  if (!terms || (typeof idRaw !== 'number' && typeof idRaw !== 'string')) return null;
  return {
    id: String(idRaw),
    terms,
  };
}

export interface UseGameSessionResult {
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
  displayGameId: string | null;
  gameObject: WasmBlobWrapper;
  gameplayEvent$: Observable<GameplayEvent>;
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  betweenHandMode: BetweenHandMode;
  cachedPeerProposal: BetweenHandProposal | null;
  reviewPeerProposal: BetweenHandProposal | null;
  composePerHandAmount: bigint;
  chooseNewHandSameTerms: () => void;
  chooseDoNotUseCurrentProposal: () => void;
  openComposeProposal: () => void;
  setComposePerHandAmount: (value: bigint) => void;
  composeProposalSent: boolean;
  newHandRequested: boolean;
  submitComposedProposal: (perHandAmount: bigint) => void;
  acceptReviewedProposal: () => void;
  rejectReviewedProposal: () => void;
  startCleanShutdown: () => void;
  goOnChain: () => void;
  betweenHands: boolean;
  lastOutcome: CalpokerOutcome | undefined;
  restoredOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  goOnChainPressed: boolean;
  channelQueue: QueuedNotification[];
  gameQueue: QueuedNotification[];
  dismissChannel: () => void;
  dismissGame: () => void;
}

export function useGameSession(
  params: GameSessionParams,
  uniqueId: string,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void,
  appendGameLog: (line: string) => void,
  sessionSave?: SessionSave,
): UseGameSessionResult {
  const { iStarted, amount, perGameAmount } = params;
  const playerNumber = iStarted ? 1 : 2;

  const blockchain = getActiveBlockchain();

  const { gameObject } = getBlobSingleton(
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
  );

  if (params.myAlias) gameObject.myAlias = params.myAlias;
  if (params.opponentAlias) gameObject.opponentAlias = params.opponentAlias;

  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>(() =>
      sessionSave?.channelReady
        ? { stateIdentifier: 'running' as const, stateDetail: [] }
        : { stateIdentifier: 'starting' as const, stateDetail: ['before handshake'] }
    );
  const [myRunningBalance, setMyRunningBalance] = useState(() =>
    sessionSave?.myRunningBalance ? BigInt(sessionSave.myRunningBalance) : 0n
  );
  const [goOnChainPressed, setGoOnChainPressed] = useState(false);
  const [channelStatus, setChannelStatus] = useState<ChannelStatusInfo>(() => {
    if (!sessionSave?.channelReady) return INITIAL_CHANNEL_STATUS;
    if (sessionSave.channelStatus) return channelStatusFromPayload(sessionSave.channelStatus, null);
    return { ...INITIAL_CHANNEL_STATUS, state: 'Active' };
  });
  const channelStateRef = useRef<ChannelState>(
    sessionSave?.channelReady
      ? (sessionSave.channelStatus?.state ?? 'Active')
      : INITIAL_CHANNEL_STATUS.state
  );

  const [dismissedChannelState, setDismissedChannelState] = useState<ChannelState | null>(
    () => (sessionSave?.dismissedChannelState as ChannelState | undefined) ?? null
  );
  const dismissedChannelStateRef = useRef<ChannelState | null>(dismissedChannelState);
  dismissedChannelStateRef.current = dismissedChannelState;

  const [channelQueue, setChannelQueue] = useState<QueuedNotification[]>(() =>
    (sessionSave?.channelNotifQueue ?? []) as QueuedNotification[]
  );
  const [gameQueue, setGameQueue] = useState<QueuedNotification[]>(() =>
    (sessionSave?.gameNotifQueue ?? []) as QueuedNotification[]
  );
  const notifIdRef = useRef(
    Math.max(
      0,
      ...(sessionSave?.channelNotifQueue ?? []).map(n => n.id),
      ...(sessionSave?.gameNotifQueue ?? []).map(n => n.id),
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
    coinHex: sessionSave?.gameCoinHex ?? null,
    turnState: (sessionSave?.gameTurnState as GameTurnState) ?? 'my-turn',
  }));
  const [gameTerminal, setGameTerminal] = useState<GameTerminalInfo>(() => {
    if (sessionSave?.gameTerminalType && sessionSave.gameTerminalType !== 'none') {
      return {
        type: sessionSave.gameTerminalType as GameTerminalType,
        label: sessionSave.gameTerminalLabel ?? null,
        myReward: sessionSave.gameTerminalReward ?? null,
        rewardCoinHex: sessionSave.gameTerminalRewardCoin ?? null,
      };
    }
    return INITIAL_GAME_TERMINAL;
  });
  const [handKey, setHandKey] = useState(() =>
    (sessionSave?.activeGameId || sessionSave?.handState) ? 1 : 0
  );
  const [gameIds, setGameIds] = useState<string[]>(() =>
    sessionSave?.activeGameId ? [sessionSave.activeGameId] : []
  );
  const [lastDisplayedGameId, setLastDisplayedGameId] = useState<string | null>(() =>
    sessionSave?.activeGameId ?? null
  );
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const restoredOutcomeWin = sessionSave?.lastOutcomeWin;
  const [betweenHandMode, setBetweenHandMode] = useState<BetweenHandMode>(() => {
    const mode = sessionSave?.betweenHandMode;
    if (mode === 'decision' || mode === 'compose-proposal' || mode === 'review-incoming-proposal') {
      return mode;
    }
    return 'decision';
  });
  const [cachedPeerProposal, setCachedPeerProposal] = useState<BetweenHandProposal | null>(() => {
    const saved = sessionSave?.betweenHandCachedPeerProposal;
    if (!saved) return null;
    try {
      return {
        id: saved.id,
        terms: {
          myContribution: BigInt(saved.my_contribution),
          theirContribution: BigInt(saved.their_contribution),
        },
      };
    } catch {
      return null;
    }
  });
  const [reviewPeerProposal, setReviewPeerProposal] = useState<BetweenHandProposal | null>(() => {
    const saved = sessionSave?.betweenHandReviewPeerProposal;
    if (!saved) return null;
    try {
      return {
        id: saved.id,
        terms: {
          myContribution: BigInt(saved.my_contribution),
          theirContribution: BigInt(saved.their_contribution),
        },
      };
    } catch {
      return null;
    }
  });
  const [rejectedOnceTerms, setRejectedOnceTerms] = useState<HandTerms | null>(() => {
    const saved = sessionSave?.betweenHandRejectedOnceTerms;
    if (!saved) return null;
    try {
      return {
        myContribution: BigInt(saved.my_contribution),
        theirContribution: BigInt(saved.their_contribution),
      };
    } catch {
      return null;
    }
  });
  const [lastHandTerms, setLastHandTerms] = useState<HandTerms>(() => {
    const saved = sessionSave?.betweenHandLastTerms;
    if (saved) {
      try {
        return {
          myContribution: BigInt(saved.my_contribution),
          theirContribution: BigInt(saved.their_contribution),
        };
      } catch {
        // fall through to defaults
      }
    }
    return {
      myContribution: perGameAmount,
      theirContribution: perGameAmount,
    };
  });
  const [composePerHandAmount, setComposePerHandAmount] = useState<bigint>(() => {
    const saved = sessionSave?.betweenHandComposePerHand;
    if (!saved) return perGameAmount;
    try {
      return BigInt(saved);
    } catch {
      return perGameAmount;
    }
  });

  const lastOutcomeRef = useRef<CalpokerOutcome | undefined>(undefined);
  const handKeyRef = useRef<number>((sessionSave?.activeGameId || sessionSave?.handState) ? 1 : 0);
  const gameIdsRef = useRef<string[]>(sessionSave?.activeGameId ? [sessionSave.activeGameId] : []);
  const sameTermsRequestedRef = useRef<boolean>(false);
  const firstGameAcceptedRef = useRef<boolean>(!!sessionSave?.channelReady);
  const betweenHandModeRef = useRef<BetweenHandMode>(betweenHandMode);
  const cachedPeerProposalRef = useRef<BetweenHandProposal | null>(cachedPeerProposal);
  const reviewPeerProposalRef = useRef<BetweenHandProposal | null>(reviewPeerProposal);
  const rejectedOnceTermsRef = useRef<HandTerms | null>(rejectedOnceTerms);
  const lastHandTermsRef = useRef<HandTerms>(lastHandTerms);
  const proposalTermsByIdRef = useRef<Record<string, HandTerms>>({});
  const outgoingProposalIdsRef = useRef<Set<string>>(new Set());
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
  betweenHandModeRef.current = betweenHandMode;
  cachedPeerProposalRef.current = cachedPeerProposal;
  reviewPeerProposalRef.current = reviewPeerProposal;
  rejectedOnceTermsRef.current = rejectedOnceTerms;
  lastHandTermsRef.current = lastHandTerms;

  const gameObjectRef = useRef<WasmBlobWrapper>(gameObject);
  gameObjectRef.current = gameObject;

  const cancelStalePeerProposals = useCallback((exceptId?: string) => {
    const go = gameObjectRef.current;
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
    const go = gameObjectRef.current;
    const wasm = go?.getWasmFields();
    if (!wasm) return;
    const save: SessionSave = {
      blockchainType: getBlockchainType(),
      ...wasm,
      gameCoinHex: gameCoin.coinHex,
      gameTurnState: gameCoin.turnState,
      gameTerminalType: gameTerminal.type !== 'none' ? gameTerminal.type : undefined,
      gameTerminalLabel: gameTerminal.label,
      gameTerminalReward: gameTerminal.myReward,
      gameTerminalRewardCoin: gameTerminal.rewardCoinHex,
      myRunningBalance: myRunningBalance !== 0n ? myRunningBalance.toString() : undefined,
      channelNotifQueue: channelQueue.length > 0
        ? channelQueue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
      gameNotifQueue: gameQueue.length > 0
        ? gameQueue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
      dismissedChannelState: dismissedChannelState ?? undefined,
      betweenHandMode: betweenHandMode ?? undefined,
      betweenHandComposePerHand: composePerHandAmount.toString(),
      betweenHandLastTerms: {
        my_contribution: lastHandTerms.myContribution.toString(),
        their_contribution: lastHandTerms.theirContribution.toString(),
      },
      betweenHandRejectedOnceTerms: rejectedOnceTerms
        ? {
            my_contribution: rejectedOnceTerms.myContribution.toString(),
            their_contribution: rejectedOnceTerms.theirContribution.toString(),
          }
        : undefined,
      betweenHandCachedPeerProposal: cachedPeerProposal
        ? {
            id: cachedPeerProposal.id,
            my_contribution: cachedPeerProposal.terms.myContribution.toString(),
            their_contribution: cachedPeerProposal.terms.theirContribution.toString(),
          }
        : undefined,
      betweenHandReviewPeerProposal: reviewPeerProposal
        ? {
            id: reviewPeerProposal.id,
            my_contribution: reviewPeerProposal.terms.myContribution.toString(),
            their_contribution: reviewPeerProposal.terms.theirContribution.toString(),
          }
        : undefined,
    };
    saveSession(save);
  }, [
    gameCoin, gameTerminal, myRunningBalance, betweenHandMode,
    composePerHandAmount, lastHandTerms, rejectedOnceTerms,
    cachedPeerProposal, reviewPeerProposal,
    channelQueue, dismissedChannelState, gameQueue,
  ]);

  // Save when JS-side state changes
  useEffect(() => {
    persistFullSession();
  }, [persistFullSession]);

  // Wire up the wasm-side save trigger
  useEffect(() => {
    const go = gameObjectRef.current;
    if (!go) return;
    go.onSaveNeeded = persistFullSession;
    return () => { go.onSaveNeeded = null; };
  }, [persistFullSession]);

  const proposeNewGame = useCallback((terms: HandTerms) => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    if (gameIdsRef.current.length > 0) {
      log('[notify] proposeNewGame blocked — game active');
      return;
    }
    log(`[notify] proposeNewGame sending proposal myContrib=${terms.myContribution} theirContrib=${terms.theirContribution}`);
    try {
      const ids = go.proposeGame({
        game_type: '63616c706f6b6572',
        timeout: 15,
        amount: terms.myContribution + terms.theirContribution,
        my_contribution: terms.myContribution,
        my_turn: !iStarted,
        parameters: null,
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
    setGameIds(prev => prev.slice(1));
    gameIdsRef.current = gameIdsRef.current.slice(1);
    setGameCoin({ coinHex: null, turnState: 'my-turn' });
    const delta = outcome.my_win_outcome === 'win' ? perGameAmount
                : outcome.my_win_outcome === 'lose' ? -perGameAmount
                : 0n;
    setMyRunningBalance(prev => prev + delta);
    const go = gameObjectRef.current;
    if (go) {
      go.lastOutcomeWin = outcome.my_win_outcome;
    }
    cancelStalePeerProposals();
    pendingRetryTermsRef.current = null;
    setBetweenHandMode('decision');
    setCachedPeerProposal(null);
    setReviewPeerProposal(null);
    setNewHandRequested(false);
  }, [perGameAmount, cancelStalePeerProposals]);

  const onTurnChanged = useCallback((isMyTurn: boolean) => {
    setGameCoin(prev => ({
      coinHex: prev.coinHex,
      turnState: isMyTurn
        ? 'my-turn'
        : ON_CHAIN_FLOW_STATES.has(channelStateRef.current)
          ? 'playing-on-chain'
          : 'their-turn',
    }));
  }, []);

  const triggerGoOnChain = useCallback(() => {
    log('[game] going on chain');
    setGoOnChainPressed(true);
    gameObjectRef.current?.goOnChain();
  }, []);

  const handleNotification = useCallback(async (n: WasmNotification) => {
    const go = gameObjectRef.current;
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
      if (ATTENTION_STATES.includes(cs.state)
          && dismissedChannelStateRef.current !== cs.state) {
        const label = cs.state === 'Failed' || cs.state === 'ResolvedStale' ? 'Error' : `Channel: ${cs.state}`;
        pushChannel({ kind: 'channel-state', title: label, message: info.advisory ?? '', payload: info });
      }
      if (cs.state === 'Active' && info.gameAllocated === '0') {
        const ours = BigInt(info.ourBalance ?? '0');
        const theirs = BigInt(info.theirBalance ?? '0');
        if (ours <= 0n || theirs <= 0n) {
          const msg = theirs <= 0n
            ? 'Session over — you won everything!'
            : 'Session over — you lost everything.';
          pushChannel({ kind: 'session-over', title: 'Session Over', message: msg });
          gameObjectRef.current?.cleanShutdown();
          return;
        }
      }
      if (cs.state === 'Active' && gameConnectionState.stateIdentifier !== 'running') {
        setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      }
      if (cs.state === 'Active' && !firstGameAcceptedRef.current && iStarted) {
        firstGameAcceptedRef.current = true;
        proposeNewGame(lastHandTermsRef.current);
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

      if (!firstGameAcceptedRef.current && !iStarted) {
        log(`[notify] ProposalMade id=${incoming.id} auto-accepting first hand`);
        firstGameAcceptedRef.current = true;
        try {
          go?.acceptProposal(incoming.id);
        } catch (e) {
          console.error('acceptProposal failed:', e);
        }
        return;
      }

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
      }
      go?.setHandState(null);
      setHandKey(prev => prev + 1);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      setGameCoin({ coinHex: null, turnState: iStarted ? 'their-turn' : 'my-turn' });
      setGameTerminal(INITIAL_GAME_TERMINAL);
      setCachedPeerProposal(null);
      setReviewPeerProposal(null);
      setRejectedOnceTerms(null);
      setGameQueue(prev => prev.filter(n => n.kind !== 'proposal-rejected'));
      setBetweenHandMode('decision');
      gameplayEventSubject.next({ ProposalAccepted: { id: gpa.id as number | string } });
    } else if ('GameStatus' in n) {
      const gs = n.GameStatus as GameStatusPayload | undefined;
      if (!gs) return;
      const gid = String(gs.id);
      const status = gs.status;
      const coinHex = await coinIdHex(gs.coin_id);
      const inOnChainFlow = ON_CHAIN_FLOW_STATES.has(channelStateRef.current);
      const isOnChainTurnStatus =
        status === 'on-chain-my-turn' || status === 'on-chain-their-turn' || status === 'replaying';
      const isLocalTurnStatus = status === 'my-turn' || status === 'their-turn';
      const ignoreLocalTurnDuringOnChain = inOnChainFlow && isLocalTurnStatus;
      if (ignoreLocalTurnDuringOnChain) {
        // During on-chain flow, on-chain turn statuses are authoritative.
        // Keep any known coin id if local status messages continue to arrive.
        if (coinHex) {
          setGameCoin(prev => ({ ...prev, coinHex }));
        }
      } else if (status === 'my-turn' || status === 'on-chain-my-turn') {
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'my-turn' }));
      } else if (status === 'their-turn' || status === 'on-chain-their-turn') {
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'their-turn' }));
      } else if (status === 'replaying') {
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'replaying' }));
      } else if (status === 'illegal-move-detected') {
        setGameCoin(prev => ({ coinHex: coinHex ?? prev.coinHex, turnState: 'opponent-illegal-move' }));
      } else if (isTerminalStatus(status)) {
        const other = gs.other_params ?? null;
        const readable = other?.readable;
        const readableArr = Array.isArray(readable) && readable.every((x): x is number => typeof x === 'number')
          ? readable
          : null;
        if (readableArr) {
          const hasMoverShare = other?.mover_share != null;
          if (hasMoverShare) {
            gameplayEventSubject.next({ OpponentMoved: { readable: readableArr } });
          } else if (gameIdsRef.current.includes(gid)) {
            gameplayEventSubject.next({ GameMessage: { readable: readableArr } });
          }
        }

        const rewardCoinHex = await coinIdHex(gs.coin_id);
        const terminalInfo = parseGameStatusTerminalInfo(gs, rewardCoinHex);
        setGameTerminal(terminalInfo);
        setGameCoin(prev => ({ ...prev, coinHex: null, turnState: 'ended' }));
        const hadActiveGame = gameIdsRef.current.length > 0;
        if (hadActiveGame) {
          setGameIds(prev => prev.slice(1));
          gameIdsRef.current = gameIdsRef.current.slice(1);
          cancelStalePeerProposals();
          setBetweenHandMode('decision');
          setCachedPeerProposal(null);
          setReviewPeerProposal(null);
          if (inOnChainFlow) {
            const attentionInfo: GameTerminalAttentionInfo = {
              label: terminalInfo.label ?? `Ended: ${status}`,
              myReward: terminalInfo.myReward,
              rewardCoinHex: terminalInfo.rewardCoinHex,
            };
            pushGame({ kind: 'game-terminal', title: attentionInfo.label, message: '', payload: attentionInfo });
          }
        }
        gameplayEventSubject.next({ _terminal: true, notification: n });
        return;
      }

      const other = gs.other_params ?? null;
      const readable = other?.readable;
      const readableArr = Array.isArray(readable) && readable.every((x): x is number => typeof x === 'number')
        ? readable
        : null;
      if (readableArr) {
        const hasMoverShare = other?.mover_share != null;
        if (hasMoverShare) {
          gameplayEventSubject.next({ OpponentMoved: { readable: readableArr } });
        } else if (gameIdsRef.current.includes(gid)) {
          gameplayEventSubject.next({ GameMessage: { readable: readableArr } });
        }
      }
    } else if ('InsufficientBalance' in n) {
      const ib = n.InsufficientBalance as Record<string, unknown> | undefined;
      const ibId = String(ib?.id ?? '');
      log(`[notify] InsufficientBalance id=${ibId} ours=${ib?.our_balance_short} theirs=${ib?.their_balance_short}`);
      if (gameIdsRef.current.includes(ibId)) {
        setGameIds(prev => prev.filter(id => id !== ibId));
        gameIdsRef.current = gameIdsRef.current.filter(id => id !== ibId);
      }
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
    const subscription = gameObject.getObservable().subscribe({
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
  }, [gameObject, handleNotification, pushChannel]);

  // Subscribe to blockchain block data
  useEffect(() => {
    const subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        gameObject?.blockNotification(e.peak, e.block ?? [], e.report);
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameObject, blockchain]);

  useEffect(() => {
    return () => {
      if (rejectionFallbackTimerRef.current) {
        clearTimeout(rejectionFallbackTimerRef.current);
        rejectionFallbackTimerRef.current = null;
      }
    };
  }, []);

  const chooseNewHandSameTerms = useCallback(() => {
    const cached = cachedPeerProposalRef.current;
    if (cached) {
      if (termsEqual(cached.terms, lastHandTermsRef.current)) {
        try {
          gameObjectRef.current?.acceptProposal(cached.id);
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
    sameTermsRequestedRef.current = true;
    setNewHandRequested(true);
    proposeNewGame(lastHandTermsRef.current);
  }, [proposeNewGame]);

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
        gameObjectRef.current?.cancel_proposal(cached.id);
      } catch (e) {
        console.error('cancel_proposal failed:', e);
      }
      setCachedPeerProposal(null);
    }
    setRejectedOnceTerms(lastHandTermsRef.current);
    setComposeProposalSent(false);
    setComposePerHandAmount(lastHandTermsRef.current.myContribution);
    setBetweenHandMode('compose-proposal');
  }, []);

  const openComposeProposal = useCallback(() => {
    setComposeProposalSent(false);
    setComposePerHandAmount(lastHandTermsRef.current.myContribution);
    setBetweenHandMode('compose-proposal');
  }, []);

  const [composeProposalSent, setComposeProposalSent] = useState(false);
  const [newHandRequested, setNewHandRequested] = useState(false);
  const submitComposedProposal = useCallback((perHandAmount: bigint) => {
    if (perHandAmount <= 0n) return;
    proposeNewGame({
      myContribution: perHandAmount,
      theirContribution: perHandAmount,
    });
    setComposeProposalSent(true);
  }, [proposeNewGame]);

  const acceptReviewedProposal = useCallback(() => {
    const review = reviewPeerProposalRef.current;
    if (!review) return;
    try {
      gameObjectRef.current?.acceptProposal(review.id);
    } catch (e) {
      console.error('acceptProposal failed:', e);
    }
    setBetweenHandMode('decision');
  }, []);

  const rejectReviewedProposal = useCallback(() => {
    const review = reviewPeerProposalRef.current;
    if (review) {
      try {
        gameObjectRef.current?.cancel_proposal(review.id);
      } catch (e) {
        console.error('cancel_proposal failed:', e);
      }
    }
    setReviewPeerProposal(null);
    setBetweenHandMode('compose-proposal');
  }, []);

  const startCleanShutdown = useCallback(() => {
    gameObjectRef.current?.cleanShutdown();
  }, []);

  const goOnChain = useCallback(() => {
    triggerGoOnChain();
  }, [triggerGoOnChain]);

  return {
    gameConnectionState,
    amount,
    perGameAmount,
    currentHandAmount: lastHandTerms.myContribution,
    myRunningBalance,
    iStarted,
    playerNumber,
    channelStatus,
    gameCoin,
    gameTerminal,
    handKey,
    activeGameId: gameIds[0] ?? null,
    displayGameId: gameIds[0] ?? lastDisplayedGameId,
    gameObject,
    gameplayEvent$: gameplayEventSubject.asObservable(),
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    betweenHandMode,
    cachedPeerProposal,
    reviewPeerProposal,
    composePerHandAmount,
    composeProposalSent,
    newHandRequested,
    chooseNewHandSameTerms,
    chooseDoNotUseCurrentProposal,
    openComposeProposal,
    setComposePerHandAmount,
    submitComposedProposal,
    acceptReviewedProposal,
    rejectReviewedProposal,
    startCleanShutdown,
    goOnChain,
    betweenHands: handKey > 0 && gameIds.length === 0,
    lastOutcome,
    restoredOutcomeWin,
    goOnChainPressed,
    channelQueue,
    gameQueue,
    dismissChannel,
    dismissGame,
  };
}
