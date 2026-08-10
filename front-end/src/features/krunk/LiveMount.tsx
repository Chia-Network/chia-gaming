import { lazy, useCallback } from 'react';
import { EMPTY, type Observable } from 'rxjs';
import type { SessionController } from '../../hooks/SessionController';
import type { GameplayEvent } from '../../hooks/useGameSession';
import type { GameInteractionMode, GameMountRegistration } from '../../lib/gameMount';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { GameTerminalModel } from '../../lib/session/types';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  gameObject: SessionController;
  currentHandGameIds: string[];
  activeGameIds: string[];
  iProposedHand: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  initialPersistedState?: PersistedGameState;
  terminalsById: Record<string, GameTerminalModel>;
  amountsById: Record<string, string>;
  interactionMode?: GameInteractionMode;
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
        gameObject={session.sessionController}
        currentHandGameIds={session.currentHandGameIds}
        activeGameIds={session.activeGameIds}
        iProposedHand={session.iProposedHand}
        gameplayEvent$={session.gameplayEvent$}
        betSize={session.currentHandAmount}
        onTurnChanged={session.onTurnChanged}
        appendGameLog={session.appendGameLog}
        initialPersistedState={session.gameSpecificView.handState ?? undefined}
        terminalsById={session.gameSpecificView.terminalsById}
        amountsById={session.gameSpecificView.amountsById}
        interactionMode={session.interactionMode}
        {...names}
      />
    );
  },
  renderFrozen(model, gameObject, options) {
    return (
      <KrunkLiveMount
        gameObject={gameObject}
        currentHandGameIds={model.game.currentHandIds}
        activeGameIds={model.game.activeIds}
        iProposedHand={options.iProposedHand}
        gameplayEvent$={EMPTY}
        betSize={model.betweenHand.lastTerms.myContribution}
        onTurnChanged={() => {}}
        appendGameLog={() => {}}
        initialPersistedState={model.game.handState ?? undefined}
        terminalsById={Object.fromEntries(
          Object.entries(model.game.instances).map(([id, instance]) => [id, instance.terminal]),
        )}
        amountsById={Object.fromEntries(
          Object.entries(model.game.instances).map(([id, instance]) => [id, instance.amount]),
        )}
        interactionMode="terminal"
        myName={options.myName}
        opponentName={options.opponentName}
      />
    );
  },
};
