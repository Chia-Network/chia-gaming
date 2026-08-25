import { lazy, useCallback } from 'react';
import {
  gameHandSourceFromMountView,
  type GameHandSource,
  type GameMountRegistration,
} from '../../host';
import type { KrunkHandState } from './serialize';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  handSource: GameHandSource<KrunkHandState>;
  appendGameLog?: (line: string) => void;
  myName?: string;
  opponentName?: string;
}

export function KrunkLiveMount(props: KrunkLiveMountProps) {
  const { appendGameLog, ...rest } = props;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      if (!appendGameLog) return;
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog],
  );
  return <Krunk {...rest} onGameLog={handleGameLog} />;
}

export const play: GameMountRegistration = {
  render(view) {
    return (
      <KrunkLiveMount
        handSource={gameHandSourceFromMountView<KrunkHandState>(view)}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
