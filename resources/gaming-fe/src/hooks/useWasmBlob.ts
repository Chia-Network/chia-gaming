import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { toast } from './use-toast';
import {
  storeInitArgs,
} from './WasmStateInit';
import {
  GameConnectionState,
  CalpokerOutcome,
  BlockchainInboundAddressResult,
  BlockchainReport,
  OutcomeLogLine,
  handValueToDescription,
  WasmEvent,
} from '../types/ChiaGaming';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';
import {
  getBlobSingleton,
  initStarted,
  setInitStarted,
} from './blobSingleton';
import { WasmBlobWrapper } from './WasmBlobWrapper';

const TERMINAL_TYPES = [
  'WeTimedOut', 'OpponentTimedOut', 'WeSlashedOpponent',
  'OpponentSlashedUs', 'OpponentSuccessfullyCheated',
  'GameCancelled', 'GameError', 'ChannelError',
];

function isTerminal(n: any): boolean {
  return TERMINAL_TYPES.some(t => t in n);
}

function parseCards(readableBytes: number[], iStarted: boolean): { playerHand: number[], opponentHand: number[] } {
  const program = Program.deserialize(Uint8Array.from(readableBytes));
  const card_lists = program.toList().map(l => l.toList().map(v => v.toInt()));
  if (iStarted) {
    return { playerHand: card_lists[1], opponentHand: card_lists[0] };
  } else {
    return { playerHand: card_lists[0], opponentHand: card_lists[1] };
  }
}

function selectedCardsToBitfield(selectedCards: number[], hand: number[]): number {
  let bitfield = 0;
  hand.forEach((cardId, index) => {
    if (selectedCards.includes(cardId)) {
      bitfield |= 1 << index;
    }
  });
  return bitfield;
}

export interface UseWasmBlobResult {
  error: any;
  log: OutcomeLogLine[];
  amount: number;
  addressData: BlockchainInboundAddressResult | undefined;
  ourShare: number | undefined;
  theirShare: number | undefined;
  gameConnectionState: GameConnectionState;
  isPlayerTurn: boolean;
  iStarted: boolean;
  moveNumber: number;
  handleMakeMove: () => void;
  handleCheat: () => void;
  playerHand: number[];
  opponentHand: number[];
  playerNumber: number;
  cardSelections: number[];
  setCardSelections: (s: number[] | ((prev: number[]) => number[])) => void;
  outcome: CalpokerOutcome | undefined;
  lastOutcome: CalpokerOutcome | undefined;
  stopPlaying: () => void;
}

