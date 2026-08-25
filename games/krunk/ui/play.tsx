import { lazy, useCallback } from 'react';
import { type GameHandSource, type GameMountRegistration } from '../../host';
import type { KrunkHand, KrunkHandState } from './serialize';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  handSource: GameHandSource<KrunkHandState, KrunkHand>;
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

export const play: GameMountRegistration<KrunkHand> = {
  render(view) {
    const handSource: GameHandSource<KrunkHandState, KrunkHand> = view.frozen
      ? { interactionMode: 'terminal', hand: view.hand }
      : { interactionMode: 'live', hand: view.hand, port: view.port };
    return (
      <KrunkLiveMount
        handSource={handSource}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
