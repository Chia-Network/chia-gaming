import { lazy, useCallback } from 'react';
import {
  type GameMountView,
  type GameMountRegistration,
} from '../../host';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from './types/CaliforniapokerProps';
import { useCalpokerHand } from './useCalpokerHand';
import type { CalpokerDisplaySnapshot, CalpokerHand } from './serialize';
import type { CalpokerOutcomeShape } from './outcome';
import { formatCalpokerAmount } from './formatting';

const Calpoker = lazy(() => import('./Calpoker'));

export interface CalpokerLiveMountProps {
  view: GameMountView<CalpokerHand>;
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
  const { view } = props;
  const state = view.hand.getState();
  const hand = useCalpokerHand(view);
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (view.frozen) return;
      view.appendGameLog(`California Poker ${formatCalpokerAmount(state.perPlayerStake)}`);
      lines.forEach(view.appendGameLog);
      view.appendGameLog('');
    },
    [view, state.perPlayerStake],
  );

  return (
    <Calpoker
      outcome={outcomeView(hand.outcome)}
      moveNumber={String(hand.moveNumber)}
      playerNumber={state.iStarted ? 1 : 2}
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
      onGameLog={handleGameLog}
      onSnapshotChange={(snapshot) => hand.saveDisplaySnapshot(snapshotModel(snapshot))}
      initialSnapshot={snapshotView(hand.initialDisplaySnapshot)}
      myName={view.myName}
      opponentName={view.opponentName}
      terminalOutcome={hand.terminalOutcome}
      frozen={view.frozen}
      error={null}
    />
  );
}

export const play: GameMountRegistration<CalpokerHand> = {
  render(view) {
    return <CalpokerLiveMount view={view} />;
  },
};
