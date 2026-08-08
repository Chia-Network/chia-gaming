import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { CalpokerOutcome } from './outcome';
import { SessionController } from '../../hooks/SessionController';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { GameTerminalModel } from '../../lib/session/types';
import { GameplayEvent } from '../../hooks/useGameSession';
import { commitGameStateTransition } from '../../lib/session/gameStateTransition';
import {
  calpokerStateCodec,
  type CalpokerDisplaySnapshot,
  type CalpokerHandState,
} from './stateCodec';

export type { CalpokerDisplaySnapshot, CalpokerHandState } from './stateCodec';

function parseCards(
  readableBytes: Uint8Array | number[],
  iStarted: boolean,
): { playerHand: bigint[]; opponentHand: bigint[] } {
  const program = Program.deserialize(Uint8Array.from(readableBytes));
  const card_lists = program.toList().map((l) => l.toList().map((v) => v.toBigInt()));
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
  return calpokerStateCodec.decode(persisted) ?? undefined;
}

export interface UseCalpokerHandResult {
  playerHand: bigint[];
  opponentHand: bigint[];
  cardSelections: bigint[];
  setCardSelections: (s: bigint[] | ((prev: bigint[]) => bigint[])) => void;
  setHandOrder: (playerHand: bigint[], opponentHand?: bigint[]) => void;
  moveNumber: bigint;
  outcome: CalpokerOutcome | undefined;
  terminalOutcome: GameTerminalModel['outcome'];
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

export function shouldRestoreCalpokerSelection(
  moveNumber: string,
  hasOutcome: boolean,
  hasTerminalOutcome: boolean,
): boolean {
  return moveNumber === '1' && !hasOutcome && !hasTerminalOutcome;
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
  terminal: GameTerminalModel,
  initialPersistedState?: PersistedGameState,
): UseCalpokerHandResult {
  const initialHandState = useMemo(
    () => calpokerStateFromPersisted(initialPersistedState),
    [initialPersistedState],
  );
  const [playerHand, setPlayerHand] = useState<bigint[]>(initialHandState?.playerHand ?? []);
  const [opponentHand, setOpponentHand] = useState<bigint[]>(initialHandState?.opponentHand ?? []);
  const [cardSelections, setOurCardSelections] = useState<bigint[]>(
    initialHandState?.cardSelections ?? [],
  );
  const [moveNumber, setMoveNumber] = useState<bigint>(initialHandState?.moveNumber ?? 0n);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(initialHandState?.isPlayerTurn ?? !iStarted);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);

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
  const stateRef = useRef<CalpokerHandState>(
    initialHandState ?? {
      playerHand: [],
      opponentHand: [],
      cardSelections: [],
      moveNumber: 0n,
      isPlayerTurn: !iStarted,
    },
  );

  playerHandRef.current = playerHand;
  opponentHandRef.current = opponentHand;
  cardSelectionsRef.current = cardSelections;
  moveNumberRef.current = moveNumber;
  gameObjectRef.current = gameObject;
  gameIdRef.current = gameId;
  isPlayerTurnRef.current = isPlayerTurn;

  const commitState = useCallback((update: (current: CalpokerHandState) => CalpokerHandState) => {
    stateRef.current = commitGameStateTransition(
      gameObjectRef.current,
      calpokerStateCodec,
      stateRef.current,
      update,
      (next) => {
        playerHandRef.current = next.playerHand;
        opponentHandRef.current = next.opponentHand;
        cardSelectionsRef.current = next.cardSelections ?? [];
        moveNumberRef.current = next.moveNumber;
        isPlayerTurnRef.current = next.isPlayerTurn;
        setPlayerHand(next.playerHand);
        setOpponentHand(next.opponentHand);
        setOurCardSelections(next.cardSelections ?? []);
        setMoveNumber(next.moveNumber);
        setMyTurn(next.isPlayerTurn);
      },
    );
  }, []);

