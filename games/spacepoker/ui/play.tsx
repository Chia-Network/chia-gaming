import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import {
  EMPTY_GAME_TERMINAL_MODEL,
  gameHandState,
  terminalGameHandSource,
  type FrozenGameView,
  type GameHandSource,
  type GameMountRegistration,
  type GameplayEvent,
  type GameTerminalModel,
} from '../../host';
import { useGameHost } from '../../host/ui';
import { spacepokerStateCodec } from './serialize';

const SpacePoker = lazy(() => import('./SpacePoker'));

function amountForGame(amountsById: Record<string, string>, gameId: string): bigint {
  const amount = amountsById[gameId];
  if (amount === undefined) {
    throw new Error(`Space Poker is missing the accepted amount for game ${gameId}`);
  }
  return BigInt(amount);
}

export interface SpacepokerLiveMountProps {
  handSource: GameHandSource;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
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
    betSize,
    onTurnChanged,
    appendGameLog,
    myName,
    opponentName,
    terminal,
  } = props;
  const { formatAmount } = useGameHost();
  const handState = spacepokerStateCodec.decode(gameHandState(handSource));
  if (!handState) {
    throw new Error('Space Poker mount requires initialized durable game state');
  }
  const unitSizeMojosValue = handState.unitSizeMojos;
  const stackSize = betSize / unitSizeMojosValue;
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
      betSize={betSize.toString()}
      unitSizeMojos={unitSizeMojosValue.toString()}
      onTurnChanged={handleTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      terminal={terminal}
    />
  );
}

export const play: GameMountRegistration = {
  renderLive(session, names) {
    const gameId = session.activeGameId ?? session.gameSpecificView.displayGameId ?? '';
    return (
      <SpacepokerLiveMount
        handSource={session.handSource}
        gameId={gameId}
        iStarted={session.iStarted}
        gameplayEvent$={session.gameplayEvent$}
        betSize={amountForGame(session.gameSpecificView.amountsById, gameId)}
        onTurnChanged={session.onTurnChanged}
        appendGameLog={session.appendGameLog}
        terminal={session.gameSpecificView.terminal}
        {...names}
      />
    );
  },
  renderFrozen(view: FrozenGameView, options) {
    const gameId = view.lastDisplayedId ?? view.currentHandIds[0] ?? view.activeIds[0] ?? 'finished';
    const amount = view.instances[gameId]?.amount;
    if (amount === undefined) {
      throw new Error(`Space Poker is missing the accepted amount for game ${gameId}`);
    }
    return (
      <SpacepokerLiveMount
        handSource={terminalGameHandSource(view.handState)}
        gameId={gameId}
        iStarted={options.iStarted}
        gameplayEvent$={EMPTY}
        betSize={BigInt(amount)}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        terminal={view.instances[gameId]?.terminal ?? EMPTY_GAME_TERMINAL_MODEL}
        myName={options.myName}
        opponentName={options.opponentName}
      />
    );
  },
};
