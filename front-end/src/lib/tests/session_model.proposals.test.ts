import {
  createSessionModel,
  clearDerivedGamePresentation,
  normalizeSessionPresentation,
  channelStatusPayloadFromModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  isTerminalChannelSnapshot,
  selectGameDashboardView,
  selectGameSessionView,
  selectGameSpecificView,
  selectProposalGroupByMemberId,
  sessionModelFromSave,
  snapshotFromSessionModel,
  gameCoinIdentityForGameStatus,
  nextGameInstanceAfterLocalTurn,
  nextGamePresentationAfterLocalTurn,
  projectGameStatus,
} from '../session/model';
import type { SessionSave } from '../../hooks/save';
import { initialKrunkGameState, krunkStateCodec } from '@games/krunk/ui/serialize';
import { dispatchWasmNotification } from '../session/gameSessionEvents';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { baseSave, liveSave } from './session_save_envelope.fixtures';

function liveEnvelope(fields: Partial<SessionSave>): SessionSave {
  return liveSave({
    myContribution: '100',
    theirContribution: '100',
    perGameAmount: '10',
    ...(fields as unknown as Record<string, unknown>),
  });
}

describe('session model proposal and normalization contracts', () => {
  it.each([
    [
      'Calpoker singleton',
      {
        gameType: 'calpoker' as const,
        myContribution: 10n,
        theirContribution: 10n,
        gameTimeout: 15n,
      },
      ['cal-1'],
    ],
    [
      'Space Poker singleton',
      {
        gameType: 'spacepoker' as const,
        myContribution: 20n,
        theirContribution: 20n,
        gameTimeout: 16n,
        unitSizeMojos: 2n,
      },
      ['space-1'],
    ],
    [
      'Krunk ordered pair',
      {
        gameType: 'krunk' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 17n,
      },
      ['krunk-picker', 'krunk-guesser'],
    ],
  ])('round-trips a normalized %s proposal group', (_label, terms, memberIds) => {
    const model = createSessionModel({
      betweenHand: {
        proposalGroups: [
          {
            primaryId: memberIds[0],
            memberIds: [...memberIds],
            handProposal: terms,
            origin: 'local',
            disposition: 'outgoing',
          },
        ],
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave(
      liveEnvelope({ activeGameIds: [], proposalGroups: snapshot.proposalGroups }),
    );

    expect(restored.betweenHand.proposalGroups).toEqual(model.betweenHand.proposalGroups);
    for (const id of memberIds) {
      expect(selectProposalGroupByMemberId(restored, id)).toBe(
        restored.betweenHand.proposalGroups[0],
      );
    }
  });

  it('omits every deprecated parallel proposal ledger', () => {
    const model = createSessionModel();
    const betweenHand = model.betweenHand as unknown as Record<string, unknown>;
    const snapshot = snapshotFromSessionModel(model) as Record<string, unknown>;
    for (const field of [
      'cachedPeerProposal',
      'reviewPeerProposal',
      'outgoingProposalIds',
      'outgoingProposalGroupIds',
      'acceptedProposalGroupIds',
      'outgoingProposalTerms',
    ]) {
      expect(betweenHand).not.toHaveProperty(field);
    }
    for (const field of [
      'betweenHandCachedPeerProposal',
      'betweenHandReviewPeerProposal',
      'outgoingProposalGroupIds',
      'acceptedProposalGroupIds',
      'outgoingProposalTerms',
    ]) {
      expect(snapshot).not.toHaveProperty(field);
    }
  });

  it('retains generic group membership through acceptance until insufficient balance clears every member', () => {
    const terms = {
      gameType: 'krunk',
      myContribution: 100n,
      theirContribution: 100n,
      gameTimeout: 15n,
    } as const;
    const groupIds = ['11', '13'];
    const model = createSessionModel({
      betweenHand: {
        proposalGroups: [
          {
            primaryId: '11',
            memberIds: groupIds,
            handProposal: terms,
            origin: 'local',
            disposition: 'accepted',
          },
        ],
      },
    });
    expect(selectProposalGroupByMemberId(model, '11')).toBe(
      selectProposalGroupByMemberId(model, '13'),
    );
    expect(selectProposalGroupByMemberId(model, '13')).toMatchObject({
      memberIds: groupIds,
      handProposal: terms,
    });
  });

  it('round-trips accepted in-flight groups for a later insufficient-balance cleanup', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'krunk',
        activeIds: ['11', '13'],
        currentHandIds: ['11', '13'],
        currentHandOrigin: 'local',
        instances: {
          '11': {
            id: '11',
            amount: '20',
            coin: { coinHex: null, turnState: 'my-turn' },
            handStatus: 'active',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
          '13': {
            id: '13',
            amount: '20',
            coin: { coinHex: null, turnState: 'their-turn' },
            handStatus: 'active',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
      },
      betweenHand: {
        lastHandProposal: {
          gameType: 'krunk',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
        proposalGroups: [
          {
            primaryId: '11',
            memberIds: ['11', '13'],
            handProposal: {
              gameType: 'krunk',
              myContribution: 100n,
              theirContribution: 100n,
              gameTimeout: 15n,
            },
            origin: 'local',
            disposition: 'accepted',
          },
        ],
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave(
      liveEnvelope({
        activeGameIds: snapshot.activeGameIds,
        currentHandGameIds: snapshot.currentHandGameIds,
        currentHandOrigin: snapshot.currentHandOrigin,
        gameInstances: snapshot.gameInstances,
        activeGameType: snapshot.activeGameType,
        proposalGroups: snapshot.proposalGroups,
        betweenHandLastHandProposal: snapshot.betweenHandLastHandProposal,
        handState: krunkStateCodec.encode({
          games: {
            '11': initialKrunkGameState('alice'),
            '13': initialKrunkGameState('bob'),
          },
        }),
      }),
    );
    expect(selectProposalGroupByMemberId(restored, '13')).toMatchObject({
      primaryId: '11',
      memberIds: ['11', '13'],
      disposition: 'accepted',
    });
  });

  it('round-trips one outgoing group alongside an incoming collision', () => {
    const firstTerms = {
      gameType: 'calpoker',
      myContribution: 10n,
      theirContribution: 10n,
      gameTimeout: 15n,
    } as const;
    const inboundTerms = {
      gameType: 'calpoker',
      myContribution: 30n,
      theirContribution: 30n,
      gameTimeout: 25n,
    } as const;
    const restored = sessionModelFromSave(
      liveEnvelope({
        activeGameIds: [],
        proposalGroups: [
          {
            primary_id: '11',
            member_ids: ['11'],
            origin: 'local',
            disposition: 'outgoing',
            hand_proposal: {
              my_contribution: '10',
              their_contribution: '10',
              game_timeout: '15',
              game_type: 'calpoker',
              parameters: [10n, true],
            },
          },
          {
            primary_id: '23',
            member_ids: ['23'],
            origin: 'peer',
            disposition: 'incoming-review',
            hand_proposal: {
              my_contribution: '30',
              their_contribution: '30',
              game_timeout: '25',
              game_type: 'calpoker',
              parameters: [30n, true],
            },
          },
        ],
      }),
    );
    expect(restored.betweenHand.proposalGroups).toHaveLength(2);
    expect(selectProposalGroupByMemberId(restored, '11')?.handProposal).toEqual(firstTerms);
    expect(selectProposalGroupByMemberId(restored, '23')?.handProposal).toEqual(inboundTerms);
    expect(snapshotFromSessionModel(restored).proposalGroups).toHaveLength(2);
  });

  it('restores every current-hand member for resolved-unroll lifecycle rows', () => {
    const model = createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        activeGameType: 'krunk',
        currentHandIds: ['11', '13'],
        currentHandOrigin: 'peer',
        instances: {
          '11': {
            id: '11',
            amount: '20',
            coin: { coinHex: null, turnState: 'my-turn', onChain: true },
            handStatus: 'our-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
          '13': {
            id: '13',
            amount: '20',
            coin: { coinHex: null, turnState: 'their-turn', onChain: true },
            handStatus: 'their-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
      },
      betweenHand: {
        lastHandProposal: {
          gameType: 'krunk',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave(
      baseSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: [],
        currentHandGameIds: snapshot.currentHandGameIds,
        currentHandOrigin: snapshot.currentHandOrigin,
        gameInstances: snapshot.gameInstances,
        activeGameType: snapshot.activeGameType,
        channelStatus: channelStatusPayloadFromModel(model.channel.status),
        coinsOfInterest: [],
        betweenHandLastHandProposal: snapshot.betweenHandLastHandProposal,
      }),
    );

    expect(restored.game.currentHandIds).toEqual(['11', '13']);
    expect(selectGameDashboardView(restored).lifecycleRows).toEqual([
      { id: '11', label: 'Hand 1', statusLabel: 'Your turn', detail: null },
      { id: '13', label: 'Hand 2', statusLabel: 'Their turn', detail: null },
    ]);
  });

  it('clears only derived hand presentation for an abandoned session', () => {
    const model = createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'ShuttingDown',
          sessionDisposition: 'Abandoned',
          ourBalance: '0',
          theirBalance: '100',
        },
      },
      game: {
        handKey: 3,
        activeIds: ['7'],
        currentHandIds: ['7'],
        currentHandOrigin: 'local',
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: 'game-coin', turnState: 'their-turn', onChain: true },
            handStatus: 'their-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
        lastDisplayedId: '7',
        handState: { gameType: 'calpoker', state: { cards: [1n] } },
      },
    });

    const cleared = clearDerivedGamePresentation(model);

    expect(cleared.channel).toEqual(model.channel);
    expect(cleared.game).toMatchObject({
      handKey: 0,
      activeIds: [],
      currentHandIds: [],
      instances: {},
      lastDisplayedId: null,
      handState: null,
    });
    expect(snapshotFromSessionModel(cleared)).not.toHaveProperty('gameCoinHex');
    expect(snapshotFromSessionModel(cleared)).not.toHaveProperty('gameTurnState');
    expect(snapshotFromSessionModel(cleared).currentHandGameIds).toEqual([]);
    expect(snapshotFromSessionModel(cleared).gameInstances).toEqual({});
  });

  it('normalizes stale fallback presentation for live abandoned sessions', () => {
    const abandoned = normalizeSessionPresentation(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'ShuttingDown',
            sessionDisposition: 'Abandoned',
          },
        },
        game: {
          activeIds: ['7'],
          currentHandIds: ['7'],
          currentHandOrigin: 'local',
          instances: {
            '7': {
              id: '7',
              amount: '40',
              coin: { coinHex: 'stale-coin', turnState: 'their-turn', onChain: true },
              handStatus: 'their-turn',
              terminal: {
                type: 'settled',
                outcome: 'settled_cleanly',
                label: 'Settled cleanly',
                myReward: '20',
                rewardCoinHex: 'stale-reward',
              },
            },
          },
          lastDisplayedId: '7',
        },
      }),
    );

    expect(selectGameSessionView(abandoned)).toMatchObject({
      gameCoin: { coinHex: null, turnState: 'my-turn' },
      gameTerminal: INITIAL_GAME_TERMINAL_MODEL,
      activeGameIds: [],
      displayGameId: null,
    });
    expect(selectGameSpecificView(abandoned)).toMatchObject({
      turnState: 'my-turn',
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    });
  });

  it('normalizes abandoned live and restored presentation identically', () => {
    const abandonedStatus = {
      ...INITIAL_CHANNEL_STATUS_MODEL,
      state: 'ShuttingDown' as const,
      sessionDisposition: 'Abandoned' as const,
    };
    const staleGame = {
      activeIds: ['7'],
      currentHandIds: ['7'],
      currentHandOrigin: 'local',
      instances: {
        '7': {
          id: '7',
          amount: '40',
          coin: { coinHex: 'stale', turnState: 'their-turn' as const },
          handStatus: 'active' as const,
          terminal: INITIAL_GAME_TERMINAL_MODEL,
        },
      },
      lastDisplayedId: '7',
    };
    const live = normalizeSessionPresentation(
      createSessionModel({
        channel: { status: abandonedStatus },
        game: staleGame,
        betweenHand: {
          lastHandProposal: {
            gameType: 'calpoker',
            myContribution: 40n,
            theirContribution: 40n,
            gameTimeout: 15n,
          },
        },
      }),
    );
    const staleSnapshot = snapshotFromSessionModel(
      createSessionModel({
        channel: { status: abandonedStatus },
        game: staleGame,
        betweenHand: {
          lastHandProposal: {
            gameType: 'calpoker',
            myContribution: 40n,
            theirContribution: 40n,
            gameTimeout: 15n,
          },
        },
      }),
    );
    const restored = sessionModelFromSave(
      baseSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: staleSnapshot.activeGameIds,
        currentHandGameIds: staleSnapshot.currentHandGameIds,
        currentHandOrigin: staleSnapshot.currentHandOrigin,
        lastDisplayedGameId: staleSnapshot.lastDisplayedGameId,
        gameInstances: staleSnapshot.gameInstances,
        activeGameType: staleSnapshot.activeGameType,
        channelStatus: channelStatusPayloadFromModel(abandonedStatus),
        coinsOfInterest: [],
        betweenHandLastHandProposal: staleSnapshot.betweenHandLastHandProposal,
      }),
    );

    expect(restored.game).toEqual(live.game);
    expect(selectGameSessionView(restored)).toEqual(selectGameSessionView(live));
  });

  it('rejects snapshots whose active ids lack keyed instances', () => {
    const model = createSessionModel({
      game: { activeIds: ['7', '9'] },
    });

    expect(() => snapshotFromSessionModel(model)).toThrow(
      'Session invariant broken: game 7 is missing its keyed instance',
    );
  });

  it('restores a finished session without legacy active game ids', () => {
    const restored = sessionModelFromSave(
      baseSave({
        version: 11n,
        playerId: 'p1',
        channelStatus: {
          state: 'ResolvedClean',
          advisory: null,
          coin: null,
          our_balance: '60',
          their_balance: '40',
          game_allocated: '0',
          have_potato: true,
        },
        coinsOfInterest: [],
      }),
    );

    expect(restored.game.activeIds).toEqual([]);
    expect(restored.game.instances).toEqual({});
    expect(restored.game.lastDisplayedId).toBeNull();
    expect(selectGameSessionView(restored).displayGameId).toBeNull();
  });

  it('marks a new on-chain game coin pending without retaining its predecessor', () => {
    const previous = { coinHex: 'old-coin', turnState: 'their-turn' as const, onChain: true };

    expect(gameCoinIdentityForGameStatus(previous, 'on-chain-their-turn', true)).toEqual({
      coinHex: null,
      onChain: true,
    });
    expect(gameCoinIdentityForGameStatus(previous, 'replaying', true)).toEqual({
      coinHex: null,
      onChain: true,
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
          game: {
            activeIds: ['7'],
            instances: {
              '7': {
                id: '7',
                amount: '100',
                coin: { coinHex: null, onChain: true, turnState: 'replaying' },
                handStatus: 'replaying-move',
                terminal: INITIAL_GAME_TERMINAL_MODEL,
              },
            },
          },
        }),
      ).handStatusLabel,
    ).toBe('Replaying move');

    const timeoutClaimView = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: {
          activeIds: ['7'],
          instances: {
            '7': {
              id: '7',
              amount: '100',
              coin: { coinHex: null, onChain: true, turnState: 'submitting-timeout' },
              handStatus: 'submitting-timeout',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          },
        },
      }),
    );
    expect(timeoutClaimView.handStatusLabel).toBe('Submitting timeout claim');
    expect(timeoutClaimView.lifecycleRows).toEqual([]);
  });

  it('projects playing-move notifications and preserves them through my-turn confirmation', () => {
    const previousCoin = { coinHex: 'parent', turnState: 'my-turn' as const, onChain: true };
    const playing = projectGameStatus({
      previous: { coin: previousCoin, handStatus: 'our-turn' },
      payload: { id: '7', status: 'playing-move', coin_id: 'new-coin' },
      channelState: 'ResolvedUnrolled',
    });
    expect(playing).toEqual({
      coin: { coinHex: null, onChain: true, turnState: 'playing-on-chain' },
      handStatus: 'playing-move',
    });

    const confirmed = projectGameStatus({
      previous: playing,
      payload: { id: '7', status: 'on-chain-my-turn', coin_id: 'next-coin' },
      channelState: 'ResolvedUnrolled',
    });
    expect(confirmed).toEqual({
      coin: { coinHex: null, onChain: true, turnState: 'playing-on-chain' },
      handStatus: 'playing-move',
    });
  });

  it('preserves authoritative on-chain turn state during local turn callbacks', () => {
    const localMove = nextGamePresentationAfterLocalTurn(
      {
        coin: { coinHex: 'parent', turnState: 'my-turn', onChain: true },
        handStatus: 'our-turn',
      },
      false,
      'Unrolling',
    );
    expect(localMove).toEqual({
      coin: { coinHex: 'parent', turnState: 'my-turn', onChain: true },
      handStatus: 'our-turn',
    });

    expect(
      projectGameStatus({
        previous: localMove,
        payload: { id: '7', status: 'their-turn', coin_id: null },
        channelState: 'Unrolling',
      }),
    ).toEqual(localMove);
    expect(nextGamePresentationAfterLocalTurn(localMove, true, 'Unrolling')).toBe(localMove);
  });

  it('keeps reset, acceptance, immediate local turn, and terminal transitions instance-owned', () => {
    const reset = createSessionModel({
      game: { activeIds: [], currentHandIds: [], instances: {}, lastDisplayedId: null },
    });
    expect(selectGameSessionView(reset).gameCoin).toEqual({
      coinHex: null,
      turnState: 'my-turn',
    });

    const acceptedInstance = {
      id: '7',
      amount: '100',
      coin: { coinHex: null, turnState: 'my-turn' as const, onChain: false },
      handStatus: 'active' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    const accepted = createSessionModel({
      game: {
        activeIds: ['7'],
        currentHandIds: ['7'],
        currentHandOrigin: 'local',
        instances: { '7': acceptedInstance },
        lastDisplayedId: '7',
      },
    });
    expect(selectGameSessionView(accepted).gameCoin).toEqual(acceptedInstance.coin);

    const playingInstance = nextGameInstanceAfterLocalTurn(acceptedInstance, false, 'Unrolling');
    const playing = createSessionModel({
      game: {
        ...accepted.game,
        instances: { '7': playingInstance },
      },
    });
    expect(selectGameSessionView(playing).gameCoin.turnState).toBe('my-turn');

    const terminalInstance = {
      ...playingInstance,
      coin: { ...playingInstance.coin, coinHex: null, turnState: 'ended' as const },
      handStatus: 'ended' as const,
      terminal: {
        type: 'settled' as const,
        outcome: 'settled_cleanly' as const,
        label: 'Settled cleanly',
        myReward: '100',
        rewardCoinHex: 'reward',
      },
    };
    const terminal = createSessionModel({
      game: {
        ...playing.game,
        activeIds: [],
        instances: { '7': terminalInstance },
        lastDisplayedId: '7',
      },
    });
    expect(selectGameSessionView(terminal)).toMatchObject({
      displayGameId: '7',
      gameCoin: { coinHex: null, turnState: 'ended' },
      gameTerminal: { type: 'settled', rewardCoinHex: 'reward' },
    });
    expect(
      projectGameStatus({
        previous: terminalInstance,
        payload: { id: '7', status: 'my-turn' },
        channelState: 'ResolvedUnrolled',
      }),
    ).toBe(terminalInstance);
  });

  it('does not change the selected display when a non-displayed game updates or enriches', () => {
    const displayed = {
      id: '7',
      amount: '100',
      coin: { coinHex: 'displayed-coin', turnState: 'my-turn' as const, onChain: true },
      handStatus: 'our-turn' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    const background = {
      id: '9',
      amount: '100',
      coin: { coinHex: 'background-old', turnState: 'their-turn' as const, onChain: true },
      handStatus: 'their-turn' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    const baseGame = {
      activeIds: ['7', '9'],
      currentHandIds: ['7', '9'],
      currentHandOrigin: 'local',
      instances: { '7': displayed, '9': background },
      lastDisplayedId: '7',
    };
    const before = createSessionModel({ game: baseGame });

    const projectedBackground = {
      ...background,
      ...projectGameStatus({
        previous: background,
        payload: {
          id: '9',
          status: 'on-chain-their-turn',
          coin_id: 'background-next',
          other_params: { submitting_timeout_claim: true },
        },
        channelState: 'ResolvedUnrolled',
      }),
    };
    const afterStatus = createSessionModel({
      game: {
        ...baseGame,
        instances: { '7': displayed, '9': projectedBackground },
      },
    });
    const enrichedBackground = {
      ...projectedBackground,
      coin: { ...projectedBackground.coin, coinHex: 'background-enriched' },
    };
    const afterEnrichment = createSessionModel({
      game: {
        ...baseGame,
        instances: { '7': displayed, '9': enrichedBackground },
      },
    });

    expect(selectGameSessionView(before)).toMatchObject({
      displayGameId: '7',
      gameCoin: displayed.coin,
    });
    expect(selectGameSessionView(afterStatus)).toMatchObject({
      displayGameId: '7',
      gameCoin: displayed.coin,
    });
    expect(selectGameSessionView(afterEnrichment)).toMatchObject({
      displayGameId: '7',
      gameCoin: displayed.coin,
    });
    expect(afterEnrichment.game.instances['9'].coinHex).toBe('background-enriched');
  });

  it('does not delay terminal reduction for reward enrichment', async () => {
    const processed: string[] = [];
    let finishCoinEnrichment!: () => void;
    const coinEnrichment = new Promise<void>((resolve) => {
      finishCoinEnrichment = resolve;
    });
    const handle = (notification: Parameters<typeof dispatchWasmNotification>[0]) => {
      if ('GameSettled' in notification) {
        processed.push('settled');
        return coinEnrichment.then(() => processed.push('settled-coin'));
      } else {
        processed.push('channel');
        return Promise.resolve();
      }
    };

    dispatchWasmNotification(
      {
        GameSettled: { id: '7', outcome: 'settled_cleanly', our_share: '20' },
      },
      handle,
      (error) => {
        throw error;
      },
    );
    dispatchWasmNotification(
      {
        ChannelStatus: {
          state: 'ResolvedUnrolled',
          advisory: null,
          coin: null,
          our_balance: null,
          their_balance: null,
          game_allocated: null,
        },
      },
      handle,
      (error) => {
        throw error;
      },
    );

    expect(processed).toEqual(['settled', 'channel']);
    finishCoinEnrichment();
    await coinEnrichment;
    expect(processed).toEqual(['settled', 'channel', 'settled-coin']);
  });

  it('makes same-batch handlers observe the synchronously updated machine state', async () => {
    const machine = {
      current: createSessionMachineState(createSessionModel()),
    };
    const observedModes: string[] = [];

    const handle = (notification: Parameters<typeof dispatchWasmNotification>[0]) => {
      if ('ProposalMade' in notification) {
        machine.current = reduceSessionMachine(machine.current, {
          type: 'set-between-hand-mode',
          mode: 'review-incoming-proposal',
        }).state;
      } else {
        observedModes.push(machine.current.model.betweenHand.mode);
      }
    };

    dispatchWasmNotification(
      {
        ProposalMade: { id: '7', group_ids: ['7'] },
      },
      handle,
      (error) => {
        throw error;
      },
    );
    dispatchWasmNotification(
      {
        ActionFailed: { reason: 'later event' },
      },
      handle,
      (error) => {
        throw error;
      },
    );

    expect(observedModes).toEqual(['review-incoming-proposal']);
  });

  it('recognizes terminal model and persisted channel snapshots consistently', () => {
    expect(
      isTerminalChannelSnapshot({
        state: 'Active',
        sessionDisposition: 'Abandoned',
      }),
    ).toBe(true);
    expect(
      isTerminalChannelSnapshot({
        state: 'Active',
        session_disposition: 'Abandoned',
      }),
    ).toBe(true);
    expect(
      isTerminalChannelSnapshot({
        state: 'ResolvedClean',
        session_disposition: null,
      }),
    ).toBe(true);
    expect(
      isTerminalChannelSnapshot({
        state: 'Active',
        session_disposition: null,
      }),
    ).toBe(false);
  });
});
