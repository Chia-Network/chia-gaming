import { lazy, useCallback } from 'react';
import {
  type GameMountRegistration,
  type GameMountView,
} from '../../host';
import type { SpacepokerHand } from './serialize';
import { formatSpacepokerAmount } from './formatting';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  view: GameMountView<SpacepokerHand>;
}

export function SpacepokerLiveMount(props: SpacepokerLiveMountProps) {
  const { view } = props;
  const handState = view.hand.getState();
  const betSize = handState.perPlayerStake * 2n;
  const unitSizeMojosValue = handState.unitSizeMojos;
  const stackSize = betSize / 2n / unitSizeMojosValue;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (view.frozen) return;
      view.appendGameLog(
        `Space Poker ${stackSize} (${formatSpacepokerAmount(unitSizeMojosValue)})`,
      );
      lines.forEach(view.appendGameLog);
      view.appendGameLog('');
    },
    [view, stackSize, unitSizeMojosValue],
  );

  return (
    <SpacePoker
      view={view}
      onGameLog={handleGameLog}
    />
  );
}

export const play: GameMountRegistration<SpacepokerHand> = {
  render(view) {
    return <SpacepokerLiveMount view={view} />;
  },
};
