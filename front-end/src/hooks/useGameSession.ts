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
import { SessionSave, getDefaultFee } from './save';
import { toHexString } from '../util';
import { debugLog } from '../services/debugLog';

export type GameplayEvent =
  | { ProposalAccepted: { id: number | string } }
  | { OpponentMoved: { readable: number[] } }
  | { GameMessage: { readable: number[] } }
  | { _terminal: true; notification: WasmNotification };

interface ParsedCoinPayload {
  hex: string;
  amount: string | null;
}

function parseCoinPayload(coin: unknown): ParsedCoinPayload | null {
  if (!Array.isArray(coin) || coin.length === 0 || !coin.every((b): b is number => typeof b === 'number')) {
    return null;
  }
  let amount: string | null = null;
  if (coin.length >= 64) {
    let value = 0n;
    for (let i = 64; i < coin.length; i++) {
      value = (value << 8n) + BigInt(coin[i] & 0xff);
    }
    amount = value.toString();
  }
  return {
    hex: toHexString(coin),
    amount,
  };
}

function coinPayloadToHex(coin: unknown): string | undefined {
  return parseCoinPayload(coin)?.hex;
}

export type GameTurnState = 'my-turn' | 'their-turn' | 'replaying' | 'opponent-illegal-move' | 'ended';

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

export interface ChannelStatusInfo {
  state: ChannelState;
  advisory: string | null;
  coinHex: string | null;
  coinAmount: string | null;
  ourBalance: string | null;
  theirBalance: string | null;
  gameAllocated: string | null;
}

const INITIAL_CHANNEL_STATUS: ChannelStatusInfo = {
  state: 'Handshaking',
  advisory: null,
  coinHex: null,
  coinAmount: null,
  ourBalance: null,
  theirBalance: null,
  gameAllocated: null,
};

