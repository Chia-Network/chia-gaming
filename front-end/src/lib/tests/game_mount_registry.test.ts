import { type GameMountView, type LiveGamePort } from '@games/host';
import { Program } from 'clvm-lib';
import type { UseGameSessionResult } from '../../hooks/useGameSession';
import {
  createRegisteredGameHand,
  isCatalogGameType,
  packageFor,
  restoreRegisteredGameHandState,
} from '../gameRegistry';
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
  const handProposal =
    gameType === 'spacepoker'
      ? {
          gameType,
          senderIsPlayerA: false,
          gameTimeout: 15n,
          parameters: [10n, 10n],
        }
      : {
          gameType,
          senderIsPlayerA: gameType === 'krunk',
          gameTimeout: 15n,
          parameters: 100n,
        };
  const hand = createRegisteredGameHand(gameType, {
    members: ids.map((_, index) => ({
      playerAContribution: gameType === 'krunk' ? (index === 0 ? 100n : 0n) : 100n,
      playerBContribution: gameType === 'krunk' ? (index === 0 ? 0n : 100n) : 100n,
      ourTurn: gameType === 'krunk' ? index === 0 : true,
      readableParameters:
        gameType === 'spacepoker'
          ? Program.fromList([Program.fromBigInt(10n), Program.fromBigInt(10n)])
          : Program.fromBigInt(100n),
    })),
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
        hand: restoreRegisteredGameHandState(gameType, model.game.handState!),
      };
      const live: GameMountView = {
        ...common,
        frozen: false,
        port,
        appendGameLog: jest.fn(),
      };
      const frozen: GameMountView = { ...common, frozen: true };

      expect(() => packageFor(gameType).render(live)).not.toThrow();
      expect(() => packageFor(gameType).render(frozen)).not.toThrow();
      expect(live.port).toBe(port);
      expect(frozen).not.toHaveProperty('port');
    },
  );

  it('passes the current machine snapshot and host-owned hand key to a live mount', () => {
    const base = modelFor('calpoker');
    const model = createSessionModel(base);
    const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
    const session = {
      sessionModel: model,
      handKey: 7,
      iStarted: true,
      playerNumber: 1,
      handSource: {
        frozen: false,
        hand: createRegisteredGameHand('calpoker', {
          members: [
            {
              playerAContribution: 100n,
              playerBContribution: 100n,
              ourTurn: true,
              readableParameters: Program.fromBigInt(100n),
            },
          ],
        }),
        port,
      },
      appendGameLog: jest.fn(),
      gameSpecificView: { gameType: 'calpoker' },
    } as unknown as UseGameSessionResult;

    const mount = renderLiveGameMount(session, {});

    expect(mount.key).toBe('7');
    expect(mount.props.view.hand.getState()).toEqual(model.game.handState?.state);
    expect(mount.props.view.frozen).toBe(false);
    expect(mount.props.gameId).toBeUndefined();
  });

  it('cold-restores a frozen mount without protocol capabilities', () => {
    const model = modelFor('calpoker');
    const mount = renderFrozenGameMount(model, {});

    expect(mount.key).toBe('7');
    expect(mount.props.view.frozen).toBe(true);
    expect(mount.props.view).not.toHaveProperty('port');
  });
});
