import { useState, useEffect, useCallback, useRef } from 'react';
import { Subject, Observable } from 'rxjs';
import { toast } from 'sonner';
import { storeInitArgs } from './WasmStateInit';
import {
  GameConnectionState,
  GameSessionParams,
  CalpokerOutcome,
  BlockchainReport,
  WasmEvent,
  WasmNotification,
  WasmNotificationTag,
  WasmInitFn,
  WasmConnection,
} from '../types/ChiaGaming';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import {
  getBlobSingleton,
  initStarted,
  setInitStarted,
} from './blobSingleton';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { toHexString } from '../util';

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
  'GameCancelled', 'GameError', 'ChannelError',
];

function isTerminal(n: WasmNotification): boolean {
  return TERMINAL_TYPES.some(t => t in n);
}

export type ChannelCoinState = 'not-created' | 'channel' | 'unrolling' | 'reward' | 'closed';
export type GameCoinState = 'off-chain-my-turn' | 'off-chain-their-turn' | 'on-chain-my-turn' | 'on-chain-their-turn' | 'reward' | 'ended';

export interface CoinLifecycle<S> {
  coinHex: string | null;
  state: S;
}

export interface UseGameSessionResult {
  error: string | undefined;
  gameConnectionState: GameConnectionState;
  amount: bigint;
  perGameAmount: bigint;
  myRunningBalance: bigint;
  iStarted: boolean;
  playerNumber: number;
  sessionEnded: boolean;
  channelCoin: CoinLifecycle<ChannelCoinState>;
  gameCoin: CoinLifecycle<GameCoinState>;
  handKey: number;
  activeGameId: string | null;
  gameObject: WasmBlobWrapper;
  gameplayEvent$: Observable<GameplayEvent>;
  gameLog: string[];
  debugLog: string[];
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  onDisplayComplete: () => void;
  playAgain: () => void;
  stopPlaying: () => void;
  goOnChain: () => void;
  showBetweenHandOverlay: boolean;
  lastOutcome: CalpokerOutcome | undefined;
  shutdownInitiated: boolean;
}