function channelStatusFromPayload(cs: ChannelStatusPayload): ChannelStatusInfo {
  const parsedCoin = parseCoinPayload(cs.coin);
  const isResolvedFromUnroll = cs.state === 'ResolvedUnrolled' || cs.state === 'ResolvedStale';
  const resolvedShare = isResolvedFromUnroll
    ? (parsedCoin?.amount ?? '0')
    : parseAmount(cs.our_balance);
  return {
    state: cs.state,
    advisory: cs.advisory ?? null,
    coinHex: parsedCoin?.hex ?? null,
    coinAmount: parsedCoin?.amount ?? null,
    ourBalance: resolvedShare,
    theirBalance: parseAmount(cs.their_balance),
    gameAllocated: parseAmount(cs.game_allocated),
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

function parseGameStatusTerminalInfo(gs: GameStatusPayload): GameTerminalInfo {
  if (gs.status === 'ended-we-timed-out') {
    return {
      type: 'we-timed-out',
      label: 'Ended: we timed out',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex: coinPayloadToHex(gs.coin_id) ?? null,
    };
  }

  if (gs.status === 'ended-opponent-timed-out') {
    return {
      type: 'opponent-timed-out',
      label: 'Ended: opponent timed out',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex: coinPayloadToHex(gs.coin_id) ?? null,
    };
  }

  if (gs.status === 'ended-we-slashed-opponent') {
    return {
      type: 'we-slashed-opponent',
      label: 'Ended: we slashed opponent',
      myReward: parseAmount(gs.my_reward),
      rewardCoinHex: coinPayloadToHex(gs.coin_id) ?? null,
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
      rewardCoinHex: coinPayloadToHex(gs.coin_id) ?? null,
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
  cutPeerConnection: () => void;
  txPublishNerfed: boolean;
  toggleTxPublishNerf: () => void;
  showBetweenHandOverlay: boolean;
  lastOutcome: CalpokerOutcome | undefined;
  restoredOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  goOnChainPressed: boolean;
  gameTerminalAttention: GameTerminalAttentionInfo | null;
  dismissGameTerminalAttention: () => void;
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
  const [myRunningBalance, setMyRunningBalance] = useState(() =>
    sessionSave?.myRunningBalance ? BigInt(sessionSave.myRunningBalance) : 0n
  );
  const [goOnChainPressed, setGoOnChainPressed] = useState(false);
  const [txPublishNerfed, setTxPublishNerfed] = useState(false);
  const [channelStatus, setChannelStatus] = useState<ChannelStatusInfo>(() => {
    if (!sessionSave?.channelReady) return INITIAL_CHANNEL_STATUS;
    if (sessionSave.channelStatus) return channelStatusFromPayload(sessionSave.channelStatus);
    return { ...INITIAL_CHANNEL_STATUS, state: 'Active' };
  });
  const [channelAttention, setChannelAttention] = useState<ChannelStatusInfo | null>(() => {
    if (sessionSave?.channelAttentionActive && sessionSave.channelStatus) {
      return channelStatusFromPayload(sessionSave.channelStatus);
    }
    return null;
  });
  const channelStateRef = useRef<ChannelState>(
    sessionSave?.channelReady
      ? (sessionSave.channelStatus?.state ?? 'Active')
      : INITIAL_CHANNEL_STATUS.state
  );
  const channelAttentionStateRef = useRef<ChannelState | null>(
    sessionSave?.channelStatus && ATTENTION_STATES.includes(sessionSave.channelStatus.state)
      ? sessionSave.channelStatus.state
      : null
  );
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
  const [showBetweenHandOverlay, setShowBetweenHandOverlay] = useState(
    () => sessionSave?.showBetweenHandOverlay ?? false
  );
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const restoredOutcomeWin = sessionSave?.lastOutcomeWin;
  const [gameTerminalAttention, setGameTerminalAttention] = useState<GameTerminalAttentionInfo | null>(() => {
    if (sessionSave?.gameTerminalAttentionActive && sessionSave.gameTerminalLabel) {
      return {
        label: sessionSave.gameTerminalLabel,
        myReward: sessionSave.gameTerminalReward ?? null,
        rewardCoinHex: sessionSave.gameTerminalRewardCoin ?? null,
      };
    }
    return null;
  });

  const lastOutcomeRef = useRef<CalpokerOutcome | undefined>(undefined);
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

  const gameObjectRef = useRef<WasmBlobWrapper>(gameObject);
  gameObjectRef.current = gameObject;

  useEffect(() => {
    const go = gameObjectRef.current;
    if (!go) return;
    go.gameCoinHex = gameCoin.coinHex;
    go.gameTurnState = gameCoin.turnState;
    go.gameTerminalType = gameTerminal.type;
    go.gameTerminalLabel = gameTerminal.label;
    go.gameTerminalReward = gameTerminal.myReward;
    go.gameTerminalRewardCoin = gameTerminal.rewardCoinHex;
    go.myRunningBalance = myRunningBalance.toString();
    go.scheduleSave();
  }, [gameCoin, gameTerminal, myRunningBalance]);

  const proposeNewGame = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    try {
      // perGameAmount is per-player stake; game coin amount is both players combined.
      go.proposeGame({
        game_type: '63616c706f6b6572',
        timeout: 15,
        amount: perGameAmount * 2n,
        my_contribution: perGameAmount,
        my_turn: !iStarted,
        parameters: null,
      });
    } catch (_) {
      // proposal can fail if channel isn't ready yet; user can retry
    }
  }, [iStarted, perGameAmount]);

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
    const go = gameObjectRef.current;
    const win = lastOutcomeRef.current?.my_win_outcome;
    go?.setBetweenHandOverlay(true, win);
  }, []);

  const dismissChannelAttention = useCallback(() => {
    setChannelAttention(null);
    const go = gameObjectRef.current;
    if (go) { go.channelAttentionActive = false; go.scheduleSave(); }
  }, []);

  const dismissGameTerminalAttention = useCallback(() => {
    setGameTerminalAttention(null);
    const go = gameObjectRef.current;
    if (go) { go.gameTerminalAttentionActive = false; go.scheduleSave(); }
  }, []);

  const handleNotification = useCallback((n: WasmNotification) => {
    const go = gameObjectRef.current;
    if (typeof n !== 'object' || n === null) return;

    // ChannelStatus: persistent display, no toast
    if ('ChannelStatus' in n) {
      const cs = n.ChannelStatus as ChannelStatusPayload | undefined;
      if (!cs) return;
      const info = channelStatusFromPayload(cs);
      channelStateRef.current = info.state;
      setChannelStatus(info);
      if (ATTENTION_STATES.includes(cs.state)) {
        setShowBetweenHandOverlay(false);
        const go = gameObjectRef.current;
        if (go && (go.channelAttentionActive || cs.state !== channelAttentionStateRef.current)) {
          go.channelAttentionActive = true;
          channelAttentionStateRef.current = cs.state;
          setChannelAttention(info);
        }
      }
      if (cs.state === 'Active' && gameConnectionState.stateIdentifier !== 'running') {
        setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
        if (iStarted && !firstGameAcceptedRef.current) {
          proposeNewGame();
        }
      }
      return;
    }

    // Session lifecycle and game flow
    if ('ProposalMade' in n) {
      if (!iStarted) {
        const proposalId = String(n.ProposalMade!.id);
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
    } else if ('ProposalAccepted' in n) {
      firstGameAcceptedRef.current = true;
      const gpa = n.ProposalAccepted!;
      const newId = String(gpa.id);
      setGameIds(prev => [...prev, newId]);
      gameIdsRef.current = [...gameIdsRef.current, newId];
      setShowBetweenHandOverlay(false);
      go?.setBetweenHandOverlay(false);
      go?.setHandState(null);
      setHandKey(prev => prev + 1);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      setGameCoin({ coinHex: null, turnState: iStarted ? 'their-turn' : 'my-turn' });
      setGameTerminal(INITIAL_GAME_TERMINAL);
      gameplayEventSubject.next({ ProposalAccepted: { id: gpa.id as number | string } });
    } else if ('GameStatus' in n) {
      const gs = n.GameStatus as GameStatusPayload | undefined;
      if (!gs) return;
      const gid = String(gs.id);
      const status = gs.status;
      const coinHex = coinPayloadToHex(gs.coin_id) ?? null;
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

        const terminalInfo = parseGameStatusTerminalInfo(gs);
        setGameTerminal(terminalInfo);
        setGameCoin(prev => ({ ...prev, turnState: 'ended' }));
        // On-chain terminal paths have their own dedicated dialogs/UX.
        // For normal off-chain hand completion we still want the between-hand overlay.
        if (inOnChainFlow) {
          setShowBetweenHandOverlay(false);
        }
        const hadActiveGame = gameIdsRef.current.length > 0;
        if (hadActiveGame) {
          setGameIds(prev => prev.slice(1));
          gameIdsRef.current = gameIdsRef.current.slice(1);
          if (inOnChainFlow) {
            const go2 = gameObjectRef.current;
            if (go2) { go2.gameTerminalAttentionActive = true; }
            setGameTerminalAttention({
              label: terminalInfo.label ?? `Ended: ${status}`,
              myReward: terminalInfo.myReward,
              rewardCoinHex: terminalInfo.rewardCoinHex,
            });
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
      setGameTerminal({
        type: 'insufficient-balance',
        label: 'Ended: insufficient balance',
        myReward: null,
        rewardCoinHex: null,
      });
      setGameCoin(prev => ({ ...prev, turnState: 'ended' }));
      gameplayEventSubject.next({ _terminal: true, notification: n });
    } else if ('ActionFailed' in n) {
      const reason = String(n.ActionFailed?.reason ?? 'Unknown error');
      debugLog(`[game] action failed: ${reason}`);
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

  const cutPeerConnection = useCallback(() => {
    debugLog('[game] cutting peer connection');
    gameObject?.cutPeerConnection();
  }, [gameObject]);

  const toggleTxPublishNerf = useCallback(() => {
    const next = !txPublishNerfed;
    gameObject?.setTransactionPublishNerfed(next);
    setTxPublishNerfed(next);
  }, [gameObject, txPublishNerfed]);

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
    cutPeerConnection,
    txPublishNerfed,
    toggleTxPublishNerf,
    showBetweenHandOverlay,
    lastOutcome,
    restoredOutcomeWin,
    goOnChainPressed,
    gameTerminalAttention,
    dismissGameTerminalAttention,
    channelAttention,
    dismissChannelAttention,
  };
}
