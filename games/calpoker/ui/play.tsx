import { lazy, useCallback } from 'react';
import {
  EMPTY_GAME_TERMINAL_MODEL,
  gameHandSourceFromMountView,
  type GameHandOrigin,
  type GameHandSource,
  type GameMountRegistration,
  type GameTerminalModel,
} from '../../host';
import { useGameHost } from '../../host/ui';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from './types/CaliforniapokerProps';
import { useCalpokerHand } from './useCalpokerHand';
import type { CalpokerDisplaySnapshot } from './serialize';
import type { CalpokerOutcomeShape } from './outcome';

const Calpoker = lazy(() => import('./Calpoker'));

function amountForGame(amountsById: Record<string, string>, gameId: string): bigint {
  const amount = amountsById[gameId];
  if (amount === undefined) {
    throw new Error(`California Poker is missing the accepted amount for game ${gameId}`);
  }
  return BigInt(amount);
}

export interface CalpokerLiveMountProps {
  handSource: GameHandSource<import('./serialize').CalpokerHandState>;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  appendGameLog?: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
  handOrigin?: GameHandOrigin;
}

function snapshotView(
  snapshot: CalpokerDisplaySnapshot | undefined,
): CalpokerDisplaySnapshotView | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(String),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(String),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(String),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(String),
  };
}

function snapshotModel(snapshot: CalpokerDisplaySnapshotView): CalpokerDisplaySnapshot {
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(BigInt),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(BigInt),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(BigInt),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(BigInt),
  };
}

function outcomeView(
  outcome: CalpokerOutcomeShape<bigint> | undefined,
): CalpokerOutcomeView | undefined {
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

export function CalpokerLiveMount(props: CalpokerLiveMountProps) {
  const {
    handSource,
    gameId,
    iStarted,
    playerNumber,
    appendGameLog,
    perGameAmount,
    myName,
    opponentName,
    terminal,
    handOrigin = 'fresh',
  } = props;
  const { formatAmount } = useGameHost();
  const hand = useCalpokerHand(handSource, gameId, iStarted, terminal, handOrigin);
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (!appendGameLog) return;
      appendGameLog(`California Poker ${formatAmount(perGameAmount)}`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, formatAmount, perGameAmount],
  );

  return (
    <Calpoker
      outcome={outcomeView(hand.outcome)}
      moveNumber={String(hand.moveNumber)}
      playerNumber={playerNumber}
      playerHand={hand.playerHand.map(String)}
      opponentHand={hand.opponentHand.map(String)}
      cardSelections={hand.cardSelections.map(String)}
      setCardSelections={(next) =>
        hand.setCardSelections((previous) => {
          const view = previous.map(String);
          return (typeof next === 'function' ? next(view) : next).map(BigInt);
        })
      }
      setHandOrder={(player, opponent) =>
        hand.setHandOrder(player.map(BigInt), opponent?.map(BigInt))
      }
      handleMakeMove={hand.handleMakeMove}
      handleCheat={hand.handleCheat}
      onGameLog={handleGameLog}
      onSnapshotChange={(snapshot) => hand.saveDisplaySnapshot(snapshotModel(snapshot))}
      initialSnapshot={snapshotView(hand.initialDisplaySnapshot)}
      myName={myName}
      opponentName={opponentName}
      terminalOutcome={hand.terminalOutcome}
      interactionMode={handSource.interactionMode}
      error={null}
    />
  );
}

export const play: GameMountRegistration = {
  render(view) {
    const gameId =
      view.activeIds[0] ?? view.lastDisplayedId ?? view.currentHandIds[0] ?? 'finished';
    const source = gameHandSourceFromMountView<import('./serialize').CalpokerHandState>(view);
    return (
      <CalpokerLiveMount
        handSource={source}
        gameId={gameId}
        iStarted={view.iStarted}
        playerNumber={view.playerNumber}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        perGameAmount={amountForGame(
          Object.fromEntries(
            Object.entries(view.instances).map(([id, instance]) => [id, instance.amount]),
          ),
          gameId,
        )}
        terminal={view.instances[gameId]?.terminal ?? EMPTY_GAME_TERMINAL_MODEL}
        handOrigin={view.handOrigin}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
