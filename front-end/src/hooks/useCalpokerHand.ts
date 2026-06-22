import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import {
  CalpokerOutcome,
} from '../types/ChiaGaming';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { CalpokerHandState, CalpokerDisplaySnapshot, PersistedGameState } from './save';
import { GameplayEvent } from './useGameSession';

const CALPOKER_PERSISTED_STATE_VERSION = 1n;

function parseCards(readableBytes: Uint8Array | number[], iStarted: boolean): { playerHand: bigint[], opponentHand: bigint[] } {
  const program = Program.deserialize(Uint8Array.from(readableBytes));
  const card_lists = program.toList().map(l => l.toList().map(v => v.toBigInt()));
  if (iStarted) {
    return { playerHand: card_lists[1], opponentHand: card_lists[0] };
  } else {
    return { playerHand: card_lists[0], opponentHand: card_lists[1] };
  }
}

function selectedCardsToBitfield(selectedCards: bigint[], hand: bigint[]): bigint {
  let bitfield = 0n;
  hand.forEach((cardId, index) => {
    if (selectedCards.includes(cardId)) {
      bitfield |= 1n << BigInt(index);
    }
  });
  return bitfield;
}

function calpokerStateFromPersisted(
  persisted: PersistedGameState | null | undefined,
): CalpokerHandState | undefined {
  if (!persisted || persisted.gameType !== 'calpoker') return undefined;
  if (persisted.version !== CALPOKER_PERSISTED_STATE_VERSION) return undefined;
  if (!persisted.state || typeof persisted.state !== 'object') return undefined;
  return persisted.state as CalpokerHandState;
}

function persistedCalpokerState(state: CalpokerHandState): PersistedGameState<CalpokerHandState> {
  return {
    gameType: 'calpoker',
    version: CALPOKER_PERSISTED_STATE_VERSION,
    state,
  };
}

export interface UseCalpokerHandResult {
  playerHand: bigint[];
  opponentHand: bigint[];
  cardSelections: bigint[];
  setCardSelections: (s: bigint[] | ((prev: bigint[]) => bigint[])) => void;
  setHandOrder: (playerHand: bigint[], opponentHand?: bigint[]) => void;
  moveNumber: bigint;
  outcome: CalpokerOutcome | undefined;
  timeoutByUs: boolean | null;
  handleMakeMove: () => void;
  handleCheat: () => void;
  handleNerf: () => void;
  saveDisplaySnapshot: (snapshot: CalpokerDisplaySnapshot) => void;
  initialDisplaySnapshot: CalpokerDisplaySnapshot | undefined;
}

export function shouldAutoFireCalpokerMove(
  handFinished: boolean,
  isPlayerTurn: boolean,
  moveNumber: bigint,
): boolean {
  return !handFinished && isPlayerTurn && (moveNumber === 0n || moveNumber === 2n);
}

export function shouldProcessCalpokerOpponentMoved(
  handFinished: boolean,
  hasOutcome: boolean,
): boolean {
  return !handFinished || !hasOutcome;
}

