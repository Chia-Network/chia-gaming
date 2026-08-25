import { lazy, useCallback } from 'react';
import {
  gameHandState,
  gameHandSourceFromMountView,
  type GameHandOrigin,
  type GameHandSource,
  type GameMountRegistration,
} from '../../host';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from './types/CaliforniapokerProps';
import { useCalpokerHand } from './useCalpokerHand';
import type { CalpokerDisplaySnapshot } from './serialize';
import type { CalpokerOutcomeShape } from './outcome';
import { formatCalpokerAmount } from './formatting';

const Calpoker = lazy(() => import('./Calpoker'));

export interface CalpokerLiveMountProps {
  handSource: GameHandSource<import('./serialize').CalpokerHandState>;
  appendGameLog?: (line: string) => void;
  myName?: string;
  opponentName?: string;
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
    appendGameLog,
    myName,
    opponentName,
    handOrigin = 'fresh',
  } = props;
  const state = gameHandState(handSource);
  const hand = useCalpokerHand(handSource, handOrigin);
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (!appendGameLog) return;
      appendGameLog(`California Poker ${formatCalpokerAmount(state.perPlayerStake)}`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, state.perPlayerStake],
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
    const source = gameHandSourceFromMountView<import('./serialize').CalpokerHandState>(view);
    return (
      <CalpokerLiveMount
        handSource={source}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        handOrigin={view.handOrigin}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
