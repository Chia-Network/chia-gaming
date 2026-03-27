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
} from '../types/ChiaGaming';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import {
  getBlobSingleton,
  initStarted,
  setInitStarted,
} from './blobSingleton';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { SessionSave, BlockchainType } from './save';
import { toHexString } from '../util';
import { debugLog } from '../services/debugLog';

export type GameplayEvent =
  | { GameProposalAccepted: { id: number | string } }
  | { OpponentMoved: { readable: number[] } }
  | { GameMessage: { readable: number[] } }
  | { _terminal: true; notification: WasmNotification };

function coinPayloadToHex(coin: unknown): string | undefined {
  if (Array.isArray(coin) && coin.length > 0 && coin.every((b): b is number => typeof b === 'number')) {
    return toHexString(coin);
  }
  return undefined;
}

const TERMINAL_TYPES = [
  'WeTimedOut', 'OpponentTimedOut', 'WeSlashedOpponent',
  'OpponentSlashedUs', 'OpponentSuccessfullyCheated',
  'GameCancelled', 'GameError', 'InsufficientBalance',
];

function isTerminal(n: WasmNotification): boolean {
  return TERMINAL_TYPES.some(t => t in n);
}

export type GameTurnState = 'my-turn' | 'their-turn' | 'ended';

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
  | 'game-cancelled'
  | 'game-error';

export interface GameTerminalInfo {
  type: GameTerminalType;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
}

export interface ChannelStatusInfo {
  state: ChannelState;
  advisory: string | null;
  coinHex: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
}

const INITIAL_CHANNEL_STATUS: ChannelStatusInfo = {
  state: 'Handshaking',
  advisory: null,
  coinHex: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
};

