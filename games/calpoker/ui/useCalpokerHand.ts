import { useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import type { CalpokerOutcomeShape } from './outcome';
import type { GameMountView, SettlementOutcome } from '../../host';
import { requireLiveGameMount } from '../../host';
import {
  type CalpokerDisplaySnapshot,
  type CalpokerHand,
  type CalpokerHandState,
} from './serialize';

export type { CalpokerDisplaySnapshot, CalpokerHandState } from './serialize';

type LocalGameCommand = { type: 'make-move'; readable: Program | null };

export interface UseCalpokerHandResult {
  playerHand: bigint[];
  opponentHand: bigint[];
  cardSelections: bigint[];
  setCardSelections: (s: bigint[] | ((prev: bigint[]) => bigint[])) => void;
  setHandOrder: (playerHand: bigint[], opponentHand?: bigint[]) => void;
  moveNumber: bigint;
  outcome: CalpokerOutcomeShape<bigint> | undefined;
  terminalOutcome: SettlementOutcome | null;
  handleMakeMove: () => void;
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
  view: GameMountView<CalpokerHand>,
): UseCalpokerHandResult {
  const interactive = !view.frozen;
  const handState = view.hand.getState();
  const viewRef = useRef(view);
  const pendingPlayRef = useRef(false);
  const autoSubmissionRef = useRef<string | null>(null);
  const suppressInitialOutcomeRef = useRef(
    view.handOrigin !== 'fresh' &&
      handState.outcome !== undefined &&
      handState.displaySnapshot?.gameState === 'final',
  );

  viewRef.current = view;

  const currentState = useCallback((): CalpokerHandState => {
    return viewRef.current.hand.getState();
  }, []);

  const commitState = useCallback(
    (update: (current: CalpokerHandState) => CalpokerHandState): void => {
      const live = requireLiveGameMount(viewRef.current);
      live.hand.update(update);
      live.port.dispatch({ type: 'state-changed' });
    },
    [],
  );

  const commitLocalAction = useCallback(
    (
      update: (current: CalpokerHandState) => CalpokerHandState,
      command: LocalGameCommand,
    ): void => {
      const live = requireLiveGameMount(viewRef.current);
      live.hand.update(update);
      live.port.dispatch({
        type: 'make-move',
        memberIndex: 0,
        readable: command.readable,
      });
    },
    [],
  );

  const submitMove1 = useCallback(() => {
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
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
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
    const current = currentState();
    const handFinished =
      current.settlementOutcome !== null ||
      (current.outcome !== undefined && calpokerResponderFinishesAtReveal(current.iStarted));
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
  }, [commitLocalAction, currentState, submitMove1]);

  // Autofire moves 0 and 2; auto-submit queued move 1
  useEffect(() => {
    if (!interactive) return;
    const handFinished =
      handState.settlementOutcome !== null ||
      (handState.outcome !== undefined && calpokerResponderFinishesAtReveal(handState.iStarted));
    if (handFinished || !handState.isPlayerTurn) return;
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
    const m = handState.moveNumber;
    const submissionKey = `0:${m}`;
    if (autoSubmissionRef.current === submissionKey) return;
    if (shouldAutoFireCalpokerMove(handFinished, handState.isPlayerTurn, m)) {
      autoSubmissionRef.current = submissionKey;
      handleMakeMove();
    } else if (m === 1n && pendingPlayRef.current) {
      autoSubmissionRef.current = submissionKey;
      submitMove1();
    }
  }, [
    view,
    handState.isPlayerTurn,
    handState.moveNumber,
    handState.outcome,
    interactive,
    handleMakeMove,
    submitMove1,
    handState.iStarted,
    handState.settlementOutcome,
  ]);

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
      requireLiveGameMount(viewRef.current);
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
    terminalOutcome: handState.settlementOutcome,
    handleMakeMove,
    saveDisplaySnapshot,
    initialDisplaySnapshot: handState.displaySnapshot,
  };
}
