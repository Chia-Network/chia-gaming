import { lazy, useCallback } from 'react';
import { type GameMountRegistration, type GameMountView } from '../../host';
import type { KrunkHand } from './serialize';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  view: GameMountView<KrunkHand>;
}

export function KrunkLiveMount(props: KrunkLiveMountProps) {
  const { view } = props;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (view.frozen) return;
      lines.forEach(view.appendGameLog);
      view.appendGameLog('');
    },
    [view],
  );
  return <Krunk view={view} onGameLog={handleGameLog} />;
}

export const play: GameMountRegistration<KrunkHand> = {
  render(view) {
    return <KrunkLiveMount view={view} />;
  },
};
