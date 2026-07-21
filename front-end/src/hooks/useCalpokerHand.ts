import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import {
  CalpokerOutcome,
} from '../types/ChiaGaming';
import { SessionController } from './SessionController';
import { CalpokerHandState, CalpokerDisplaySnapshot, PersistedGameState } from './save';
import { GameplayEvent } from './useGameSession';
import { type SettlementOutcome } from '../lib/settlement';

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

export function calpokerStateFromPersisted(
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
  settlementOutcome: SettlementOutcome | null;
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

// At the endgame reveal (currentMove >= 2) exactly one player still owes a
// terminal move: the first mover, whose initial turn is `!iStarted`
// (iStarted === false) — this is "Alice" in CalpokerOutcome terms. She has just
// received the opponent's reveal (step d) and her autofire still needs to play
// step e, so she must NOT mark the hand finished. The responder
// (iStarted === true, "Bob") has received Alice's terminal move; the hand is
// over for him and he must not fire a phantom sixth move, so he finishes here.
export function calpokerResponderFinishesAtReveal(iStarted: boolean): boolean {
  return iStarted;
}

export function useCalpokerHand(
  gameObject: SessionController,
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
  const [settlementOutcome, setSettlementOutcome] = useState<SettlementOutcome | null>(
    initialHandState?.settlementOutcome ?? null,
  );

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
          if (evt.OpponentMoved.gameId && evt.OpponentMoved.gameId !== gameIdRef.current) return;
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
              handFinishedRef.current = true;
              throw e;
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

            // Endgame mirrors on-chain play: the terminal mover (Alice) makes
            // the final move (step e) via the autofire effect and the responder
            // (Bob) gives up. Only the responder marks the hand finished here;
            // Alice's hand finishes when Bob gives up (Timeout /
            // EndedOpponentTimedOut), not here. See calpokerResponderFinishesAtReveal.
            if (calpokerResponderFinishesAtReveal(iStarted)) {
              handFinishedRef.current = true;
            }

            onOutcome(newOutcome);
          }
        } else if ('GameMessage' in evt) {
          if (evt.GameMessage.gameId && evt.GameMessage.gameId !== gameIdRef.current) return;
          if (handFinishedRef.current) return;
          try {
            const cards = parseCards(evt.GameMessage.readable, iStarted);
            setPlayerHand(cards.playerHand);
            setOpponentHand(cards.opponentHand);
            playerHandRef.current = cards.playerHand;
            opponentHandRef.current = cards.opponentHand;
          } catch (e) {
            console.error('parseCards failed:', e, 'readable:', evt.GameMessage.readable);
            handFinishedRef.current = true;
            throw e;
          }
        } else if ('Settled' in evt) {
          if (evt.Settled.gameId !== gameIdRef.current) return;
          // Always record settlement labels (Timed Out / Forfeit), even when
          // the hand already finished via reveal / autofire.
          handFinishedRef.current = true;
          setSettlementOutcome(evt.Settled.outcome);
        } else if ('GameError' in evt) {
          if (evt.GameError.gameId !== gameIdRef.current) return;
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
    if (playerHand.length > 0 || settlementOutcome) {
      const existing = calpokerStateFromPersisted(gameObject.handState);
      gameObject.setHandState(persistedCalpokerState({
        playerHand: playerHand.length > 0 ? playerHand : (existing?.playerHand ?? []),
        opponentHand: opponentHand.length > 0 ? opponentHand : (existing?.opponentHand ?? []),
        moveNumber,
        isPlayerTurn,
        cardSelections: cardSelectionsRef.current,
        displaySnapshot: existing?.displaySnapshot,
        settlementOutcome,
      }));
    }
  }, [playerHand, opponentHand, moveNumber, isPlayerTurn, settlementOutcome, gameObject]);

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
    // A cheat is just an (illegal) move; drive the same turn-change path a
    // normal move uses so the status shows "Playing our move on-chain" while
    // it lands, instead of staying on our turn.
    setMyTurn(false);
    onTurnChanged(false);
  }, [onTurnChanged]);

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
    settlementOutcome,
    handleMakeMove,
    handleCheat,
    handleNerf,
    saveDisplaySnapshot,
    initialDisplaySnapshot: initialHandState?.displaySnapshot,
  };
}
