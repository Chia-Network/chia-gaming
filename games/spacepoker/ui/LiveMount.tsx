import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import {
  EMPTY_GAME_TERMINAL_MODEL,
  terminalGameHandSource,
  type FrozenGameView,
  type GameHandSource,
  type GameMountRegistration,
  type GameplayEvent,
  type GameTerminalModel,
  type HandTermsModel,
} from '../../host';
import { useGameHost } from '../../host/ui';
import { spacepokerTermsOf } from './unitSize';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  handSource: GameHandSource;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  terms: HandTermsModel;
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
  const { formatAmount } = useGameHost();
  const space = spacepokerTermsOf(terms);
  if (!space) {
    throw new Error('Space Poker mount requires one canonical positive unit size');
  }
  const unitSizeMojosValue = space.unitSizeMojos;
  const stackSize = terms.myContribution / unitSizeMojosValue;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const handleGameLog = useCallback(
    (lines: string[]) => {
      appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitSizeMojosValue)})`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, formatAmount, stackSize, unitSizeMojosValue],
  );

  return (
    <SpacePoker
      handSource={handSource}
      gameId={gameId}
      iStarted={iStarted}
      gameplayEvent$={gameplayEvent$}
      betSize={terms.myContribution.toString()}
      unitSizeMojos={unitSizeMojosValue.toString()}
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
    if (terms === null || terms.gameType !== 'spacepoker') {
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
  renderFrozen(view: FrozenGameView, options) {
    const terms = view.lastTerms;
    if (terms.gameType !== 'spacepoker') {
      throw new Error('Finished Space Poker session is missing Space Poker terms');
    }
    const gameId = view.lastDisplayedId ?? view.currentHandIds[0] ?? view.activeIds[0] ?? 'finished';
    return (
      <SpacepokerLiveMount
        handSource={terminalGameHandSource(view.handState)}
        gameId={gameId}
        iStarted={options.iStarted}
        gameplayEvent$={EMPTY}
        terms={terms}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        terminal={view.instances[gameId]?.terminal ?? EMPTY_GAME_TERMINAL_MODEL}
        myName={options.myName}
        opponentName={options.opponentName}
      />
    );
  },
};