const INITIAL_GAME_TERMINAL: GameTerminalInfo = {
  type: 'none',
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

const ATTENTION_STATES: ChannelState[] = [
  'Failed', 'ResolvedStale', 'ResolvedClean', 'ResolvedUnrolled',
];

const WINDING_DOWN_STATES: ReadonlySet<ChannelState> = new Set<ChannelState>([
  'ShutdownTransactionPending', 'GoingOnChain', 'Unrolling',
  'ResolvedClean', 'ResolvedUnrolled', 'ResolvedStale', 'Failed',
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

function getPayload(n: WasmNotification, key: string): Record<string, unknown> | null {
  const raw = (n as Record<string, unknown>)[key];
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as Record<string, unknown>;
}

function parseTerminalInfo(n: WasmNotification): GameTerminalInfo {
  const weTimedOut = getPayload(n, 'WeTimedOut');
  if (weTimedOut) {
    return {
      type: 'we-timed-out',
      label: 'Ended: we timed out',
      myReward: parseAmount(weTimedOut.our_reward),
      rewardCoinHex: coinPayloadToHex(weTimedOut.reward_coin) ?? null,
    };
  }

  const opponentTimedOut = getPayload(n, 'OpponentTimedOut');
  if (opponentTimedOut) {
    return {
      type: 'opponent-timed-out',
      label: 'Ended: opponent timed out',
      myReward: parseAmount(opponentTimedOut.our_reward),
      rewardCoinHex: coinPayloadToHex(opponentTimedOut.reward_coin) ?? null,
    };
  }

  const weSlashedOpponent = getPayload(n, 'WeSlashedOpponent');
  if (weSlashedOpponent) {
    return {
      type: 'we-slashed-opponent',
      label: 'Ended: we slashed opponent',
      myReward: parseAmount(weSlashedOpponent.reward_amount),
      rewardCoinHex: coinPayloadToHex(weSlashedOpponent.reward_coin) ?? null,
    };
  }

  const opponentSlashedUs = getPayload(n, 'OpponentSlashedUs');
  if (opponentSlashedUs) {
    return {
      type: 'opponent-slashed-us',
      label: 'Ended: opponent slashed us',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  const opponentSuccessfullyCheated = getPayload(n, 'OpponentSuccessfullyCheated');
  if (opponentSuccessfullyCheated) {
    return {
      type: 'opponent-successfully-cheated',
      label: 'Ended: opponent successfully cheated',
      myReward: parseAmount(opponentSuccessfullyCheated.our_reward),
      rewardCoinHex: coinPayloadToHex(opponentSuccessfullyCheated.reward_coin) ?? null,
    };
  }

  if (getPayload(n, 'GameCancelled')) {
    return {
      type: 'game-cancelled',
      label: 'Ended: cancelled',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (getPayload(n, 'InsufficientBalance')) {
    return {
      type: 'insufficient-balance',
      label: 'Ended: insufficient balance',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  if (getPayload(n, 'GameError')) {
    return {
      type: 'game-error',
      label: 'Ended: error',
      myReward: null,
      rewardCoinHex: null,
    };
  }

  return INITIAL_GAME_TERMINAL;
}

export interface UseGameSessionResult {
  error: string | undefined;
  gameConnectionState: GameConnectionState;
  amount: bigint;
  perGameAmount: bigint;
  myRunningBalance: bigint;
  iStarted: boolean;
  playerNumber: number;
  channelStatus: ChannelStatusInfo;
  gameCoin: GameCoinInfo;
  gameTerminal: GameTerminalInfo;
  handKey: number;
  activeGameId: string | null;
  gameObject: WasmBlobWrapper;
  gameplayEvent$: Observable<GameplayEvent>;
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  onDisplayComplete: () => void;
  playAgain: () => void;
  stopPlaying: () => void;
  goOnChain: () => void;
  showBetweenHandOverlay: boolean;
  lastOutcome: CalpokerOutcome | undefined;
  goOnChainPressed: boolean;
  actionFailedReason: string | null;
  dismissActionFailed: () => void;
  channelAttention: ChannelStatusInfo | null;
  dismissChannelAttention: () => void;
}

export function useGameSession(
  params: GameSessionParams,
  uniqueId: string,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => void,
  appendGameLog: (line: string) => void,
  sessionSave?: SessionSave,
  blockchainType?: BlockchainType,
): UseGameSessionResult {
  const { iStarted, amount, perGameAmount } = params;
  const playerNumber = iStarted ? 1 : 2;

  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>(() =>
      sessionSave?.channelReady
        ? { stateIdentifier: 'running' as const, stateDetail: [] }
        : { stateIdentifier: 'starting' as const, stateDetail: ['before handshake'] }
    );
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [myRunningBalance, setMyRunningBalance] = useState(0n);
  const [goOnChainPressed, setGoOnChainPressed] = useState(false);
  const [channelStatus, setChannelStatus] = useState<ChannelStatusInfo>(() =>
    sessionSave?.channelReady ? { ...INITIAL_CHANNEL_STATUS, state: 'Active' } : INITIAL_CHANNEL_STATUS
  );
  const [channelAttention, setChannelAttention] = useState<ChannelStatusInfo | null>(null);
  const [gameCoin, setGameCoin] = useState<GameCoinInfo>({ coinHex: null, turnState: 'my-turn' });
  const [gameTerminal, setGameTerminal] = useState<GameTerminalInfo>(INITIAL_GAME_TERMINAL);
  const [handKey, setHandKey] = useState(() => sessionSave?.activeGameId ? 1 : 0);
  const [gameIds, setGameIds] = useState<string[]>(() =>
    sessionSave?.activeGameId ? [sessionSave.activeGameId] : []
  );
  const [showBetweenHandOverlay, setShowBetweenHandOverlay] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [actionFailedReason, setActionFailedReason] = useState<string | null>(null);

  const gameIdsRef = useRef<string[]>(sessionSave?.activeGameId ? [sessionSave.activeGameId] : []);
  const pendingProposalIdRef = useRef<string | null>(null);
  const wantsNewGameRef = useRef<boolean>(false);
  const firstGameAcceptedRef = useRef<boolean>(!!sessionSave?.channelReady);
  const awaitingDisplayCompleteRef = useRef<boolean>(false);
  const gameplayEventSubject = useRef(new Subject<GameplayEvent>()).current;

  gameIdsRef.current = gameIds;

  const setError = useCallback((e: string | undefined) => {
    if (e !== undefined) {
      setRealError((prev) => prev === undefined ? e : prev);
    }
  }, []);

  const dismissActionFailed = useCallback(() => setActionFailedReason(null), []);

  const blockchain = new ChildFrameBlockchainInterface();

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
    blockchainType,
  );

  if (params.myAlias) gameObject.myAlias = params.myAlias;
  if (params.opponentAlias) gameObject.opponentAlias = params.opponentAlias;

  const gameObjectRef = useRef<WasmBlobWrapper>(gameObject);
  gameObjectRef.current = gameObject;

  const proposeNewGame = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    try {
      go.proposeGame({
        game_type: '63616c706f6b6572',
        timeout: 15,
        amount: perGameAmount,
        my_contribution: perGameAmount / 2n,
        my_turn: !iStarted,
        parameters: null,
      });
    } catch (_) {
      // proposal can fail if channel isn't ready yet; user can retry
    }
  }, [iStarted, perGameAmount]);

  const onHandOutcome = useCallback((outcome: CalpokerOutcome) => {
    setLastOutcome(outcome);
    setGameIds(prev => prev.slice(1));
    gameIdsRef.current = gameIdsRef.current.slice(1);
    setGameCoin({ coinHex: null, turnState: 'my-turn' });
    const delta = outcome.my_win_outcome === 'win' ? perGameAmount / 2n
                : outcome.my_win_outcome === 'lose' ? -(perGameAmount / 2n)
                : 0n;
    setMyRunningBalance(prev => prev + delta);
    awaitingDisplayCompleteRef.current = true;
  }, [perGameAmount]);

  const onTurnChanged = useCallback((isMyTurn: boolean) => {
    setGameCoin(prev => ({
      coinHex: prev.coinHex,
      turnState: isMyTurn ? 'my-turn' : 'their-turn',
    }));
  }, []);

  const onDisplayComplete = useCallback(() => {
    if (!awaitingDisplayCompleteRef.current) {
      console.error('[session] onDisplayComplete called but no hand outcome is pending');
      return;
    }
    awaitingDisplayCompleteRef.current = false;
    setShowBetweenHandOverlay(true);
  }, []);

  const dismissChannelAttention = useCallback(() => {
    setChannelAttention(null);
  }, []);

  const handleNotification = useCallback((n: WasmNotification) => {
    const go = gameObjectRef.current;
    if (typeof n !== 'object' || n === null) return;

    // ChannelStatus: persistent display, no toast
    if ('ChannelStatus' in n) {
      const cs = n.ChannelStatus as ChannelStatusPayload | undefined;
      if (!cs) return;
      const info: ChannelStatusInfo = {
        state: cs.state,
        advisory: cs.advisory ?? null,
        coinHex: coinPayloadToHex(cs.coin) ?? null,
        ourBalance: parseAmount(cs.our_balance),
        theirBalance: parseAmount(cs.their_balance),
        gameAllocated: parseAmount(cs.game_allocated),
      };
      setChannelStatus(info);
      if (ATTENTION_STATES.includes(cs.state)) {
        setShowBetweenHandOverlay(false);
        setChannelAttention(info);
      }
      if (cs.state === 'Active' && gameConnectionState.stateIdentifier !== 'running') {
        setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
        if (iStarted && !firstGameAcceptedRef.current) {
          proposeNewGame();
        }
      }
      return;
    }

    // Game coin lifecycle
    if ('GameOnChain' in n) {
      const hex = coinPayloadToHex(n.GameOnChain?.coin);
      const ourTurn = n.GameOnChain?.our_turn;
      setGameCoin({
        coinHex: hex ?? null,
        turnState: ourTurn === false ? 'their-turn' : 'my-turn',
      });
    }

    // Session lifecycle and game flow
    if ('GameProposed' in n) {
      if (!iStarted) {
        const proposalId = String(n.GameProposed!.id);
        if (!firstGameAcceptedRef.current || wantsNewGameRef.current) {
          wantsNewGameRef.current = false;
          try {
            go?.acceptProposal(proposalId);
          } catch (e) {
            console.error('acceptProposal failed:', e);
          }
        } else {
          pendingProposalIdRef.current = proposalId;
        }
      }
    } else if ('GameProposalAccepted' in n) {
      firstGameAcceptedRef.current = true;
      const gpa = n.GameProposalAccepted!;
      const newId = String(gpa.id);
      setGameIds(prev => [...prev, newId]);
      gameIdsRef.current = [...gameIdsRef.current, newId];
      setShowBetweenHandOverlay(false);
      setHandKey(prev => prev + 1);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      setGameCoin({ coinHex: null, turnState: iStarted ? 'their-turn' : 'my-turn' });
      setGameTerminal(INITIAL_GAME_TERMINAL);
      gameplayEventSubject.next({ GameProposalAccepted: { id: gpa.id as number | string } });
    } else if ('WeMoved' in n) {
      const hex = coinPayloadToHex(n.WeMoved?.coin);
      setGameCoin({
        coinHex: hex ?? null,
        turnState: 'their-turn',
      });
    } else if ('OpponentMoved' in n) {
      gameplayEventSubject.next({ OpponentMoved: { readable: n.OpponentMoved!.readable as number[] } });
    } else if ('GameMessage' in n) {
      gameplayEventSubject.next({ GameMessage: { readable: n.GameMessage!.readable as number[] } });
    } else if (isTerminal(n)) {
      const terminalInfo = parseTerminalInfo(n);
      setGameTerminal(terminalInfo);
      setGameCoin(prev => ({ ...prev, turnState: 'ended' }));
      const hadActiveGame = gameIdsRef.current.length > 0;
      if (hadActiveGame) {
        setGameIds(prev => prev.slice(1));
        gameIdsRef.current = gameIdsRef.current.slice(1);
        setShowBetweenHandOverlay(true);
      }
      gameplayEventSubject.next({ _terminal: true, notification: n });
    } else if ('ActionFailed' in n) {
      const reason = String(n.ActionFailed?.reason ?? 'Unknown error');
      setActionFailedReason(reason);
    }
  }, [iStarted, proposeNewGame, gameplayEventSubject, gameConnectionState.stateIdentifier]);

  // Subscribe to WASM events
  useEffect(() => {
    const subscription = gameObject.getObservable().subscribe({
      next: (evt: WasmEvent) => {
        switch (evt.type) {
          case 'notification':
            handleNotification(evt.data);
            break;
          case 'error':
            setError(evt.error);
            break;
          case 'address':
            break;
          case 'debug_log':
            debugLog(evt.message);
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
  }, [gameObject, handleNotification, setError]);

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
  }, [gameObject]);

  const playAgain = useCallback(() => {
    if (iStarted) {
      proposeNewGame();
    } else {
      const pending = pendingProposalIdRef.current;
      if (pending) {
        pendingProposalIdRef.current = null;
        try {
          gameObjectRef.current?.acceptProposal(pending);
        } catch (e) {
          console.error('acceptProposal failed:', e);
        }
      } else {
        wantsNewGameRef.current = true;
      }
    }
  }, [iStarted, proposeNewGame]);

  const stopPlaying = useCallback(() => {
    gameObject?.cleanShutdown();
  }, [gameObject]);

  const goOnChain = useCallback(() => {
    debugLog('[game] going on chain');
    setGoOnChainPressed(true);
    gameObject?.goOnChain();
  }, [gameObject]);

  return {
    error,
    gameConnectionState,
    amount,
    perGameAmount,
    myRunningBalance,
    iStarted,
    playerNumber,
    channelStatus,
    gameCoin,
    gameTerminal,
    handKey,
    activeGameId: gameIds[0] ?? null,
    gameObject,
    gameplayEvent$: gameplayEventSubject.asObservable(),
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    onDisplayComplete,
    playAgain,
    stopPlaying,
    goOnChain,
    showBetweenHandOverlay,
    lastOutcome,
    goOnChainPressed,
    actionFailedReason,
    dismissActionFailed,
    channelAttention,
    dismissChannelAttention,
  };
}
