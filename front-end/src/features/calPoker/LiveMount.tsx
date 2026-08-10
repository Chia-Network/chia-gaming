import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import type { SessionController } from '../../hooks/SessionController';
import type { GameplayEvent } from '../../hooks/useGameSession';
import type {
  GameHandOrigin,
  GameInteractionMode,
  GameMountRegistration,
} from '../../lib/gameMount';
import { formatAmount } from '../../util';
import type {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from './types/CaliforniapokerProps';
import { useCalpokerHand } from './useCalpokerHand';
import type { CalpokerDisplaySnapshot } from './stateCodec';
import type { CalpokerOutcome } from './outcome';
import type { GameTerminalModel } from '../../lib/session/types';

const Calpoker = lazy(() => import('./index'));

export interface CalpokerLiveMountProps {
  gameObject: SessionController;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  gameplayEvent$: Observable<GameplayEvent>;
  onOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
  interactionMode?: GameInteractionMode;
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

export function CalpokerLiveMount(props: CalpokerLiveMountProps) {
  const {
    gameObject,
    gameId,
    iStarted,
    playerNumber,
    gameplayEvent$,
    onOutcome,
    onTurnChanged,
    appendGameLog,
    perGameAmount,
    myName,
    opponentName,
    terminal,
    interactionMode = 'live',
    handOrigin = 'fresh',
  } = props;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const hand = useCalpokerHand(
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    onOutcome,
    handleTurnChanged,
    terminal,
    gameObject.handState ?? undefined,
    interactionMode === 'live',
    handOrigin,
  );
  const handleGameLog = useCallback(
    (lines: string[]) => {
      appendGameLog(`California Poker ${formatAmount(perGameAmount)}`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, perGameAmount],
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
      handleNerf={hand.handleNerf}
      onGameLog={handleGameLog}
      onSnapshotChange={(snapshot) => hand.saveDisplaySnapshot(snapshotModel(snapshot))}
      initialSnapshot={snapshotView(hand.initialDisplaySnapshot)}
      myName={myName}
      opponentName={opponentName}
      terminalOutcome={hand.terminalOutcome}
      interactionMode={interactionMode}
    />
  );
}

export const calpokerMountRegistration: GameMountRegistration = {
  renderLive(session, names) {
    const gameId = session.activeGameId ?? session.gameSpecificView.displayGameId ?? '';
    return (
      <CalpokerLiveMount
        key={session.handKey}
        gameObject={session.sessionController}
        gameId={gameId}
        iStarted={session.iStarted}
        playerNumber={session.playerNumber}
        gameplayEvent$={session.gameplayEvent$}
        onOutcome={session.onHandOutcome}
        onTurnChanged={session.onTurnChanged}
        appendGameLog={session.appendGameLog}
        perGameAmount={session.currentHandAmount}
        terminal={session.gameSpecificView.terminal}
        interactionMode={session.interactionMode}
        handOrigin={session.handOrigin}
        {...names}
      />
    );
  },
  renderFrozen(model, gameObject, options) {
    const gameId =
      model.game.lastDisplayedId ??
      model.game.currentHandIds[0] ??
      model.game.activeIds[0] ??
      'finished';
    return (
      <CalpokerLiveMount
        gameObject={gameObject}
        gameId={gameId}
        iStarted={options.iStarted}
        playerNumber={options.iStarted ? 1 : 2}
        gameplayEvent$={EMPTY}
        onOutcome={() => {}}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        perGameAmount={model.betweenHand.lastTerms.myContribution}
        terminal={model.game.instances[gameId]?.terminal ?? emptyFinishedTerminal()}
        interactionMode="terminal"
        handOrigin="terminal"
        myName={options.myName}
        opponentName={options.opponentName}
      />
    );
  },
};

function emptyFinishedTerminal(): GameTerminalModel {
  return {
    type: 'none',
    outcome: null,
    label: null,
    myReward: null,
    rewardCoinHex: null,
  };
}
