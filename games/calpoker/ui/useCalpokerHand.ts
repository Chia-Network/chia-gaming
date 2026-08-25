import { useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import type { CalpokerOutcomeShape } from './outcome';
import type { GameHandOrigin, GameHandSource, GameTerminalModel } from '../../host';
import { gameHandState, requireLiveGameHandSource } from '../../host';
import { type CalpokerDisplaySnapshot, type CalpokerHandState } from './serialize';

export type { CalpokerDisplaySnapshot, CalpokerHandState } from './serialize';

type LocalGameCommand =
  | { type: 'make-move'; readable: Program | null }
  | { type: 'accept-settlement' }
  | { type: 'cheat'; moverShare: bigint };

export interface UseCalpokerHandResult {
  playerHand: bigint[];
  opponentHand: bigint[];
  cardSelections: bigint[];
  setCardSelections: (s: bigint[] | ((prev: bigint[]) => bigint[])) => void;
  setHandOrder: (playerHand: bigint[], opponentHand?: bigint[]) => void;
  moveNumber: bigint;
  outcome: CalpokerOutcomeShape<bigint> | undefined;
  terminalOutcome: GameTerminalModel['outcome'];
  handleMakeMove: () => void;
  handleCheat: () => void;
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
  handSource: GameHandSource<CalpokerHandState>,
  gameId: string,
  iStarted: boolean,
  terminal: GameTerminalModel,
  handOrigin: GameHandOrigin = 'fresh',
): UseCalpokerHandResult {
  const interactive = handSource.interactionMode === 'live';
  const handState = gameHandState(handSource);
  const handSourceRef = useRef(handSource);
  const gameIdRef = useRef(gameId);
  const pendingPlayRef = useRef(false);
  const restoredRef = useRef(handOrigin === 'restored');
  const autoSubmissionRef = useRef<string | null>(null);
  const suppressInitialOutcomeRef = useRef(
    handOrigin !== 'fresh' &&
      handState.outcome !== undefined &&
      handState.displaySnapshot?.gameState === 'final',
  );

  handSourceRef.current = handSource;
  gameIdRef.current = gameId;

  const currentState = useCallback((): CalpokerHandState => {
    return gameHandState(handSourceRef.current);
  }, []);

  const commitState = useCallback(
    (update: (current: CalpokerHandState) => CalpokerHandState): void => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      controller.dispatch({ type: 'update-local-state', state: update(currentState()) });
    },
    [currentState],
  );

  const commitLocalAction = useCallback(
    (
      update: (current: CalpokerHandState) => CalpokerHandState,
      command: LocalGameCommand,
    ): void => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const next = update(currentState());
      controller.dispatch(
        command.type === 'make-move'
          ? {
              type: 'make-move',
              gameId: gameIdRef.current,
              readable: command.readable,
              state: next,
            }
          : command.type === 'accept-settlement'
            ? { type: 'accept-settlement', gameId: gameIdRef.current, state: next }
            : {
                type: 'cheat',
                gameId: gameIdRef.current,
                moverShare: command.moverShare,
                state: next,
              },
      );
    },
    [currentState],
  );

  const submitMove1 = useCallback(() => {
    const controller = requireLiveGameHandSource(handSourceRef.current);
    if (!controller.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;
    const current = currentState();
    if ((current.cardSelections ?? []).length !== 4) return;
    const cards = current.cardSelections ?? [];
    commitLocalAction((current) => ({ ...current, moveNumber: 2n, isPlayerTurn: false }), {
      type: 'make-move',
      readable: Program.fromList(cards.map((c) => Program.fromBigInt(c))),
    });
    pendingPlayRef.current = false;
  }, [commitLocalAction, currentState]);

  const handleMakeMove = useCallback(() => {
    const controller = requireLiveGameHandSource(handSourceRef.current);
    if (!controller.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;

    const current = currentState();
    const handFinished =
      terminal.outcome !== null ||
      (current.outcome !== undefined && calpokerResponderFinishesAtReveal(iStarted));
    if (handFinished) return;
    const currentMove = current.moveNumber;

    if (currentMove === 0n) {
      commitLocalAction((current) => ({ ...current, moveNumber: 1n, isPlayerTurn: false }), {
        type: 'make-move',
        readable: null,
      });
    } else if (currentMove === 1n) {
      if ((current.cardSelections ?? []).length !== 4) return;
      if (current.isPlayerTurn) {
        submitMove1();
      } else {
        pendingPlayRef.current = true;
      }
    } else if (currentMove === 2n) {
      commitLocalAction((current) => ({ ...current, moveNumber: 3n, isPlayerTurn: false }), {
        type: 'make-move',
        readable: null,
      });
    }
  }, [commitLocalAction, currentState, iStarted, submitMove1, terminal.outcome]);

  // Autofire moves 0 and 2; auto-submit queued move 1
  useEffect(() => {
    if (!interactive) return;
    if (restoredRef.current) {
      restoredRef.current = false;
      return;
    }
    const handFinished =
      terminal.outcome !== null ||
      (handState.outcome !== undefined && calpokerResponderFinishesAtReveal(iStarted));
    if (handFinished || !handState.isPlayerTurn) return;
    const controller = requireLiveGameHandSource(handSourceRef.current);
    if (!controller.isChannelReady() || !gameId) return;
    const m = handState.moveNumber;
    const submissionKey = `${gameId}:${m}`;
    if (autoSubmissionRef.current === submissionKey) return;
    if (shouldAutoFireCalpokerMove(handFinished, handState.isPlayerTurn, m)) {
      autoSubmissionRef.current = submissionKey;
      handleMakeMove();
    } else if (m === 1n && pendingPlayRef.current) {
      autoSubmissionRef.current = submissionKey;
      submitMove1();
    }
  }, [
    gameId,
    handSource,
    handState.isPlayerTurn,
    handState.moveNumber,
    handState.outcome,
    iStarted,
    interactive,
    handleMakeMove,
    submitMove1,
    terminal.outcome,
  ]);

  const handleCheat = useCallback(() => {
    requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    // A cheat is still a local move candidate, so it uses the same game-state
    // transition as a normal move while the host handles protocol execution.
    commitLocalAction((current) => ({ ...current, isPlayerTurn: false }), {
      type: 'cheat',
      moverShare: 0n,
    });
  }, [commitLocalAction]);

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
        cardSelections: (current.cardSelections ?? []).filter((card) =>
          nextPlayerHand.includes(card),
        ),
      }));
    },
    [commitState],
  );

  const saveDisplaySnapshot = useCallback(
    (snapshot: CalpokerDisplaySnapshot) => {
      requireLiveGameHandSource(handSourceRef.current);
      commitState((current) => ({ ...current, displaySnapshot: snapshot }));
    },
    [commitState],
  );

  return {
    playerHand: handState.playerHand,
    opponentHand: handState.opponentHand,
    cardSelections: handState.cardSelections ?? [],
    setCardSelections,
    setHandOrder,
    moveNumber: handState.moveNumber,
    outcome: suppressInitialOutcomeRef.current ? undefined : handState.outcome,
    terminalOutcome: terminal.outcome,
    handleMakeMove,
    handleCheat,
    saveDisplaySnapshot,
    initialDisplaySnapshot: handState.displaySnapshot,
  };
}
