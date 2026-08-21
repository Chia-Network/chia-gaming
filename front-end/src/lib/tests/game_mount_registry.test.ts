import {
  gameHandSourceFromMountView,
  gameHandState,
  requireLiveGameHandSource,
  type GameMountView,
  type LiveGamePort,
} from '@games/host';
import type { UseGameSessionResult } from '../../hooks/useGameSession';
import { isCatalogGameType, packageFor } from '../gameRegistry';
import { renderFrozenGameMount, renderLiveGameMount } from '../gameMountRegistry';
import { createSessionModel } from '../session/model';

const terminal = {
  type: 'none' as const,
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

function modelFor(gameType: 'calpoker' | 'spacepoker' | 'krunk') {
  const ids = gameType === 'krunk' ? ['1', '2'] : ['1'];
  return createSessionModel({
    game: {
      handKey: 7,
      currentHandIds: ids,
      activeIds: ids,
      lastDisplayedId: '1',
      activeGameType: gameType,
      handState: { gameType, version: 1n, state: {} },
      instances: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            amount: '100',
            coinHex: null,
            presentation: 'off-chain-my-turn' as const,
            terminal,
          },
        ]),
      ),
    },
  });
}

describe('game mount registry', () => {
  it('recognizes only generated production packages', () => {
    expect(isCatalogGameType('calpoker')).toBe(true);
    expect(isCatalogGameType('spacepoker')).toBe(true);
    expect(isCatalogGameType('krunk')).toBe(true);
    expect(isCatalogGameType('debug')).toBe(false);
  });

  it.each(['calpoker', 'spacepoker', 'krunk'] as const)(
    'uses one boolean-discriminated render contract for %s',
    (gameType) => {
      const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
      const model = modelFor(gameType);
      const common = {
        handOrigin: 'fresh' as const,
        handState: model.game.handState,
        lastDisplayedId: model.game.lastDisplayedId,
        activeIds: model.game.activeIds,
        currentHandIds: model.game.currentHandIds,
        canActById: Object.fromEntries(model.game.currentHandIds.map((id) => [id, true])),
        iStarted: true,
        playerNumber: 1,
        instances: Object.fromEntries(
          Object.entries(model.game.instances).map(([id, instance]) => [
            id,
            { amount: instance.amount, terminal: instance.terminal },
          ]),
        ),
      };
      const live: GameMountView = {
        ...common,
        frozen: false,
        port,
        appendGameLog: jest.fn(),
      };
      const frozen: GameMountView = { ...common, frozen: true, handOrigin: 'terminal' };

      expect(() => packageFor(gameType).render(live)).not.toThrow();
      expect(() => packageFor(gameType).render(frozen)).not.toThrow();
      expect(requireLiveGameHandSource(gameHandSourceFromMountView(live))).toBe(port);
      expect(() => requireLiveGameHandSource(gameHandSourceFromMountView(frozen))).toThrow(
        'Protocol commands require a live game hand source',
      );
    },
  );

  it('passes the current machine snapshot and host-owned hand key to a live mount', () => {
    const model = modelFor('calpoker');
    const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
    const session = {
      sessionModel: model,
      handKey: 7,
      handOrigin: 'fresh',
      iStarted: true,
      playerNumber: 1,
      handSource: { interactionMode: 'live', handState: model.game.handState, port },
      appendGameLog: jest.fn(),
      gameSpecificView: { gameType: 'calpoker' },
    } as unknown as UseGameSessionResult;

    const mount = renderLiveGameMount(session, {});

    expect(mount.key).toBe('7');
    expect(gameHandState(mount.props.handSource)).toBe(model.game.handState);
    expect(mount.props.handSource.interactionMode).toBe('live');
  });

  it('cold-restores a frozen mount without protocol capabilities', () => {
    const model = modelFor('calpoker');
    const mount = renderFrozenGameMount(model, { iStarted: false });

    expect(mount.key).toBe('7');
    expect(mount.props.handSource.interactionMode).toBe('terminal');
    expect(() => requireLiveGameHandSource(mount.props.handSource)).toThrow(
      'Protocol commands require a live game hand source',
    );
  });
});