export function useGameSession(params: GameSessionParams, uniqueId: string): UseGameSessionResult {
  const { iStarted, amount, perGameAmount, token, lobbyUrl } = params;
  const playerNumber = iStarted ? 1 : 2;

  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>({ stateIdentifier: 'starting', stateDetail: ['before handshake'] });
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [myRunningBalance, setMyRunningBalance] = useState(0n);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [shutdownInitiated, setShutdownInitiated] = useState(false);
  const [channelCoin, setChannelCoin] = useState<CoinLifecycle<ChannelCoinState>>({ coinHex: null, state: 'not-created' });
  const [gameCoin, setGameCoin] = useState<CoinLifecycle<GameCoinState>>({ coinHex: null, state: 'off-chain-my-turn' });
  const [handKey, setHandKey] = useState(0);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [showBetweenHandOverlay, setShowBetweenHandOverlay] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const gameIdsRef = useRef<string[]>([]);
  const pendingProposalIdRef = useRef<string | null>(null);
  const wantsNewGameRef = useRef<boolean>(false);
  const firstGameAcceptedRef = useRef<boolean>(false);
  const awaitingDisplayCompleteRef = useRef<boolean>(false);
  const gameplayEventSubject = useRef(new Subject<GameplayEvent>()).current;

  gameIdsRef.current = gameIds;

  const setError = useCallback((e: string | undefined) => {
    if (e !== undefined) {
      setRealError((prev) => prev === undefined ? e : prev);
    }
  }, []);

  const appendGameLog = useCallback((line: string) => {
    setGameLog(prev => [...prev, line]);
  }, []);

  const appendDebugLog = useCallback((line: string) => {
    setDebugLog(prev => [...prev, line]);
  }, []);

  const blockchain = new ChildFrameBlockchainInterface();

  const { gameObject } = getBlobSingleton(
    blockchain,
    { token, iStarted },
    lobbyUrl,
    uniqueId,
    amount,
    iStarted,
  );

  const gameObjectRef = useRef<WasmBlobWrapper>(gameObject);
  gameObjectRef.current = gameObject;

  const proposeNewGame = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    try {
      go.proposeGame({
        game_type: '63616c706f6b6572',
        timeout: 100,
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
    setGameCoin({ coinHex: null, state: 'off-chain-my-turn' });
    const delta = outcome.my_win_outcome === 'win' ? perGameAmount / 2n
                : outcome.my_win_outcome === 'lose' ? -(perGameAmount / 2n)
                : 0n;
    setMyRunningBalance(prev => prev + delta);
    awaitingDisplayCompleteRef.current = true;
  }, [perGameAmount]);

  const onTurnChanged = useCallback((isMyTurn: boolean) => {
    setGameCoin(prev => {
      if (prev.state === 'on-chain-my-turn' || prev.state === 'on-chain-their-turn') {
        return { coinHex: prev.coinHex, state: isMyTurn ? 'on-chain-my-turn' : 'on-chain-their-turn' };
      }
      return { coinHex: null, state: isMyTurn ? 'off-chain-my-turn' : 'off-chain-their-turn' };
    });
  }, []);

  const onDisplayComplete = useCallback(() => {
    if (!awaitingDisplayCompleteRef.current) {
      console.error('[session] onDisplayComplete called but no hand outcome is pending');
      return;
    }
    awaitingDisplayCompleteRef.current = false;
    setShowBetweenHandOverlay(true);
  }, []);

  const handleNotification = useCallback((n: WasmNotification) => {
    const go = gameObjectRef.current;
    if (typeof n !== 'object' || n === null) return;

    const type = Object.keys(n)[0] as WasmNotificationTag;
    const p = n[type] ?? {};
    const s = (key: string): string | undefined => {
      const v = p[key];
      return v != null ? String(v) : undefined;
    };
    const CHANNEL_TOAST_ID = 'channel-notification';
    const GAME_TOAST_ID = 'game-notification';

    type ToastCfg = { title: string; description?: string; variant?: 'default' | 'destructive'; toastId: string };
    const channelToasts: Record<string, Omit<ToastCfg, 'toastId'>> = {
      GoingOnChain:                { variant: 'default',     title: 'Going On-Chain',              description: s('reason') ?? 'Dispute detected — submitting to blockchain' },
      ChannelCoinSpent:            { variant: 'default',     title: 'Channel Coin Spent',           description: 'The state channel coin was spent on-chain' },
      UnrollCoinSpent:             { variant: 'default',     title: 'Unroll Coin Spent',            description: p.reward_coin ? 'Unroll resolved — reward coin received' : 'The unroll coin was spent on-chain' },
      StaleChannelUnroll:          { variant: 'destructive', title: 'Stale Channel Unrolled',       description: p.our_reward !== undefined ? `You received ${p.our_reward} mojos` : 'Opponent\'s stale unroll resolved on-chain' },
      ChannelError:                { variant: 'destructive', title: 'Channel Error',                description: s('reason') },
      CleanShutdownStarted:        { variant: 'default',     title: 'Session Ending',               description: 'Opponent initiated a clean shutdown' },
      CleanShutdownComplete:       { variant: 'default',     title: 'Session Ended',                description: 'Channel closed — funds returned on-chain' },
    };
    const gameToasts: Record<string, Omit<ToastCfg, 'toastId'>> = {
      OpponentPlayedIllegalMove:   { variant: 'default',     title: 'Illegal Move Detected',       description: `Game #${s('id')} — slashing opponent on-chain…` },
      WeSlashedOpponent:           { variant: 'default',     title: 'Opponent Slashed!',            description: `Game #${s('id')} — successfully claimed all game funds` },
      OpponentSlashedUs:           { variant: 'destructive', title: 'You Were Slashed',             description: `Game #${s('id')} — your illegal move was proven on-chain` },
      OpponentSuccessfullyCheated: { variant: 'destructive', title: 'Opponent Got Away',            description: p.our_reward !== undefined ? `Game #${s('id')} — slash window expired, you received ${p.our_reward} mojos` : `Game #${s('id')} — slash window expired` },
      WeTimedOut:                  { variant: 'destructive', title: 'You Timed Out',                description: p.our_reward !== undefined ? `Game #${s('id')} — you received ${p.our_reward} mojos` : `Game #${s('id')}` },
      OpponentTimedOut:            { variant: 'default',     title: 'Opponent Timed Out',           description: p.our_reward !== undefined ? `Game #${s('id')} — you received ${p.our_reward} mojos` : `Game #${s('id')}` },
      GameCancelled:               { variant: 'default',     title: 'Game Cancelled',               description: `Game #${s('id')} was cancelled` },
      GameProposalCancelled:       { variant: 'destructive', title: 'Game Proposal Cancelled',      description: s('reason') ? `Game #${s('id')} — ${s('reason')}` : `Game #${s('id')}` },
      InsufficientBalance:         { variant: 'destructive', title: 'Insufficient Balance',         description: p.our_balance_short && p.their_balance_short ? 'Both sides have insufficient balance' : p.our_balance_short ? 'Your balance is too low for this game' : 'Opponent\'s balance is too low for this game' },
      GameError:                   { variant: 'destructive', title: 'Game Error',                   description: s('reason') ? `Game #${s('id')} — ${s('reason')}` : `Game #${s('id')}` },
      GameOnChain:                 { variant: 'default',     title: 'Game On-Chain',                description: p.coin ? `Game #${s('id')} — coin on-chain` : `Game #${s('id')}` },
    };
    const tChannel = channelToasts[type];
    const tGame = gameToasts[type];
    const t = tChannel ?? tGame;
    if (t) {
      const activeGameId = gameIdsRef.current[0];
      const notificationGameId = p.id != null ? String(p.id) : null;
      if (tGame && notificationGameId != null && activeGameId != null && notificationGameId !== activeGameId) {
        toast.error(`Unexpected game notification for #${notificationGameId}`, { id: CHANNEL_TOAST_ID });
      } else {
        const toastId = tChannel ? CHANNEL_TOAST_ID : GAME_TOAST_ID;
        const opts = { ...(t.description ? { description: t.description } : {}), id: toastId };
        if (t.variant === 'destructive') {
          toast.error(t.title, opts);
        } else {
          toast(t.title, opts);
        }
      }
    }

    // Channel coin lifecycle
    if ('ChannelCreated' in n) {
      const hex = coinPayloadToHex(n.ChannelCreated?.channel_coin);
      setChannelCoin({ coinHex: hex ?? null, state: 'channel' });
    } else if ('ChannelCoinSpent' in n) {
      const hex = coinPayloadToHex(n.ChannelCoinSpent?.unroll_coin);
      setChannelCoin({ coinHex: hex ?? null, state: 'unrolling' });
    } else if ('UnrollCoinSpent' in n) {
      const hex = coinPayloadToHex(n.UnrollCoinSpent?.reward_coin);
      setChannelCoin({ coinHex: hex ?? null, state: 'reward' });
    }

    // Game coin lifecycle
    if ('GameOnChain' in n) {
      const hex = coinPayloadToHex(n.GameOnChain?.coin);
      const ourTurn = n.GameOnChain?.our_turn;
      setGameCoin({
        coinHex: hex ?? null,
        state: ourTurn === true ? 'on-chain-my-turn' : ourTurn === false ? 'on-chain-their-turn' : 'on-chain-my-turn',
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
      setGameCoin({ coinHex: null, state: iStarted ? 'off-chain-their-turn' : 'off-chain-my-turn' });
      gameplayEventSubject.next({ GameProposalAccepted: { id: gpa.id as number | string } });
    } else if ('OpponentMoved' in n) {
      gameplayEventSubject.next({ OpponentMoved: { readable: n.OpponentMoved!.readable as number[] } });
    } else if ('GameMessage' in n) {
      gameplayEventSubject.next({ GameMessage: { readable: n.GameMessage!.readable as number[] } });
    } else if ('CleanShutdownComplete' in n) {
      setSessionEnded(true);
      setChannelCoin(prev => ({ coinHex: prev.coinHex, state: 'closed' }));
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
    } else if ('ChannelCreated' in n) {
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      if (iStarted) {
        proposeNewGame();
      }
    } else if ('CleanShutdownStarted' in n) {
      setShutdownInitiated(true);
    } else if ('GoingOnChain' in n) {
      setShutdownInitiated(true);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: ['On-chain dispute in progress'] });
    } else if (isTerminal(n)) {
      const hadActiveGame = gameIdsRef.current.length > 0;
      if (hadActiveGame) {
        setGameIds(prev => prev.slice(1));
        gameIdsRef.current = gameIdsRef.current.slice(1);
        setGameCoin({ coinHex: null, state: 'ended' });
        setShowBetweenHandOverlay(true);
        gameplayEventSubject.next({ _terminal: true, notification: n });
      }
    } else if (!('GameProposed' in n) && !('GameProposalAccepted' in n) && !('OpponentMoved' in n) && !('GameMessage' in n)) {
      console.warn('unhandled notification:', JSON.stringify(n));
    }
  }, [iStarted, proposeNewGame, gameplayEventSubject]);

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
          case 'finished':
            setSessionEnded(true);
            setChannelCoin(prev => ({ coinHex: prev.coinHex, state: 'closed' }));
            break;
          case 'address':
            break;
          case 'debug_log':
            appendDebugLog(evt.message);
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
  }, [gameObject, handleNotification, setError, appendDebugLog]);

  // Subscribe to blockchain block data
  useEffect(() => {
    const subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        if (e.block) {
          gameObject?.blockNotification(e.peak, e.block, e.report);
        }
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
    setShutdownInitiated(true);
    gameObject?.cleanShutdown();
  }, [gameObject]);

  const goOnChain = useCallback(() => {
    setShutdownInitiated(true);
    gameObject?.goOnChain();
  }, [gameObject]);

  window.loadWasm = useCallback((chia_gaming_init: WasmInitFn, cg: WasmConnection) => {
    storeInitArgs(chia_gaming_init, cg);
  }, []);

  return {
    error,
    gameConnectionState,
    amount,
    perGameAmount,
    myRunningBalance,
    iStarted,
    playerNumber,
    sessionEnded,
    channelCoin,
    gameCoin,
    handKey,
    activeGameId: gameIds[0] ?? null,
    gameObject,
    gameplayEvent$: gameplayEventSubject.asObservable(),
    gameLog,
    debugLog,
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    onDisplayComplete,
    playAgain,
    stopPlaying,
    goOnChain,
    showBetweenHandOverlay,
    lastOutcome,
    shutdownInitiated,
  };
}
