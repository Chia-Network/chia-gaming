import type { SessionSave } from '../../hooks/save';
import {
  createSessionModel,
  INITIAL_GAME_TERMINAL_MODEL,
  selectDisplayedGameInstance,
  selectGameSessionView,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';

describe('session model round trips', () => {
  it('normalizes restored notification ids to bigint', () => {
    const save = {
      version: 11n,
      playerId: 'p1',
      activeGameIds: [],
      channelNotifQueue: [{ id: 7, kind: 'channel-state', title: 'Channel', message: 'Ready' }],
      gameNotifQueue: [{ id: '8', kind: 'game-terminal', title: 'Game', message: 'Done' }],
    } as unknown as SessionSave;

    const restored = sessionModelFromSave(save);

    expect(restored.channel.queue[0].id).toBe(7n);
    expect(restored.game.queue[0].id).toBe(8n);
  });

  it('round-trips keyed hand status without aggregate snapshot fields', () => {
    const model = createSessionModel({
      game: {
        activeIds: ['7'],
        currentHandIds: ['7'],
        lastDisplayedId: '7',
        instances: {
          '7': {
            id: '7',
            amount: '100',
            handStatus: 'playing-move',
            coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot).not.toHaveProperty('gameHandStatus');
    expect(snapshot).not.toHaveProperty('gameCoinHex');
    expect(snapshot).not.toHaveProperty('gameTurnState');
    expect(snapshot).not.toHaveProperty('gameOnChain');
    expect(snapshot).not.toHaveProperty('gameTerminalType');

    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: snapshot.activeGameIds ?? [],
      currentHandGameIds: snapshot.currentHandGameIds,
      lastDisplayedGameId: snapshot.lastDisplayedGameId,
      gameInstances: snapshot.gameInstances,
      activeGameType: snapshot.activeGameType,
      betweenHandLastTerms: snapshot.betweenHandLastTerms,
    });
    expect(restored.game.instances['7'].presentation).toBe('playing-move');
    expect(selectDisplayedGameInstance(restored)?.coin.turnState).toBe('playing-on-chain');
  });

  it('round-trips per-game on-chain markers through session snapshots', () => {
    const model = createSessionModel({
      game: {
        activeIds: ['7'],
        currentHandIds: ['7'],
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: null, turnState: 'their-turn', onChain: true },
            handStatus: 'their-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: snapshot.activeGameIds ?? [],
      currentHandGameIds: snapshot.currentHandGameIds,
      lastDisplayedGameId: snapshot.lastDisplayedGameId,
      gameInstances: snapshot.gameInstances,
      activeGameType: snapshot.activeGameType,
      betweenHandLastTerms: snapshot.betweenHandLastTerms,
    });

    expect(restored.game.instances['7'].presentation).toBe('on-chain-their-turn');
  });

  it('round-trips current-hand game instances through session snapshots', () => {
    const model = createSessionModel({
      game: {
        currentHandIds: ['7', '9'],
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: 'aaaa', turnState: 'my-turn', onChain: true },
            handStatus: 'our-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
          '9': {
            id: '9',
            amount: '100',
            coin: { coinHex: null, turnState: 'ended' },
            handStatus: 'ended',
            terminal: {
              type: 'settled',
              outcome: 'settled_cleanly',
              label: 'Settled cleanly',
              myReward: '80',
              rewardCoinHex: null,
            },
          },
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: snapshot.activeGameIds ?? [],
      currentHandGameIds: snapshot.currentHandGameIds,
      gameInstances: snapshot.gameInstances,
      activeGameType: snapshot.activeGameType,
      betweenHandLastTerms: snapshot.betweenHandLastTerms,
    });

    expect(restored.game.currentHandIds).toEqual(['7', '9']);
    expect(restored.game.instances).toEqual(model.game.instances);
  });

  it('rejects an incomplete keyed save', () => {
    expect(() =>
      sessionModelFromSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: ['7'],
        currentHandGameIds: ['7'],
        activeGameType: 'calpoker',
      }),
    ).toThrow('game 7 is missing its keyed instance');
  });

  it('rejects malformed persisted game discriminants instead of casting them', () => {
    expect(() =>
      sessionModelFromSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: ['7'],
        currentHandGameIds: ['7'],
        gameInstances: {
          '7': {
            id: '7',
            amount: '20',
            coinHex: null,
            presentation: 'bogus-presentation' as never,
            terminal: {
              type: 'none',
              label: null,
              myReward: null,
              rewardCoinHex: null,
            },
          },
        },
        activeGameType: 'calpoker',
      }),
    ).toThrow('invalid gameInstances.7.presentation');
  });

  it('round-trips active and terminal display instances from the full keyed union', () => {
    const active = {
      id: 'active',
      amount: '20',
      coin: { coinHex: 'active-coin', turnState: 'my-turn' as const },
      handStatus: 'active' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    const terminal = {
      id: 'terminal',
      amount: '20',
      coin: { coinHex: null, turnState: 'ended' as const },
      handStatus: 'ended' as const,
      terminal: {
        type: 'settled' as const,
        outcome: 'settled_cleanly' as const,
        label: 'Settled cleanly',
        myReward: '20',
        rewardCoinHex: null,
      },
    };
    const historical = { ...active, id: 'historical', coin: { ...active.coin, coinHex: 'old' } };
    const model = createSessionModel({
      game: {
        activeIds: ['active'],
        currentHandIds: ['active', 'historical'],
        instances: { active, historical, terminal },
        lastDisplayedId: 'terminal',
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(Object.keys(snapshot.gameInstances ?? {})).toEqual(['active', 'historical', 'terminal']);
    expect(snapshot.lastDisplayedGameId).toBe('terminal');
    expect(snapshot).not.toHaveProperty('gameCoinHex');
    expect(snapshot).not.toHaveProperty('gameTerminalType');

    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: snapshot.activeGameIds,
      currentHandGameIds: snapshot.currentHandGameIds,
      lastDisplayedGameId: snapshot.lastDisplayedGameId,
      gameInstances: snapshot.gameInstances,
      activeGameType: snapshot.activeGameType,
      betweenHandLastTerms: snapshot.betweenHandLastTerms,
    });
    expect(restored.game.lastDisplayedId).toBe('terminal');
    expect(restored.game.instances).toEqual(model.game.instances);
    expect(selectGameSessionView(restored).displayGameId).toBe('active');

    const completed = createSessionModel({
      game: { ...restored.game, activeIds: [] },
    });
    expect(selectGameSessionView(completed)).toMatchObject({
      displayGameId: 'terminal',
      gameTerminal: { type: 'settled', label: 'Settled cleanly' },
    });
  });

  it('rejects an invalid saved display id instead of selecting unrelated state', () => {
    const snapshot = snapshotFromSessionModel(
      createSessionModel({
        game: {
          activeIds: ['9', '7'],
          currentHandIds: ['9', '7'],
          instances: {
            '9': {
              id: '9',
              amount: '20',
              coin: { coinHex: null, turnState: 'their-turn' },
              handStatus: 'active',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
            '7': {
              id: '7',
              amount: '20',
              coin: { coinHex: null, turnState: 'my-turn' },
              handStatus: 'active',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          },
          lastDisplayedId: '7',
        },
      }),
    );
    expect(() =>
      sessionModelFromSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: snapshot.activeGameIds,
        currentHandGameIds: snapshot.currentHandGameIds,
        lastDisplayedGameId: 'missing',
        gameInstances: snapshot.gameInstances,
        activeGameType: snapshot.activeGameType,
      }),
    ).toThrow('game missing is missing its keyed instance');
  });
});