export function useWasmBlob(searchParams: any, lobbyUrl: string, uniqueId: string): UseWasmBlobResult {
  const [ourShare, setOurShare] = useState<number | undefined>(undefined);
  const [theirShare, setTheirShare] = useState<number | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] =
    useState<GameConnectionState>({
      stateIdentifier: 'starting',
      stateDetail: ['before handshake'],
    });

  const iStarted = searchParams.iStarted !== 'false';
  const playerNumber = iStarted ? 1 : 2;
  const [log, setLog] = useState<OutcomeLogLine[]>([]);
  const [addressData, setAddressData] =
    useState<BlockchainInboundAddressResult | undefined>(undefined);
  const [playerHand, setPlayerHand] = useState<number[]>([]);
  const [opponentHand, setOpponentHand] = useState<number[]>([]);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [lastOutcome, setLastOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [cardSelections, setOurCardSelections] = useState<number[]>([]);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const amount = parseInt(searchParams.amount);

  const playerHandRef = useRef<number[]>([]);
  const opponentHandRef = useRef<number[]>([]);
  const cardSelectionsRef = useRef<number[]>([]);
  const moveNumberRef = useRef<number>(0);
  const gameIdsRef = useRef<string[]>([]);
  const gameOutcomeRef = useRef<CalpokerOutcome | undefined>(undefined);

  playerHandRef.current = playerHand;
  opponentHandRef.current = opponentHand;
  cardSelectionsRef.current = cardSelections;
  moveNumberRef.current = moveNumber;
  gameIdsRef.current = gameIds;

  const setError = (e: any) => {
    if (e !== undefined) {
      setRealError((prev) => prev === undefined ? e : prev);
    }
  };

  let perGameAmount = amount / 10;
  try {
    perGameAmount = parseInt(searchParams.perGame);
  } catch (e) {
    if (searchParams.perGame) {
      throw e;
    }
  }

  const blockchain = new ChildFrameBlockchainInterface();

  const { gameObject } = getBlobSingleton(
    blockchain,
    searchParams,
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
      const ids = go.proposeGame({
        game_type: '63616c706f6b6572',
        timeout: 100,
        amount: perGameAmount,
        my_contribution: perGameAmount / 2,
        my_turn: !iStarted,
        parameters: null,
      });
      console.log('[calpoker] proposed game, ids:', ids);
      setGameIds(prev => [...prev, ...ids]);
    } catch (e) {
      console.error('[calpoker] proposeGame failed:', e);
    }
  }, [iStarted, perGameAmount]);

  const recognizeOutcome = useCallback((newOutcome: CalpokerOutcome | undefined) => {
    setOutcome(newOutcome);
    gameOutcomeRef.current = newOutcome;
    if (newOutcome) {
      const iAmAlice = !iStarted;
      const mySelects = iAmAlice ? newOutcome.alice_selects : newOutcome.bob_selects;
      const theirSelects = iAmAlice ? newOutcome.bob_selects : newOutcome.alice_selects;
      const myFinalHand = iAmAlice ? newOutcome.alice_final_hand : newOutcome.bob_final_hand;
      const opponentFinalHand = iAmAlice ? newOutcome.bob_final_hand : newOutcome.alice_final_hand;
      const myCards = iAmAlice ? newOutcome.alice_used_cards : newOutcome.bob_used_cards;
      const myValue = iAmAlice ? newOutcome.alice_hand_value : newOutcome.bob_hand_value;
      const theirCards = iAmAlice ? newOutcome.bob_used_cards : newOutcome.alice_used_cards;
      const theirValue = iAmAlice ? newOutcome.bob_hand_value : newOutcome.alice_hand_value;
      const myHandDescription = handValueToDescription(myValue, myCards);
      const opponentHandDescription = handValueToDescription(theirValue, theirCards);
      const newLogObject: OutcomeLogLine = {
        topLineOutcome: newOutcome.my_win_outcome,
        myHandDescription,
        opponentHandDescription,
        myHand: myCards,
        opponentHand: theirCards,
        myStartHand: playerHandRef.current,
        opponentStartHand: opponentHandRef.current,
        myFinalHand,
        opponentFinalHand,
        mySelects,
        opponentSelects: theirSelects,
        myPicks: iAmAlice ? newOutcome.alice_discards : newOutcome.bob_discards,
        opponentPicks: iAmAlice ? newOutcome.bob_discards : newOutcome.alice_discards,
      };
      setLog(prev => [newLogObject, ...prev]);
    }
  }, [iStarted]);

  const handleNotification = useCallback((n: any) => {
    const go = gameObjectRef.current;
    if (typeof n !== 'object' || n === null) return;

    // Show toasts for notable game events
    const type = Object.keys(n)[0];
    const p = n[type]; // payload
    type ToastCfg = { title: string; description?: string; variant?: 'default' | 'destructive' };
    const toastMap: Record<string, ToastCfg> = {
      // --- Channel-level notifications ---
      GoingOnChain:                { variant: 'default',     title: 'Going On-Chain',              description: p?.reason ?? 'Dispute detected — submitting to blockchain' },
      ChannelCoinSpent:            { variant: 'default',     title: 'Channel Coin Spent',           description: 'The state channel coin was spent on-chain' },
      UnrollCoinSpent:             { variant: 'default',     title: 'Unroll Coin Spent',            description: p?.reward_coin ? 'Unroll resolved — reward coin received' : 'The unroll coin was spent on-chain' },
      StaleChannelUnroll:          { variant: 'destructive', title: 'Stale Channel Unrolled',       description: p?.our_reward !== undefined ? `You received ${p.our_reward} mojos` : 'Opponent\'s stale unroll resolved on-chain' },
      ChannelError:                { variant: 'destructive', title: 'Channel Error',                description: p?.reason },
      // --- Dispute / slash (game-scoped) ---
      OpponentPlayedIllegalMove:   { variant: 'default',     title: 'Illegal Move Detected',       description: `Game #${p?.id} — slashing opponent on-chain…` },
      WeSlashedOpponent:           { variant: 'default',     title: 'Opponent Slashed!',            description: `Game #${p?.id} — successfully claimed all game funds` },
      OpponentSlashedUs:           { variant: 'destructive', title: 'You Were Slashed',             description: `Game #${p?.id} — your illegal move was proven on-chain` },
      OpponentSuccessfullyCheated: { variant: 'destructive', title: 'Opponent Got Away',            description: p?.our_reward !== undefined ? `Game #${p?.id} — slash window expired, you received ${p.our_reward} mojos` : `Game #${p?.id} — slash window expired` },
      // --- Timeouts (game-scoped) ---
      WeTimedOut:                  { variant: 'destructive', title: 'You Timed Out',                description: p?.our_reward !== undefined ? `Game #${p?.id} — you received ${p.our_reward} mojos` : `Game #${p?.id}` },
      OpponentTimedOut:            { variant: 'default',     title: 'Opponent Timed Out',           description: p?.our_reward !== undefined ? `Game #${p?.id} — you received ${p.our_reward} mojos` : `Game #${p?.id}` },
      // --- Game lifecycle ---
      GameCancelled:               { variant: 'default',     title: 'Game Cancelled',               description: `Game #${p?.id} was cancelled` },
      GameProposalCancelled:       { variant: 'destructive', title: 'Game Proposal Cancelled',      description: p?.reason ? `Game #${p?.id} — ${p.reason}` : `Game #${p?.id}` },
      InsufficientBalance:         { variant: 'destructive', title: 'Insufficient Balance',         description: p?.our_balance_short && p?.their_balance_short ? 'Both sides have insufficient balance' : p?.our_balance_short ? 'Your balance is too low for this game' : 'Opponent\'s balance is too low for this game' },
      GameError:                   { variant: 'destructive', title: 'Game Error',                   description: p?.reason ? `Game #${p?.id} — ${p.reason}` : `Game #${p?.id}` },
      // --- Session lifecycle ---
      CleanShutdownStarted:        { variant: 'default',     title: 'Session Ending',               description: 'Opponent initiated a clean shutdown' },
      CleanShutdownComplete:       { variant: 'default',     title: 'Session Ended',                description: 'Channel closed — funds returned on-chain' },
    };
    if (type && toastMap[type]) {
      const t = toastMap[type];
      toast({ title: t.title, description: t.description, variant: t.variant });
    }

    if ('GameProposed' in n) {
      if (!iStarted) {
        try {
          // Accept and immediately submit move 0 (commit to random number) in one atomic call
          go?.acceptProposalAndMove(n.GameProposed.id.toString(), null);
        } catch (e) {
          console.error('acceptProposalAndMove failed:', e);
        }
      }
    } else if ('GameProposalAccepted' in n) {
      const newId = n.GameProposalAccepted.id.toString();
      setGameIds(prev => [...prev, newId]);
      gameIdsRef.current = [...gameIdsRef.current, newId];
      // Joiner already made move 0 via acceptProposalAndMove; proposer starts at move 0
      setMyTurn(iStarted);
      setMoveNumber(iStarted ? 0 : 1);
      moveNumberRef.current = iStarted ? 0 : 1;
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
    } else if ('OpponentMoved' in n) {
      const currentMove = moveNumberRef.current;

      setMyTurn(true);

      if (currentMove === 1 && !iStarted) {
        try {
          const cards = parseCards(n.OpponentMoved.readable, iStarted);
          console.log('[calpoker] OpponentMoved cards (joiner):', cards);
          setPlayerHand(cards.playerHand);
          setOpponentHand(cards.opponentHand);
          playerHandRef.current = cards.playerHand;
          opponentHandRef.current = cards.opponentHand;
        } catch (e) {
          console.error('[calpoker] parseCards from OpponentMoved failed:', e);
        }
      } else if (currentMove >= 2) {
        const myDiscardsBitfield = selectedCardsToBitfield(
          cardSelectionsRef.current,
          playerHandRef.current,
        );
        const newOutcome = new CalpokerOutcome(
          iStarted,
          myDiscardsBitfield,
          iStarted ? opponentHandRef.current : playerHandRef.current,
          iStarted ? playerHandRef.current : opponentHandRef.current,
          n.OpponentMoved.readable,
        );
        recognizeOutcome(newOutcome);
        if (!iStarted && currentMove === 2) {
          try {
            go?.makeMove(gameIdsRef.current[0], null);
          } catch (e) {
            console.error('makeMove failed:', e);
          }
        } else {
          try {
            go?.acceptTimeout(gameIdsRef.current[0]);
          } catch (e) {
            console.error('acceptTimeout failed:', e);
          }
        }
      }
    } else if ('GameMessage' in n) {
      try {
        const cards = parseCards(n.GameMessage.readable, iStarted);
        console.log('[calpoker] GameMessage cards:', cards);
        setPlayerHand(cards.playerHand);
        setOpponentHand(cards.opponentHand);
        playerHandRef.current = cards.playerHand;
        opponentHandRef.current = cards.opponentHand;
      } catch (e) {
        console.error('[calpoker] parseCards failed:', e, 'readable:', n.GameMessage.readable);
      }
    } else if ('CleanShutdownComplete' in n) {
      setGameConnectionState({ stateIdentifier: 'clean_shutdown', stateDetail: [] });
    } else if ('ChannelCreated' in n) {
      console.log('[calpoker] channel created, iStarted:', iStarted);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });
      if (iStarted) {
        proposeNewGame();
      }
    } else if ('CleanShutdownStarted' in n) {
      // Peer initiated clean shutdown
    } else if ('GoingOnChain' in n) {
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: ['On-chain dispute in progress'] });
    } else if (isTerminal(n)) {
      setGameIds(prev => prev.slice(1));
      gameIdsRef.current = gameIdsRef.current.slice(1);
      setMyTurn(false);
      setOurCardSelections([]);
      cardSelectionsRef.current = [];
      setMoveNumber(0);
      moveNumberRef.current = 0;
      setPlayerHand([]);
      setOpponentHand([]);
      playerHandRef.current = [];
      opponentHandRef.current = [];
      setOutcome(undefined);
      setLastOutcome(gameOutcomeRef.current);
      setGameConnectionState({ stateIdentifier: 'running', stateDetail: [] });

      if (iStarted) {
        setTimeout(() => {
          proposeNewGame();
        }, 2000);
      }
    } else {
      console.warn('[calpoker] unhandled notification:', JSON.stringify(n));
    }
  }, [iStarted, recognizeOutcome, proposeNewGame]);

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
            setGameConnectionState({ stateIdentifier: 'clean_shutdown', stateDetail: [] });
            break;
          case 'address':
            setAddressData(evt.data);
            break;
          default:
            console.warn('[calpoker] unhandled event type:', (evt as any).type, evt);
            break;
        }
      }
    });

    if (!initStarted) {
      setInitStarted(true);
    }

    return () => {
      subscription.unsubscribe();
    };
  }, [gameObject, iStarted, handleNotification, proposeNewGame]);

  useEffect(() => {
    const subscription = blockchain.getObservable().subscribe({
      next: (e: BlockchainReport) => {
        gameObject?.blockNotification(e.peak, e.block, e.report);
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameObject]);

  const handleMakeMove = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const currentGameId = gameIdsRef.current[0];
    if (!currentGameId) return;

    const currentMove = moveNumberRef.current;

    if (currentMove === 0) {
      go.makeMove(currentGameId, null);
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
    } else if (currentMove === 1) {
      if (cardSelectionsRef.current.length !== 4) return;
      const cards = cardSelectionsRef.current;
      go.makeMove(currentGameId, Program.fromList(cards.map(c => Program.fromInt(c))));
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
    } else if (currentMove === 2) {
      go.makeMove(currentGameId, null);
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
    }
  }, []);

  const handleCheat = useCallback(() => {
    const go = gameObjectRef.current;
    const currentGameId = gameIdsRef.current[0];
    if (!go || !currentGameId) return;
    go.cheat(currentGameId, 0);
  }, []);

  const setCardSelections = useCallback((selectionsOrFn: number[] | ((prev: number[]) => number[])) => {
    if (typeof selectionsOrFn === 'function') {
      setOurCardSelections(prev => {
        const next = selectionsOrFn(prev);
        cardSelectionsRef.current = next;
        return next;
      });
    } else {
      setOurCardSelections(selectionsOrFn);
      cardSelectionsRef.current = selectionsOrFn;
    }
  }, []);

  const stopPlaying = useCallback(() => {
    gameObject?.cleanShutdown();
  }, [gameObject]);

  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    storeInitArgs(chia_gaming_init, cg);
  }, []);

  return {
    error,
    addressData: addressData || { address: '', puzzleHash: '' },
    amount,
    ourShare,
    theirShare,
    log,
    gameConnectionState,
    isPlayerTurn,
    iStarted,
    playerNumber,
    handleMakeMove,
    handleCheat,
    playerHand,
    opponentHand,
    moveNumber,
    cardSelections,
    setCardSelections,
    stopPlaying,
    outcome,
    lastOutcome,
  };
}
