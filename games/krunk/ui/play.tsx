import { lazy, useCallback } from 'react';
import {
  gameHandSourceFromMountView,
  type GameHandSource,
  type GameMountRegistration,
  type GameTerminalModel,
} from '../../host';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  handSource: GameHandSource;
  currentHandGameIds: string[];
  activeGameIds: string[];
  appendGameLog?: (line: string) => void;
  myName?: string;
  opponentName?: string;
  terminalsById: Record<string, GameTerminalModel>;
  amountsById: Record<string, string>;
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
        handSource={gameHandSourceFromMountView(view)}
        currentHandGameIds={[...view.currentHandIds]}
        activeGameIds={[...view.activeIds]}
        appendGameLog={view.frozen ? undefined : view.appendGameLog}
        terminalsById={Object.fromEntries(
          Object.entries(view.instances).map(([id, instance]) => [id, instance.terminal]),
        )}
        amountsById={Object.fromEntries(
          Object.entries(view.instances).map(([id, instance]) => [id, instance.amount]),
        )}
        myName={view.myName}
        opponentName={view.opponentName}
      />
    );
  },
};
