import { useCallback } from 'react';
import type { Observable } from 'rxjs';

import Calpoker from '.';
import { useCalpokerHand } from './useCalpokerHand';
import type { SessionController } from '../../hooks/SessionController';
import type { RawGameNotification } from '../../hooks/useGameSession';
import type { CalpokerOutcome } from '../../types/ChiaGaming';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from './types/CaliforniapokerProps';
import { formatAmount } from '../../util';
import type { CalpokerDisplaySnapshot, CalpokerSettlementOutcome } from './handState';

export interface CalpokerGameHandProps {
  controller: SessionController;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  notifications$: Observable<RawGameNotification>;
  onOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  settlementOutcome?: string | null;
}

function parseSnapshot(snapshot: CalpokerDisplaySnapshotView): CalpokerDisplaySnapshot {
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(BigInt),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(BigInt),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(BigInt),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(BigInt),
  };
}

function outcomeView(outcome: CalpokerOutcome | undefined): CalpokerOutcomeView | undefined {
  if (!outcome) return undefined;
  return {
    my_win_outcome: outcome.my_win_outcome,
    my_cards: outcome.my_cards.map(String),
    their_cards: outcome.their_cards.map(String),
    my_final_hand: outcome.my_final_hand.map(String),
    their_final_hand: outcome.their_final_hand.map(String),
    my_used_cards: outcome.my_used_cards.map(String),
    their_used_cards: outcome.their_used_cards.map(String),
    my_hand_value: outcome.my_hand_value.map(String),
    their_hand_value: outcome.their_hand_value.map(String),
  };
}

export default function CalpokerGameHand({
  controller,
  gameId,
  iStarted,
  playerNumber,
  notifications$,
  onOutcome,
  onTurnChanged,
  appendGameLog,
  perGameAmount,
  myName,
  opponentName,
  settlementOutcome: settlementOutcomeOverride,
}: CalpokerGameHandProps) {
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    setHandOrder,
    moveNumber,
    outcome,
    settlementOutcome,
    settlementOnChain,
    handleMakeMove,
    saveDisplaySnapshot,
    initialDisplaySnapshot,
  } = useCalpokerHand(
    controller,
    gameId,
    iStarted,
    notifications$,
    onOutcome,
    handleTurnChanged,
    controller.handState ?? undefined,
  );

  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`California Poker ${formatAmount(perGameAmount)}`);
    lines.forEach((line) => appendGameLog(line));
    appendGameLog('');
  }, [appendGameLog, perGameAmount]);

  const setUiCardSelections = useCallback((next: string[] | ((prev: string[]) => string[])) => {
    setCardSelections((previous) => {
      const view = previous.map(String);
      return (typeof next === 'function' ? next(view) : next).map(BigInt);
    });
  }, [setCardSelections]);

  const handleSnapshotChange = useCallback((snapshot: CalpokerDisplaySnapshotView) => {
    saveDisplaySnapshot(parseSnapshot(snapshot));
  }, [saveDisplaySnapshot]);

  const setUiHandOrder = useCallback((player: string[], opponent?: string[]) => {
    setHandOrder(player.map(BigInt), opponent?.map(BigInt));
  }, [setHandOrder]);

  return (
    <Calpoker
      outcome={outcomeView(outcome)}
      moveNumber={String(moveNumber)}
      playerNumber={playerNumber}
      playerHand={playerHand.map(String)}
      opponentHand={opponentHand.map(String)}
      cardSelections={cardSelections.map(String)}
      setCardSelections={setUiCardSelections}
      setHandOrder={setUiHandOrder}
      handleMakeMove={handleMakeMove}
      onGameLog={handleGameLog}
      onSnapshotChange={handleSnapshotChange}
      initialSnapshot={initialDisplaySnapshot && {
        ...initialDisplaySnapshot,
        playerBestHandCardIds: initialDisplaySnapshot.playerBestHandCardIds.map(String),
        opponentBestHandCardIds: initialDisplaySnapshot.opponentBestHandCardIds.map(String),
        playerHaloCardIds: initialDisplaySnapshot.playerHaloCardIds.map(String),
        opponentHaloCardIds: initialDisplaySnapshot.opponentHaloCardIds.map(String),
      }}
      myName={myName}
      opponentName={opponentName}
      settlementOutcome={(settlementOutcomeOverride ?? settlementOutcome) as CalpokerSettlementOutcome | null}
      settlementOnChain={settlementOnChain}
    />
  );
}