  useEffect(() => {
    const subscription = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if ('OpponentMoved' in evt) {
          if (evt.OpponentMoved.gameId && evt.OpponentMoved.gameId !== gameIdRef.current) return;
          if (!shouldProcessCalpokerOpponentMoved(handFinishedRef.current, !!outcomeRef.current))
            return;
          const currentMove = moveNumberRef.current;
          let cards: { playerHand: bigint[]; opponentHand: bigint[] } | null = null;
          if (currentMove === 1n && !iStarted) {
            try {
              cards = parseCards(evt.OpponentMoved.readable, iStarted);
            } catch (e) {
              console.error('parseCards from OpponentMoved failed:', e);
              handFinishedRef.current = true;
              throw e;
            }
          }
          commitState((current) => ({
            ...current,
            ...(cards ?? {}),
            isPlayerTurn: true,
          }));
          onTurnChanged(true);

          if (currentMove === 1n && !iStarted) {
            // Cards were committed with the turn transition above.
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
            commitState((current) => ({ ...current, ...cards }));
          } catch (e) {
            console.error('parseCards failed:', e, 'readable:', evt.GameMessage.readable);
            handFinishedRef.current = true;
            throw e;
          }
        } else if ('Settled' in evt) {
          if (evt.Settled.gameId !== gameIdRef.current) return;
          handFinishedRef.current = true;
        } else if ('GameError' in evt) {
          if (evt.GameError.gameId !== gameIdRef.current) return;
          handFinishedRef.current = true;
        }
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameplayEvent$, iStarted, onOutcome, onTurnChanged, commitState]);

  const submitMove1 = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;
    if (cardSelectionsRef.current.length !== 4) return;
    const cards = cardSelectionsRef.current;
    commitState((current) => ({ ...current, moveNumber: 2n, isPlayerTurn: false }));
    go.makeMove(gid, Program.fromList(cards.map((c) => Program.fromBigInt(c))));
    onTurnChanged(false);
    pendingPlayRef.current = false;
  }, [onTurnChanged, commitState]);

  const handleMakeMove = useCallback(() => {
    if (handFinishedRef.current) return;
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;

    const currentMove = moveNumberRef.current;

    if (currentMove === 0n) {
      commitState((current) => ({ ...current, moveNumber: 1n, isPlayerTurn: false }));
      go.makeMove(gid, null);
      onTurnChanged(false);
    } else if (currentMove === 1n) {
      if (cardSelectionsRef.current.length !== 4) return;
      if (isPlayerTurnRef.current) {
        submitMove1();
      } else {
        pendingPlayRef.current = true;
      }
    } else if (currentMove === 2n) {
      commitState((current) => ({ ...current, moveNumber: 3n, isPlayerTurn: false }));
      go.makeMove(gid, null);
      onTurnChanged(false);
    }
  }, [onTurnChanged, submitMove1, commitState]);

  // Autofire moves 0 and 2; auto-submit queued move 1
  useEffect(() => {
    if (restoredRef.current) {
      restoredRef.current = false;
      return;
    }
    if (handFinishedRef.current) return;
    if (!isPlayerTurn) return;
    const m = moveNumberRef.current;
    if (shouldAutoFireCalpokerMove(handFinishedRef.current, isPlayerTurn, m)) {
      handleMakeMove();
    } else if (m === 1n && pendingPlayRef.current) {
      submitMove1();
    }
  }, [isPlayerTurn, moveNumber, handleMakeMove, submitMove1]);

  const handleCheat = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    // A cheat is just an (illegal) move; drive the same turn-change path a
    // normal move uses so the status shows "Playing our move on-chain" while
    // it lands, instead of staying on our turn.
    commitState((current) => ({ ...current, isPlayerTurn: false }));
    go.cheat(gid, 0n);
    onTurnChanged(false);
  }, [onTurnChanged, commitState]);

  const handleNerf = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go) return;
    go.nerf();
  }, []);

  const setCardSelections = useCallback(
    (selectionsOrFn: bigint[] | ((prev: bigint[]) => bigint[])) => {
      if (typeof selectionsOrFn === 'function') {
        commitState((current) => ({
          ...current,
          cardSelections: selectionsOrFn(current.cardSelections ?? []),
        }));
      } else {
        commitState((current) => ({ ...current, cardSelections: selectionsOrFn }));
      }
    },
    [commitState],
  );

  const setHandOrder = useCallback(
    (nextPlayerHand: bigint[], nextOpponentHand?: bigint[]) => {
      commitState((current) => ({
        ...current,
        playerHand: nextPlayerHand,
        opponentHand: nextOpponentHand ?? current.opponentHand,
      }));
    },
    [commitState],
  );

  const saveDisplaySnapshot = useCallback(
    (snapshot: CalpokerDisplaySnapshot) => {
      const go = gameObjectRef.current;
      if (!go) return;
      commitState((current) => ({ ...current, displaySnapshot: snapshot }));
    },
    [commitState],
  );

  return {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    setHandOrder,
    moveNumber,
    outcome,
    terminalOutcome: terminal.outcome,
    handleMakeMove,
    handleCheat,
    handleNerf,
    saveDisplaySnapshot,
    initialDisplaySnapshot: initialHandState?.displaySnapshot,
  };
}