export function useCalpokerHand(
  gameObject: WasmBlobWrapper,
  gameId: string,
  iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  onOutcome: (outcome: CalpokerOutcome) => void,
  onTurnChanged: (isMyTurn: boolean) => void,
  initialPersistedState?: PersistedGameState,
): UseCalpokerHandResult {
  const initialHandState = useMemo(
    () => calpokerStateFromPersisted(initialPersistedState),
    [initialPersistedState],
  );
  const [playerHand, setPlayerHand] = useState<bigint[]>(initialHandState?.playerHand ?? []);
  const [opponentHand, setOpponentHand] = useState<bigint[]>(initialHandState?.opponentHand ?? []);
  const [cardSelections, setOurCardSelections] = useState<bigint[]>(initialHandState?.cardSelections ?? []);
  const [moveNumber, setMoveNumber] = useState<bigint>(initialHandState?.moveNumber ?? 0n);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(initialHandState?.isPlayerTurn ?? !iStarted);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [timeoutByUs, setTimeoutByUs] = useState<boolean | null>(null);

  const playerHandRef = useRef<bigint[]>(initialHandState?.playerHand ?? []);
  const opponentHandRef = useRef<bigint[]>(initialHandState?.opponentHand ?? []);
  const cardSelectionsRef = useRef<bigint[]>(initialHandState?.cardSelections ?? []);
  const moveNumberRef = useRef<bigint>(initialHandState?.moveNumber ?? 0n);
  const gameObjectRef = useRef(gameObject);
  const gameIdRef = useRef(gameId);
  const handFinishedRef = useRef(false);
  const outcomeRef = useRef<CalpokerOutcome | undefined>(undefined);
  const pendingPlayRef = useRef(false);
  const isPlayerTurnRef = useRef(initialHandState?.isPlayerTurn ?? !iStarted);
  const restoredRef = useRef(!!initialHandState);

  playerHandRef.current = playerHand;
  opponentHandRef.current = opponentHand;
  cardSelectionsRef.current = cardSelections;
  moveNumberRef.current = moveNumber;
  gameObjectRef.current = gameObject;
  gameIdRef.current = gameId;
  isPlayerTurnRef.current = isPlayerTurn;

  useEffect(() => {
    const subscription = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if ('OpponentMoved' in evt) {
          if (!shouldProcessCalpokerOpponentMoved(handFinishedRef.current, !!outcomeRef.current)) return;
          const currentMove = moveNumberRef.current;
          setMyTurn(true);
          onTurnChanged(true);

          if (currentMove === 1n && !iStarted) {
            try {
              const cards = parseCards(evt.OpponentMoved.readable, iStarted);
              setPlayerHand(cards.playerHand);
              setOpponentHand(cards.opponentHand);
              playerHandRef.current = cards.playerHand;
              opponentHandRef.current = cards.opponentHand;
            } catch (e) {
              console.error('parseCards from OpponentMoved failed:', e);
            }
          } else if (currentMove >= 2n) {
            const myDiscardsBitfield = selectedCardsToBitfield(
              cardSelectionsRef.current,
              playerHandRef.current,
            );
            const newOutcome = new CalpokerOutcome(
              iStarted,
              myDiscardsBitfield,
              iStarted ? opponentHandRef.current : playerHandRef.current,
              iStarted ? playerHandRef.current : opponentHandRef.current,
              evt.OpponentMoved.readable,
            );
            setOutcome(newOutcome);
            outcomeRef.current = newOutcome;

            // Endgame mirrors on-chain play: Alice makes the terminal move and
            // Bob gives up. The responder (Bob) has just received Alice's
            // terminal move, so the hand is over for him — the infrastructure
            // hands him this final readable (after confirming no slash is
            // available) and queues the AcceptTimeout that settles the game. He
            // must NOT send a phantom sixth move back over the wire. The
            // initiator (Alice) has learned the result from the opponent's
            // reveal but still owes her terminal move (step e); the autofire
            // effect plays it so the opponent and the chain can settle, and her
            // hand finishes when the opponent gives up (Timeout /
            // EndedOpponentTimedOut), not here.
            if (!iStarted) {
              handFinishedRef.current = true;
            }

            onOutcome(newOutcome);
          }
        } else if ('GameMessage' in evt) {
          if (handFinishedRef.current) return;
          try {
            const cards = parseCards(evt.GameMessage.readable, iStarted);
            setPlayerHand(cards.playerHand);
            setOpponentHand(cards.opponentHand);
            playerHandRef.current = cards.playerHand;
            opponentHandRef.current = cards.opponentHand;
          } catch (e) {
            console.error('parseCards failed:', e, 'readable:', evt.GameMessage.readable);
          }
        } else if ('Timeout' in evt) {
          if (!handFinishedRef.current) {
            handFinishedRef.current = true;
            setTimeoutByUs(evt.Timeout.byUs);
          }
        } else if ('GameError' in evt) {
          handFinishedRef.current = true;
        }
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameplayEvent$, iStarted, onOutcome, onTurnChanged]);

  const submitMove1 = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;
    if (cardSelectionsRef.current.length !== 4) return;
    const cards = cardSelectionsRef.current;
    go.makeMove(gid, Program.fromList(cards.map(c => Program.fromBigInt(c))));
    setMoveNumber(2n);
    moveNumberRef.current = 2n;
    setMyTurn(false);
    onTurnChanged(false);
    pendingPlayRef.current = false;
  }, [onTurnChanged]);

  const handleMakeMove = useCallback(() => {
    if (handFinishedRef.current) return;
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;

    const currentMove = moveNumberRef.current;

    if (currentMove === 0n) {
      go.makeMove(gid, null);
      setMoveNumber(1n);
      moveNumberRef.current = 1n;
      setMyTurn(false);
      onTurnChanged(false);
    } else if (currentMove === 1n) {
      if (cardSelectionsRef.current.length !== 4) return;
      if (isPlayerTurnRef.current) {
        submitMove1();
      } else {
        pendingPlayRef.current = true;
      }
    } else if (currentMove === 2n) {
      go.makeMove(gid, null);
      setMoveNumber(3n);
      moveNumberRef.current = 3n;
      setMyTurn(false);
      onTurnChanged(false);
    }
  }, [onTurnChanged, submitMove1]);

  // Autofire moves 0 and 2; auto-submit queued move 1
  useEffect(() => {
    if (restoredRef.current) { restoredRef.current = false; return; }
    if (handFinishedRef.current) return;
    if (!isPlayerTurn) return;
    const m = moveNumberRef.current;
    if (shouldAutoFireCalpokerMove(handFinishedRef.current, isPlayerTurn, m)) {
      handleMakeMove();
    } else if (m === 1n && pendingPlayRef.current) {
      submitMove1();
    }
  }, [isPlayerTurn, moveNumber, handleMakeMove, submitMove1]);

  useEffect(() => {
    if (playerHand.length > 0) {
      const existing = calpokerStateFromPersisted(gameObject.handState);
      gameObject.setHandState(persistedCalpokerState({
        playerHand, opponentHand, moveNumber, isPlayerTurn,
        cardSelections: cardSelectionsRef.current,
        displaySnapshot: existing?.displaySnapshot,
      }));
    }
  }, [playerHand, opponentHand, moveNumber, isPlayerTurn, gameObject]);

  useEffect(() => {
    if (playerHand.length > 0) {
      const existing = calpokerStateFromPersisted(gameObject.handState);
      if (existing) {
        gameObject.setHandState(persistedCalpokerState({ ...existing, cardSelections }));
      }
    }
  }, [cardSelections, gameObject]);

  const handleCheat = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    go.cheat(gid, 0n);
  }, []);

  const handleNerf = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go) return;
    go.nerf();
  }, []);

  const setCardSelections = useCallback((selectionsOrFn: bigint[] | ((prev: bigint[]) => bigint[])) => {
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

  const setHandOrder = useCallback((nextPlayerHand: bigint[], nextOpponentHand?: bigint[]) => {
    setPlayerHand(nextPlayerHand);
    playerHandRef.current = nextPlayerHand;
    if (nextOpponentHand) {
      setOpponentHand(nextOpponentHand);
      opponentHandRef.current = nextOpponentHand;
    }
  }, []);

  const saveDisplaySnapshot = useCallback((snapshot: CalpokerDisplaySnapshot) => {
    const go = gameObjectRef.current;
    if (!go) return;
    const existing = calpokerStateFromPersisted(go.handState);
    if (existing) {
      go.setHandState(persistedCalpokerState({ ...existing, displaySnapshot: snapshot }));
    }
  }, []);

  return {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    setHandOrder,
    moveNumber,
    outcome,
    timeoutByUs,
    handleMakeMove,
    handleCheat,
    handleNerf,
    saveDisplaySnapshot,
    initialDisplaySnapshot: initialHandState?.displaySnapshot,
  };
}
