import type { ReactElement } from 'react';
import { EMPTY } from 'rxjs';
import { CalpokerLiveMount, type CalpokerLiveMountProps } from '../features/calPoker/LiveMount';
import { KrunkLiveMount, type KrunkLiveMountProps } from '../features/krunk/LiveMount';
import {
  SpacepokerLiveMount,
  type SpacepokerLiveMountProps,
} from '../features/spacePoker/LiveMount';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionController } from '../hooks/SessionController';
import type { SessionModel } from './session/model';
export { GAME_MOUNT_TYPES, hasGameMount } from './gameMountRegistryCore';

export type GameMountRequest =
  | { gameType: 'calpoker'; props: CalpokerLiveMountProps }
  | { gameType: 'spacepoker'; props: SpacepokerLiveMountProps }
  | { gameType: 'krunk'; props: KrunkLiveMountProps };

export function renderGameMount(request: GameMountRequest): ReactElement {
  switch (request.gameType) {
    case 'calpoker':
      return <CalpokerLiveMount {...request.props} />;
    case 'spacepoker':
      return <SpacepokerLiveMount {...request.props} />;
    case 'krunk':
      return <KrunkLiveMount {...request.props} />;
  }
}

export function liveGameMountRequest(
  session: UseGameSessionResult,
  names: { myName?: string; opponentName?: string },
): GameMountRequest {
  const common = {
    gameObject: session.sessionController,
    gameplayEvent$: session.gameplayEvent$,
    onTurnChanged: session.onTurnChanged,
    appendGameLog: session.appendGameLog,
    ...names,
  };
  const gameId = session.activeGameId ?? session.gameSpecificView.displayGameId ?? '';
  switch (session.gameSpecificView.gameType) {
    case 'calpoker':
      return {
        gameType: 'calpoker',
        props: {
          ...common,
          gameId,
          iStarted: session.iStarted,
          playerNumber: session.playerNumber,
          onOutcome: session.onHandOutcome,
          perGameAmount: session.currentHandAmount,
          terminal: session.gameSpecificView.terminal,
        },
      };
    case 'spacepoker': {
      const terms = session.lastHandTerms;
      if (terms.gameType !== 'spacepoker') {
        throw new Error('Space Poker session is missing Space Poker terms');
      }
      return {
        gameType: 'spacepoker',
        props: {
          ...common,
          gameId,
          iStarted: session.iStarted,
          terms,
          initialPersistedState: session.gameSpecificView.handState ?? undefined,
          terminal: session.gameSpecificView.terminal,
        },
      };
    }
    case 'krunk':
      return {
        gameType: 'krunk',
        props: {
          ...common,
          currentHandGameIds: session.currentHandGameIds,
          activeGameIds: session.activeGameIds,
          iProposedHand: session.iProposedHand,
          betSize: session.currentHandAmount,
          initialPersistedState: session.gameSpecificView.handState ?? undefined,
          terminalsById: session.gameSpecificView.terminalsById,
        },
      };
  }
}

export function frozenGameMountRequest(
  model: SessionModel,
  gameObject: SessionController,
  options: {
    myName?: string;
    opponentName?: string;
    iStarted: boolean;
    iProposedHand: boolean;
  },
): GameMountRequest {
  const gameType = model.game.handState?.gameType ?? model.game.activeGameType;
  const gameId =
    model.game.lastDisplayedId ??
    model.game.currentHandIds[0] ??
    model.game.activeIds[0] ??
    'finished';
  const common = {
    gameObject,
    gameplayEvent$: EMPTY,
    onTurnChanged: (_gameId: string, _isMyTurn: boolean) => {},
    appendGameLog: (_line: string) => {},
    myName: options.myName,
    opponentName: options.opponentName,
  };
  switch (gameType) {
    case 'calpoker':
      return {
        gameType,
        props: {
          ...common,
          gameId,
          iStarted: options.iStarted,
          playerNumber: options.iStarted ? 1 : 2,
          onOutcome: () => {},
          perGameAmount: model.betweenHand.lastTerms.myContribution,
          terminal:
            model.game.instances[gameId]?.terminal ?? sessionInitialTerminalForFinishedMount(),
        },
      };
    case 'spacepoker': {
      const terms = model.betweenHand.lastTerms;
      if (terms.gameType !== 'spacepoker') {
        throw new Error('Finished Space Poker session is missing Space Poker terms');
      }
      return {
        gameType,
        props: {
          ...common,
          gameId,
          iStarted: options.iStarted,
          terms,
          initialPersistedState: model.game.handState ?? undefined,
          terminal:
            model.game.instances[gameId]?.terminal ?? sessionInitialTerminalForFinishedMount(),
        },
      };
    }
    case 'krunk':
      return {
        gameType,
        props: {
          ...common,
          currentHandGameIds: model.game.currentHandIds,
          activeGameIds: model.game.activeIds,
          iProposedHand: options.iProposedHand,
          betSize: model.betweenHand.lastTerms.myContribution,
          initialPersistedState: model.game.handState ?? undefined,
          terminalsById: Object.fromEntries(
            Object.entries(model.game.instances).map(([id, instance]) => [id, instance.terminal]),
          ),
        },
      };
    default:
      throw new Error(`Unsupported game mount: ${gameType}`);
  }
}

function sessionInitialTerminalForFinishedMount() {
  return {
    type: 'none' as const,
    outcome: null,
    label: null,
    myReward: null,
    rewardCoinHex: null,
  };
}
