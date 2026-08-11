import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import type { GameplayEvent } from '../../hooks/useGameSession';
import {
  gameHandState,
  terminalGameHandSource,
  type GameHandSource,
  type GameMountRegistration,
} from '../../lib/gameMount';
import type { HandTermsModel } from '../../lib/session/types';
import type { GameTerminalModel } from '../../lib/session/types';
import { formatAmount } from '../../util';
import { resolveSpacepokerUnitSize } from './unitSize';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  handSource: GameHandSource;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  terms: Extract<HandTermsModel, { gameType: 'spacepoker' }>;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
}

export function SpacepokerLiveMount(props: SpacepokerLiveMountProps) {
  const {
    handSource,
    gameId,
    iStarted,
    gameplayEvent$,
    terms,
    onTurnChanged,
    appendGameLog,
    myName,
    opponentName,
    terminal,
  } = props;
  const unitSizeMojos = resolveSpacepokerUnitSize({
    terms,
    persistedState: gameHandState(handSource) ?? undefined,
  });
  if (!unitSizeMojos) {
    throw new Error('Space Poker mount requires one canonical positive unit size');
  }
  const stackSize = terms.myContribution / unitSizeMojos;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const handleGameLog = useCallback(
    (lines: string[]) => {
      appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitSizeMojos)})`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, stackSize, unitSizeMojos],
  );

  return (
    <SpacePoker
      handSource={handSource}
      gameId={gameId}
      iStarted={iStarted}
      gameplayEvent$={gameplayEvent$}
      betSize={terms.myContribution.toString()}
      unitSizeMojos={unitSizeMojos.toString()}
      onTurnChanged={handleTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      terminal={terminal}
    />
  );
}

export const spacepokerMountRegistration: GameMountRegistration = {
  renderLive(session, names) {
    const terms = session.lastHandTerms;
    if (terms.gameType !== 'spacepoker') {
      throw new Error('Space Poker session is missing Space Poker terms');
    }
    return (
      <SpacepokerLiveMount
        key={session.handKey}
        handSource={session.handSource}
        gameId={session.activeGameId ?? session.gameSpecificView.displayGameId ?? ''}
        iStarted={session.iStarted}
        gameplayEvent$={session.gameplayEvent$}
        terms={terms}
        onTurnChanged={session.onTurnChanged}
        appendGameLog={session.appendGameLog}
        terminal={session.gameSpecificView.terminal}
        {...names}
      />
    );
  },
  renderFrozen(model, options) {
    const terms = model.betweenHand.lastTerms;
    if (terms.gameType !== 'spacepoker') {
      throw new Error('Finished Space Poker session is missing Space Poker terms');
    }
    const gameId =
      model.game.lastDisplayedId ??
      model.game.currentHandIds[0] ??
      model.game.activeIds[0] ??
      'finished';
    return (
      <SpacepokerLiveMount
        handSource={terminalGameHandSource(model.game.handState)}
        gameId={gameId}
        iStarted={options.iStarted}
        gameplayEvent$={EMPTY}
        terms={terms}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        terminal={model.game.instances[gameId]?.terminal ?? emptyFinishedTerminal()}
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
