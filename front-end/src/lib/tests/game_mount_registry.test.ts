import {
  gameHandSourceFromMountView,
  gameHandState,
  requireLiveGameHandSource,
  type GameMountView,
  type LiveGamePort,
} from '@games/host';
import type { UseGameSessionResult } from '../../hooks/useGameSession';
import { createRegisteredGameHand, isCatalogGameType, packageFor } from '../gameRegistry';
import { gameCanActById, renderFrozenGameMount, renderLiveGameMount } from '../gameMountRegistry';
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
  const handProposal =
    gameType === 'spacepoker'
      ? {
          gameType,
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
          unitSizeMojos: 10n,
        }
      : { gameType, myContribution: 100n, theirContribution: 100n, gameTimeout: 15n };
  const hand = createRegisteredGameHand(gameType, {
    id: ids[0],
    gameIds: ids,
    iStarted: true,
    canAct: true,
    origin: 'local',
    handProposal,
  });
  return createSessionModel({
    betweenHand: { lastHandProposal: handProposal },
    game: {
      handKey: 7,
      currentHandIds: ids,
      activeIds: ids,
      lastDisplayedId: '1',
      activeGameType: gameType,
      handState: { gameType, state: hand.getState() },
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
        hand: createRegisteredGameHand(
          gameType,
          {
            id: model.game.currentHandIds[0],
            gameIds: model.game.currentHandIds,
            iStarted: true,
            canAct: true,
            origin: 'local',
            handProposal: model.betweenHand.lastHandProposal!,
          },
          model.game.handState,
        ),
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
    const base = modelFor('calpoker');
    const model = createSessionModel({
      ...base,
      game: {
        ...base.game,
        pendingCandidates: {
          '1': {
            gameType: 'calpoker',
            id: '1',
            action: 'make_move',
            state: base.game.handState!.state,
          },
        },
      },
    });
    const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
    const session = {
      sessionModel: model,
      handKey: 7,
      handOrigin: 'fresh',
      iStarted: true,
      playerNumber: 1,
      handSource: {
        interactionMode: 'live',
        hand: createRegisteredGameHand(
          'calpoker',
          {
            id: '1',
            gameIds: ['1'],
            iStarted: true,
            canAct: true,
            origin: 'local',
            handProposal: model.betweenHand.lastHandProposal!,
          },
          model.game.handState,
        ),
        port,
      },
      appendGameLog: jest.fn(),
      gameSpecificView: { gameType: 'calpoker' },
    } as unknown as UseGameSessionResult;

    const mount = renderLiveGameMount(session, {});

    expect(mount.key).toBe('7');
    expect(gameHandState(mount.props.handSource)).toEqual(model.game.handState?.state);
    expect(mount.props.handSource.interactionMode).toBe('live');
    expect(gameCanActById(model)['1']).toBe(false);
  });

  it('cold-restores a frozen mount without protocol capabilities', () => {
    const model = modelFor('calpoker');
    const mount = renderFrozenGameMount(model, { iStarted: false });

    expect(mount.key).toBe('7');
    expect(mount.props.handSource.interactionMode).toBe('terminal');
  });
});
