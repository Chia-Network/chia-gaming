import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import {
  terminalGameHandSource,
  type FrozenGameView,
  type GameHandSource,
  type GameMountRegistration,
  type GameplayEvent,
  type GameTerminalModel,
} from '../../host';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  handSource: GameHandSource;
  currentHandGameIds: string[];
  activeGameIds: string[];
  iProposedHand: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  terminalsById: Record<string, GameTerminalModel>;
  amountsById: Record<string, string>;
}

export function KrunkLiveMount(props: KrunkLiveMountProps) {
  const { appendGameLog, ...rest } = props;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog],
  );
  return <Krunk {...rest} onGameLog={handleGameLog} />;
}

export const krunkMountRegistration: GameMountRegistration = {
  renderLive(session, names) {
    return (
      <KrunkLiveMount
        key={session.handKey}
        handSource={session.handSource}
        currentHandGameIds={session.currentHandGameIds}
        activeGameIds={session.activeGameIds}
        iProposedHand={session.iProposedHand}
        gameplayEvent$={session.gameplayEvent$}
        betSize={session.currentHandAmount}
        onTurnChanged={session.onTurnChanged}
        appendGameLog={session.appendGameLog}
        terminalsById={session.gameSpecificView.terminalsById}
        amountsById={session.gameSpecificView.amountsById}
        {...names}
      />
    );
  },
  renderFrozen(view: FrozenGameView, options) {
    return (
      <KrunkLiveMount
        handSource={terminalGameHandSource(view.handState)}
        currentHandGameIds={[...view.currentHandIds]}
        activeGameIds={[...view.activeIds]}
        iProposedHand={view.iProposedHand}
        gameplayEvent$={EMPTY}
        betSize={view.lastTerms.myContribution}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        terminalsById={Object.fromEntries(
          Object.entries(view.instances).map(([id, instance]) => [id, instance.terminal]),
        )}
        amountsById={Object.fromEntries(
          Object.entries(view.instances).map(([id, instance]) => [id, instance.amount]),
        )}
        myName={options.myName}
        opponentName={options.opponentName}
      />
    );
  },
};
