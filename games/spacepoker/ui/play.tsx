import { lazy, useCallback } from 'react';
import {
  EMPTY_GAME_TERMINAL_MODEL,
  gameHandState,
  gameHandSourceFromMountView,
  type GameHandSource,
  type GameMountRegistration,
  type GameTerminalModel,
} from '../../host';
import { useGameHost } from '../../host/ui';
import type { SpacepokerHandState } from './serialize';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  handSource: GameHandSource<SpacepokerHandState>;
  gameId: string;
  betSize: bigint;
  appendGameLog?: (line: string) => void;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
}

export function SpacepokerLiveMount(props: SpacepokerLiveMountProps) {
  const { handSource, gameId, betSize, appendGameLog, myName, opponentName, terminal } = props;
  const { formatAmount } = useGameHost();
  const handState = gameHandState(handSource);
  const unitSizeMojosValue = handState.unitSizeMojos;
  const stackSize = betSize / 2n / unitSizeMojosValue;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (!appendGameLog) return;
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
      betSize={betSize.toString()}
      unitSizeMojos={unitSizeMojosValue.toString()}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      terminal={terminal}
    />
  );
}

export const play: GameMountRegistration = {
  render(view) {
    const gameId =
      view.activeIds[0] ?? view.lastDisplayedId ?? view.currentHandIds[0] ?? 'finished';
    const amount = view.instances[gameId]?.amount;
    if (amount === undefined) {
      throw new Error(`Space Poker is missing the accepted amount for game ${gameId}`);
    }
    return (
      <SpacepokerLiveMount
        handSource={gameHandSourceFromMountView<SpacepokerHandState>(view)}
        gameId={gameId}
        betSize={BigInt(amount)}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        terminal={view.instances[gameId]?.terminal ?? EMPTY_GAME_TERMINAL_MODEL}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
