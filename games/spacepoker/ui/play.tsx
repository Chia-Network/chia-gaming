import { lazy, useCallback } from 'react';
import {
  gameHandState,
  gameHandSourceFromMountView,
  type GameHandSource,
  type GameMountRegistration,
} from '../../host';
import type { SpacepokerHandState } from './serialize';
import { formatSpacepokerAmount } from './formatting';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  handSource: GameHandSource<SpacepokerHandState>;
  appendGameLog?: (line: string) => void;
  myName?: string;
  opponentName?: string;
}

export function SpacepokerLiveMount(props: SpacepokerLiveMountProps) {
  const { handSource, appendGameLog, myName, opponentName } = props;
  const handState = gameHandState(handSource);
  const betSize = handState.perPlayerStake * 2n;
  const unitSizeMojosValue = handState.unitSizeMojos;
  const stackSize = betSize / 2n / unitSizeMojosValue;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (!appendGameLog) return;
      appendGameLog(`Space Poker ${stackSize} (${formatSpacepokerAmount(unitSizeMojosValue)})`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, stackSize, unitSizeMojosValue],
  );

  return (
    <SpacePoker
      handSource={handSource}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
    />
  );
}

export const play: GameMountRegistration = {
  render(view) {
    return (
      <SpacepokerLiveMount
        handSource={gameHandSourceFromMountView<SpacepokerHandState>(view)}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
