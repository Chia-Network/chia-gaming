import {
  createSessionModel,
  clearDerivedGamePresentation,
  normalizeSessionPresentation,
  channelStatusModelFromPayload,
  channelStatusPayloadFromModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  isChannelAbandonable,
  isTerminalChannelSnapshot,
  selectGameDashboardView,
  selectStatusBarBalances,
  selectGameSessionView,
  selectGameSpecificView,
  selectInertGameInterfaceForBetweenHandDialog,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
  selectSessionPhase,
  selectShellView,
  selectGameTabDotColor,
  isCleanShutdownInProgress,
  sessionAmountsFromSave,
  sessionModelFromSave,
  snapshotFromSessionModel,
  gameCoinIdentityForGameStatus,
  isFinishingGameStatus,
  nextGameInstanceAfterLocalTurn,
  nextGamePresentationAfterLocalTurn,
  nextGameTurnAfterLocalTurn,
  isActivelyPlayingOnChain,
  projectGameStatus,
} from '../session/model';
import { gameInitialTurn } from '../gameRegistry';
import type { SessionSave } from '../../hooks/save';
import { initialKrunkGameState, krunkStateCodec } from '../../features/krunk/stateCodec';
import {
  dispatchWasmNotification,
  gameplayEventsForGameStatus,
  clearProposalTerms,
  clearProposalTracking,
  outgoingProposalGroups,
  outgoingProposalTerms,
  proposalGroupMap,
  removeProposalGroupFromHand,
  settledEventForInfo,
} from '../../hooks/useGameSession';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';

function liveEnvelope(fields: Partial<SessionSave>): SessionSave {
  return {
    version: 11n,
    playerId: 'p1',
    serializedGameSession: new Uint8Array([1]),
    gameSessionSchemaVersion: 3n,
    pairingToken: 'pair',
    messageNumber: 1n,
    remoteNumber: 0n,
    iStarted: true,
    myContribution: '100',
    theirContribution: '100',
    perGameAmount: '10',
    rewardPuzzleHash: '11'.repeat(32),
    unackedMessages: [],
    activeGameIds: [],
    ...fields,
  };
}

describe('session model selectors', () => {
  it('retains generic group membership through acceptance until insufficient balance clears every member', () => {
    const terms = {
      gameType: 'factory-pair',
      myContribution: 10n,
      theirContribution: 10n,
      gameTimeout: 15n,
    };
    const groupIds = ['11', '13'];
    const termsById = { '11': terms, '13': terms };
    const groupsById = { '11': groupIds, '13': groupIds };
    const outgoing = new Set(groupIds);

    // First ProposalAccepted ends proposal terms, but later notifications must
    // still resolve against the complete factory group.
    clearProposalTerms(groupIds, termsById, outgoing);
    expect(groupsById['13']).toEqual(groupIds);

    const remaining = removeProposalGroupFromHand(groupIds, groupIds, groupIds, {
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
    });
    expect(remaining).toEqual({ activeIds: [], currentHandIds: [], instances: {} });

    clearProposalTracking(groupIds, termsById, groupsById, outgoing);
    expect(groupsById).toEqual({});
  });

  it('round-trips accepted in-flight groups for a later insufficient-balance cleanup', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'krunk',
        activeIds: ['11', '13'],
        currentHandIds: ['11', '13'],
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
        acceptedProposalGroupIds: [['11', '13']],
        lastTerms: {
          gameType: 'krunk',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave(
      liveEnvelope({
        activeGameIds: snapshot.activeGameIds,
        currentHandGameIds: snapshot.currentHandGameIds,
        gameInstances: snapshot.gameInstances,
        activeGameType: snapshot.activeGameType,
        acceptedProposalGroupIds: snapshot.acceptedProposalGroupIds,
        betweenHandLastTerms: snapshot.betweenHandLastTerms,
        handState: krunkStateCodec.encode({
          games: {
            '11': initialKrunkGameState('alice'),
            '13': initialKrunkGameState('bob'),
          },
        }),
      }),
    );
    const restoredGroups = proposalGroupMap(restored.betweenHand.acceptedProposalGroupIds);

    expect(restored.betweenHand.acceptedProposalGroupIds).toEqual([['11', '13']]);
    expect(restoredGroups['13']).toEqual(['11', '13']);
    expect(
      removeProposalGroupFromHand(
        restoredGroups['13'],
        restored.game.activeIds,
        restored.game.currentHandIds,
        restored.game.instances,
      ),
    ).toEqual({ activeIds: [], currentHandIds: [], instances: {} });
  });

  it('persists separate outgoing groups without inbound terms or group merging', () => {
    const firstTerms = {
      gameType: 'calpoker',
      myContribution: 10n,
      theirContribution: 10n,
      gameTimeout: 15n,
    } as const;
    const secondTerms = {
      gameType: 'krunk',
      myContribution: 100n,
      theirContribution: 100n,
      gameTimeout: 20n,
    } as const;
    const inboundTerms = {
      gameType: 'calpoker',
      myContribution: 30n,
      theirContribution: 30n,
      gameTimeout: 25n,
    } as const;
    const outgoing = new Set(['11', '13', '17', '19']);
    const groups = {
      '11': ['11', '13'],
      '13': ['11', '13'],
      '17': ['17', '19'],
      '19': ['17', '19'],
      '23': ['23', '29'],
      '29': ['23', '29'],
    };
    const terms = {
      '11': firstTerms,
      '13': firstTerms,
      '17': secondTerms,
      '19': secondTerms,
      '23': inboundTerms,
      '29': inboundTerms,
    };

    expect(outgoingProposalGroups(outgoing, groups)).toEqual([
      ['11', '13'],
      ['17', '19'],
    ]);
    expect(outgoingProposalTerms(outgoing, terms)).toEqual({
      '11': firstTerms,
      '13': firstTerms,
      '17': secondTerms,
      '19': secondTerms,
    });

    const restored = sessionModelFromSave(
      liveEnvelope({
        activeGameIds: [],
        outgoingProposalGroupIds: [
          ['11', '13'],
          ['17', '19'],
        ],
        outgoingProposalTerms: {
          '11': {
            my_contribution: '10',
            their_contribution: '10',
            game_type: 'calpoker',
          },
          '13': {
            my_contribution: '10',
            their_contribution: '10',
            game_type: 'calpoker',
          },
          '17': {
            my_contribution: '100',
            their_contribution: '100',
            game_type: 'krunk',
          },
          '19': {
            my_contribution: '100',
            their_contribution: '100',
            game_type: 'krunk',
          },
        },
        betweenHandReviewPeerProposal: {
          id: '23',
          groupIds: ['23', '29'],
          my_contribution: '30',
          their_contribution: '30',
          game_type: 'calpoker',
        },
      }),
    );
    expect(restored.betweenHand.outgoingProposalGroupIds).toEqual([
      ['11', '13'],
      ['17', '19'],
    ]);
    expect(restored.betweenHand.outgoingProposalIds).toEqual(['11', '13', '17', '19']);
    expect(restored.betweenHand.outgoingProposalTerms['23']).toBeUndefined();
    expect(snapshotFromSessionModel(restored)).toMatchObject({
      outgoingProposalGroupIds: [
        ['11', '13'],
        ['17', '19'],
      ],
    });
  });

  it('restores every current-hand member for resolved-unroll lifecycle rows', () => {
    const model = createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        activeGameType: 'krunk',
        currentHandIds: ['11', '13'],
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
        lastTerms: {
          gameType: 'krunk',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: [],
      currentHandGameIds: snapshot.currentHandGameIds,
      gameInstances: snapshot.gameInstances,
      activeGameType: snapshot.activeGameType,
      channelStatus: channelStatusPayloadFromModel(model.channel.status),
      coinsOfInterest: [],
      betweenHandLastTerms: snapshot.betweenHandLastTerms,
    });

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
        handState: { gameType: 'calpoker', version: 1n, state: { cards: [1n] } },
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
    expect(snapshotFromSessionModel(cleared).currentHandGameIds).toBeUndefined();
    expect(snapshotFromSessionModel(cleared).gameInstances).toBeUndefined();
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
          lastTerms: {
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
          lastTerms: {
            gameType: 'calpoker',
            myContribution: 40n,
            theirContribution: 40n,
            gameTimeout: 15n,
          },
        },
      }),
    );
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: staleSnapshot.activeGameIds,
      currentHandGameIds: staleSnapshot.currentHandGameIds,
      lastDisplayedGameId: staleSnapshot.lastDisplayedGameId,
      gameInstances: staleSnapshot.gameInstances,
      activeGameType: staleSnapshot.activeGameType,
      channelStatus: channelStatusPayloadFromModel(abandonedStatus),
      coinsOfInterest: [],
      betweenHandLastTerms: staleSnapshot.betweenHandLastTerms,
    });

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
    const restored = sessionModelFromSave({
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
    });

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

  it('keeps an acknowledged terminal handoff session live until Rust abandons it', () => {
    const model = createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'ResolvedClean',
          sessionDisposition: 'AwaitOutboundTerminal',
        },
      },
    });

    expect(selectSessionPhase(model)).toBe('off-chain');
    expect(selectGameDashboardView(model)).toMatchObject({
      channelStatusLabel: 'Waiting for Peer',
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });
  });

  it('derives dashboard actions for no-session, waiting, active, and terminal states', () => {
    expect(selectGameDashboardView(null)).toMatchObject({
      channelStatusLabel: 'No Session',
      handStatusLabel: 'No hand',
      actionLabel: 'No Session',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'OurWalletMakingOffer' } },
        }),
      ),
    ).toMatchObject({
      actionLabel: 'Cancel',
      actionEnabled: true,
      actionKind: 'cancel',
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'OfferSent' } },
        }),
      ),
    ).toMatchObject({
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game: { activeIds: [] },
        }),
      ),
    ).toMatchObject({
      channelStatusLabel: 'Active',
      handStatusLabel: 'No hand',
      actionLabel: 'Clean Shutdown',
      actionEnabled: true,
      actionKind: 'clean-shutdown',
    });
    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: {
            status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active', havePotato: true },
          },
          game: { activeIds: [] },
        }),
      ),
    ).toMatchObject({ channelStatusLabel: 'Active', havePotato: true });
    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game: { activeIds: [] },
        }),
        { cleanShutdownGraceActive: true },
      ),
    ).toMatchObject({
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game: { activeIds: ['7'] },
        }),
      ),
    ).toMatchObject({
      handStatusLabel: 'Active',
      actionLabel: 'Go On-Chain',
      actionEnabled: true,
      actionKind: 'go-on-chain',
    });

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: {
            status: {
              ...INITIAL_CHANNEL_STATUS_MODEL,
              state: 'ResolvedClean',
              ourBalance: '60',
              theirBalance: '40',
            },
          },
        }),
      ),
    ).toMatchObject({
      channelStatusLabel: 'Resolved Clean',
      actionLabel: 'Done',
      actionEnabled: false,
      actionKind: 'none',
      channelDetail: null,
    });
    // Resolved display keeps Me/Opp balances (not wiped to "No Session").
    expect(
      selectStatusBarBalances(
        createSessionModel({
          channel: {
            status: {
              ...INITIAL_CHANNEL_STATUS_MODEL,
              state: 'ResolvedClean',
              ourBalance: '60',
              theirBalance: '40',
            },
          },
        }),
      ),
    ).toEqual([
      { label: 'Me', value: '60' },
      { label: 'Opp', value: '40' },
    ]);
  });

  it('normalizes Rust channel status once for persistence and presentation', async () => {
    expect(
      channelStatusModelFromPayload({
        state: 'ShuttingDown',
        advisory: 'closing',
        coin: null,
        our_balance: { Amount: '0' },
        their_balance: { Amount: '100' },
        game_allocated: { Amount: '0' },
        have_potato: true,
        zero_payout: true,
        unroll_initiator: 'opponent',
        semantic_phase: 'waiting_timeout',
      }),
    ).toMatchObject({
      state: 'ShuttingDown',
      advisory: 'closing',
      ourBalance: '0',
      theirBalance: '100',
      gameAllocated: '0',
      havePotato: true,
      zeroPayout: true,
      unrollInitiator: 'opponent',
      semanticPhase: 'waiting_timeout',
    });
  });

  it('shows semantic progress alongside the authoritative channel advisory', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            semanticPhase: 'waiting_timeout',
            advisory: 'The observed spend needs manual review',
          },
        },
      }),
    );

    expect(view.channelDetail).toBe('Waiting for timeout: The observed spend needs manual review');
  });

  it('renders known unroll initiators without inventing an unknown label', () => {
    const opponent = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            semanticPhase: 'waiting_timeout',
            unrollInitiator: 'opponent',
          },
        },
      }),
    );
    expect(opponent.channelDetail).toBe('Waiting for timeout (initiated by opponent)');

    const us = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            semanticPhase: 'preempting',
            unrollInitiator: 'us',
          },
        },
      }),
    );
    expect(us.channelDetail).toBe('Preempting unroll (initiated by you)');

    const unknown = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            semanticPhase: 'resolving',
          },
        },
      }),
    );
    expect(unknown.channelDetail).toBe('Resolving');
  });

  it('prioritizes terminal disposition details over stale semantic progress', () => {
    const abandoned = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            sessionDisposition: 'Abandoned',
            semanticPhase: 'waiting_timeout',
            advisory: 'Local session was abandoned',
          },
        },
      }),
    );
    expect(abandoned).toMatchObject({
      channelStatusLabel: 'Abandoned',
      channelDetail: 'Local session was abandoned',
    });

    const awaitingPeer = selectGameDashboardView(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            sessionDisposition: 'AwaitOutboundTerminal',
            semanticPhase: 'submitting_timeout_finish',
            advisory: null,
          },
        },
      }),
    );
    expect(awaitingPeer).toMatchObject({
      channelStatusLabel: 'Waiting for Peer',
      channelDetail: 'Waiting for peer to acknowledge close',
    });
  });

  it('uses the canonical channel-status normalization when restoring saves', () => {
    const coin = new Uint8Array(65);
    coin[64] = 42;
    const channelStatus = {
      state: 'ResolvedUnrolled' as const,
      advisory: 'resolved',
      coin,
      our_balance: { Amount: '999' },
      their_balance: { Amount: '58' },
      game_allocated: { Amount: '0' },
      have_potato: false,
      zero_payout: false,
      unroll_initiator: 'us' as const,
      semantic_phase: 'submitting_timeout_finish' as const,
    };
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      activeGameIds: [],
      channelStatus,
      coinsOfInterest: [],
    });

    expect(restored.channel.status).toEqual(channelStatusModelFromPayload(channelStatus));
    expect(restored.channel.status.ourBalance).toBe('42');
    expect(restored.channel.status).toMatchObject({
      unrollInitiator: 'us',
      semanticPhase: 'submitting_timeout_finish',
    });
  });

  it('restores pre-progress saves with unknown progress fields', () => {
    const restored = sessionModelFromSave(
      liveEnvelope({
        activeGameIds: [],
        channelStatus: {
          state: 'Unrolling',
          advisory: null,
          coin: null,
          our_balance: null,
          their_balance: null,
          game_allocated: null,
        },
      }),
    );

    expect(restored.channel.status).toMatchObject({
      unrollInitiator: null,
      semanticPhase: null,
    });
  });

  it('uses a clean-shutdown grace window before offering go-on-chain escalation', () => {
    const shuttingDown = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ShuttingDown' },
        cleanShutdownStarted: true,
      },
    });

    expect(selectGameDashboardView(shuttingDown, { cleanShutdownGraceActive: true })).toMatchObject(
      {
        actionLabel: 'Waiting',
        actionEnabled: false,
        actionKind: 'none',
      },
    );
    expect(
      selectGameDashboardView(shuttingDown, { cleanShutdownGraceActive: false }),
    ).toMatchObject({
      actionLabel: 'Go On-Chain',
      actionEnabled: true,
      actionKind: 'go-on-chain',
    });

    const zeroPayoutShutdown = createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'ShuttingDown',
          zeroPayout: true,
        },
        cleanShutdownStarted: true,
      },
    });
    expect(
      selectGameDashboardView(zeroPayoutShutdown, { cleanShutdownGraceActive: true }),
    ).toMatchObject({
      actionLabel: 'Abandon',
      actionEnabled: true,
      actionKind: 'abandon',
    });
    expect(isChannelAbandonable(zeroPayoutShutdown.channel.status, false)).toBe(true);
    expect(isChannelAbandonable(shuttingDown.channel.status, true)).toBe(false);
  });

  it('enables abandon action after timeout for waiting states', () => {
    const waitingStates = [
      'OfferSent',
      'TransactionPending',
      'ShutdownTransactionPending',
      'GoingOnChain',
      'Unrolling',
    ] as const;

    for (const state of waitingStates) {
      const model = createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state } },
      });

      expect(selectGameDashboardView(model, { abandonEnabled: false })).toMatchObject({
        actionLabel: 'Waiting',
        actionEnabled: false,
        actionKind: 'none',
      });

      expect(selectGameDashboardView(model, { abandonEnabled: true })).toMatchObject({
        actionLabel: 'Abandon',
        actionEnabled: true,
        actionKind: 'abandon',
      });
    }
  });

  it('allows chain-submitting dashboard actions even while the blockchain is offline', () => {
    const cleanShutdown = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        game: { activeIds: [] },
      }),
    );
    expect(cleanShutdown).toMatchObject({
      actionLabel: 'Clean Shutdown',
      actionEnabled: true,
      actionKind: 'clean-shutdown',
    });

    const goOnChain = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        game: { activeIds: ['7'] },
      }),
    );
    expect(goOnChain).toMatchObject({
      actionLabel: 'Go On-Chain',
      actionEnabled: true,
      actionKind: 'go-on-chain',
    });
  });

  it('separates channel advisories from hand terminal details', () => {
    const terminal = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' },
      },
      game: {
        currentHandIds: ['7'],
        instances: {
          '7': {
            id: '7',
            amount: '20',
            coin: { coinHex: null, turnState: 'ended' },
            handStatus: 'ended',
            terminal: {
              type: 'settled',
              outcome: 'forfeited_skipped_reveal',
              label: 'Forfeited',
              myReward: '20',
              rewardCoinHex: null,
            },
          },
        },
        lastDisplayedId: '7',
      },
    });
    expect(selectGameDashboardView(terminal)).toMatchObject({
      channelDetail: null,
      handStatusLabel: 'Ended',
      handDetail: 'Forfeited',
    });

    const failed = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Failed', advisory: 'funding expired' },
      },
      restore: { error: 'restore failed' },
    });
    expect(selectGameDashboardView(failed)).toMatchObject({
      channelDetail: 'funding expired',
      handDetail: null,
    });
  });

  it('uses hand terminology for the collapsed hand status', () => {
    const view = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        game: {
          activeIds: ['7'],
          currentHandIds: ['7'],
          instances: {
            '7': {
              id: '7',
              amount: '100',
              coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
              handStatus: 'playing-move',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          },
          lastDisplayedId: '7',
        },
      }),
    );

    expect(view.handStatusLabel).toBe('Active');
    expect(view.handDetail).toBeNull();
  });

  it('keeps hands active until unrolling completes', () => {
    const game = (
      turnState:
        | 'their-turn'
        | 'playing-on-chain'
        | 'replaying'
        | 'finishing'
        | 'opponent-illegal-move',
      coinHex: string | null,
    ) => ({
      activeIds: ['7'],
      currentHandIds: ['7'],
      instances: {
        '7': {
          id: '7',
          amount: '100',
          coin: { coinHex, turnState },
          handStatus: 'active' as const,
          terminal: INITIAL_GAME_TERMINAL_MODEL,
        },
      },
      lastDisplayedId: '7',
    });
    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game: game('their-turn', 'abcd'),
        }),
      ).handStatusLabel,
    ).toBe('Active');

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
          game: game('their-turn', null),
        }),
      ).handStatusLabel,
    ).toBe('Active');

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
          game: game('their-turn', 'abcd'),
        }),
      ).handStatusLabel,
    ).toBe('Active');

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
          game: game('playing-on-chain', 'abcd'),
        }),
      ).handStatusLabel,
    ).toBe('Active');

    // The resolved-unroll state is the authoritative boundary even while
    // deriving the game coin's hex asynchronously.
    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
          game: game('replaying', null),
        }),
      ).handStatusLabel,
    ).toBe('Replaying move');

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
          game: game('finishing', 'abcd'),
        }),
      ).handStatusLabel,
    ).toBe('Finishing');

    // Detecting the opponent's illegal on-chain move puts us in the slash flow;
    // the bar should say so explicitly instead of a generic "Your turn".
    const slashing = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: game('opponent-illegal-move', null),
      }),
    );
    expect(slashing.handStatusLabel).toBe('Slashing cheater');
  });

  it('omits lifecycle rows off-chain and shows one row per game on-chain', () => {
    const instances = {
      '7': {
        id: '7',
        amount: '100',
        coin: { coinHex: 'aaaa', turnState: 'my-turn' as const },
        handStatus: 'our-turn' as const,
        terminal: INITIAL_GAME_TERMINAL_MODEL,
      },
      '9': {
        id: '9',
        amount: '100',
        coin: { coinHex: 'bbbb', turnState: 'their-turn' as const },
        handStatus: 'their-turn' as const,
        terminal: INITIAL_GAME_TERMINAL_MODEL,
      },
    };
    const game = {
      activeIds: ['7', '9'],
      currentHandIds: ['7', '9'],
      instances,
    };

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game,
        }),
      ).lifecycleRows,
    ).toEqual([]);

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
          game,
        }),
      ).lifecycleRows,
    ).toEqual([]);

    expect(
      selectGameDashboardView(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
          game,
        }),
      ).lifecycleRows,
    ).toEqual([
      { id: '7', label: 'Hand 1', statusLabel: 'Your turn', detail: null },
      { id: '9', label: 'Hand 2', statusLabel: 'Their turn', detail: null },
    ]);
  });

  it('waits for authoritative on-chain status after a local turn change', () => {
    const makeInstance = (id: string, handStatus: 'our-turn' | 'their-turn') => ({
      id,
      amount: '100',
      coin: {
        coinHex: `${id}${id}`,
        turnState: handStatus === 'our-turn' ? ('my-turn' as const) : ('their-turn' as const),
      },
      handStatus,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    });
    const first = makeInstance('7', 'our-turn');
    const second = makeInstance('9', 'their-turn');
    const updated = {
      '7': nextGameInstanceAfterLocalTurn(first, false, 'Unrolling'),
      '9': second,
    };

    expect(updated['7']).toBe(first);
    expect(updated['9']).toBe(second);
    expect(nextGameInstanceAfterLocalTurn(first, true, 'Active')).toBe(first);

    const singleton = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: { activeIds: ['7'], currentHandIds: ['7'], instances: { '7': updated['7'] } },
      }),
    );
    const multiple = selectGameDashboardView(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
        game: { activeIds: ['7', '9'], currentHandIds: ['7', '9'], instances: updated },
      }),
    );
    expect(singleton.lifecycleRows[0]).toMatchObject({
      label: 'Hand',
      statusLabel: 'Your turn',
    });
    expect(multiple.lifecycleRows).toEqual([
      { id: '7', label: 'Hand 1', statusLabel: 'Your turn', detail: null },
      { id: '9', label: 'Hand 2', statusLabel: 'Their turn', detail: null },
    ]);
  });

  it('keeps an active Krunk member displayed when its sibling settles', () => {
    const settled = {
      id: 'picker',
      amount: '100',
      coin: { coinHex: null, turnState: 'ended' as const, onChain: true },
      handStatus: 'ended' as const,
      terminal: {
        type: 'settled' as const,
        outcome: 'settled_cleanly' as const,
        label: 'Settled cleanly',
        myReward: '100',
        rewardCoinHex: null,
      },
    };
    const active = {
      id: 'guesser',
      amount: '100',
      coin: { coinHex: null, turnState: 'their-turn' as const, onChain: true },
      handStatus: 'their-turn' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    const model = createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        activeIds: ['guesser'],
        currentHandIds: ['picker', 'guesser'],
        instances: { picker: settled, guesser: active },
        lastDisplayedId: 'picker',
      },
    });

    expect(selectGameDashboardView(model)).toMatchObject({
      handStatusLabel: 'Their turn',
      handDetail: null,
    });
    expect(selectGameSessionView(model).gameTerminal).toEqual(INITIAL_GAME_TERMINAL_MODEL);
    expect(selectGameSpecificView(model)).toMatchObject({
      displayGameId: 'guesser',
      turnState: 'their-turn',
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    });
  });

  it('derives status-bar balances across phases', () => {
    const pending = (id: string) => ({
      id,
      amount: '100',
      coin: { coinHex: null, turnState: 'my-turn' as const },
      handStatus: 'active' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    });
    const ended = (id: string, myReward: string) => ({
      ...pending(id),
      coin: { coinHex: null, turnState: 'ended' as const },
      handStatus: 'ended' as const,
      terminal: {
        type: 'settled' as const,
        outcome: 'settled_cleanly' as const,
        label: 'Settled cleanly',
        myReward,
        rewardCoinHex: null,
      },
    });

    const active = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Active',
            ourBalance: '70',
            theirBalance: '30',
            gameAllocated: '20',
          },
        },
        game: {
          activeIds: ['game-1', 'game-2'],
          currentHandIds: ['game-1', 'game-2'],
          instances: {
            'game-1': pending('game-1'),
            'game-2': pending('game-2'),
          },
        },
      }),
    );
    expect(active).toEqual([
      { label: 'Me', value: '70' },
      { label: 'Opp', value: '30' },
      { label: 'Hand 1', value: '100' },
      { label: 'Hand 2', value: '100' },
    ]);

    const partiallyResolvedGroup = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Active',
            ourBalance: '85',
            theirBalance: '15',
            gameAllocated: '20',
          },
        },
        game: {
          activeIds: ['game-2'],
          currentHandIds: ['game-1', 'game-2'],
          instances: {
            'game-1': ended('game-1', '80'),
            'game-2': pending('game-2'),
          },
        },
      }),
    );
    expect(partiallyResolvedGroup).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
      { label: 'Hand', value: '100' },
    ]);

    const bothResolved = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Active',
            ourBalance: '85',
            theirBalance: '15',
            gameAllocated: '0',
          },
        },
        game: {
          currentHandIds: ['game-1', 'game-2'],
          instances: {
            'game-1': ended('game-1', '80'),
            'game-2': ended('game-2', '20'),
          },
        },
      }),
    );
    expect(bothResolved).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
    ]);

    const onChainSplits = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Unrolling',
            ourBalance: '85',
            theirBalance: '15',
            gameAllocated: '0',
          },
        },
        game: {
          activeIds: [],
          currentHandIds: ['game-1', 'game-2'],
          instances: {
            'game-1': ended('game-1', '80'),
            'game-2': ended('game-2', '20'),
          },
        },
      }),
    );
    expect(onChainSplits).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
      { label: 'Hand 1', value: '80', value2: '20' },
      { label: 'Hand 2', value: '20', value2: '80' },
    ]);

    const stale = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'ResolvedStale',
            ourBalance: '60',
            theirBalance: '40',
          },
        },
        game: {
          activeIds: ['game-1'],
          currentHandIds: ['game-1', 'game-2'],
          instances: {
            'game-1': pending('game-1'),
            'game-2': {
              ...pending('game-2'),
              coin: { coinHex: null, turnState: 'ended' },
              handStatus: 'ended',
              terminal: {
                type: 'game-error',
                outcome: null,
                label: 'Missing from stale unroll',
                myReward: null,
                rewardCoinHex: null,
              },
            },
          },
        },
      }),
    );
    expect(stale).toEqual([
      { label: 'Me', value: '60' },
      { label: 'Opp', value: '40' },
      { label: 'Hand 1', value: '100' },
    ]);

    const malformedReward = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Active',
            ourBalance: '85',
            theirBalance: '15',
            gameAllocated: '0',
          },
        },
        game: {
          currentHandIds: ['game-1'],
          instances: { 'game-1': ended('game-1', '101') },
        },
      }),
    );
    expect(malformedReward).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
    ]);

    const clean = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'ResolvedClean',
            ourBalance: '60',
            theirBalance: '40',
          },
        },
      }),
    );
    expect(clean).toEqual([
      { label: 'Me', value: '60' },
      { label: 'Opp', value: '40' },
    ]);

    const errored = selectStatusBarBalances(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Failed',
            ourBalance: '60',
            theirBalance: '40',
          },
        },
      }),
    );
    expect(errored).toEqual([
      { label: 'Me', value: '0' },
      { label: 'Opp', value: '?' },
    ]);
  });

  it('derives restore blocking and shell decisions from the canonical model', () => {
    const restoring = createSessionModel({
      restore: {
        restoring: true,
        status: 'restored',
        hubReconciled: false,
        error: null,
      },
      peer: { connected: false },
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        cleanShutdownStarted: false,
        dismissedChannelStatus: null,
        queue: [],
      },
    });

    expect(selectRestoreBlocked(restoring)).toBe(true);
    expect(selectSessionPhase(restoring)).toBe('off-chain');
    expect(selectShellView(restoring, 'off-chain')).toMatchObject({
      restoreBlocked: true,
      canAdvertiseAvailable: false,
      sessionError: false,
    });
  });

  it('keeps the game tab green during clean shutdown, yellow if peer drops, gray when done', () => {
    const shuttingDown = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ShuttingDown' },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        cleanShutdownStarted: true,
        dismissedChannelStatus: null,
        queue: [],
      },
    });
    expect(isCleanShutdownInProgress(shuttingDown)).toBe(true);
    // Peer stays live through cooperative close (keepalives continue).
    expect(
      selectGameTabDotColor({
        sessionPhase: 'off-chain',
        sessionError: false,
        peerLiveness: 'connected',
        cleanShutdownInProgress: true,
      }),
    ).toBe('green');
    // Real unreachability (silence / delivery failure) is yellow, not red.
    expect(
      selectGameTabDotColor({
        sessionPhase: 'off-chain',
        sessionError: false,
        peerLiveness: 'degraded',
        cleanShutdownInProgress: true,
      }),
    ).toBe('yellow');
    // Dead should not occur during clean shutdown; if it does, treat as yellow.
    expect(
      selectGameTabDotColor({
        sessionPhase: 'off-chain',
        sessionError: false,
        peerLiveness: 'dead',
        cleanShutdownInProgress: true,
      }),
    ).toBe('yellow');
    expect(
      selectGameTabDotColor({
        sessionPhase: 'resolved',
        sessionError: false,
        peerLiveness: 'connected',
        cleanShutdownInProgress: false,
      }),
    ).toBe('gray');
    // Outside clean shutdown, peer dead is still red.
    expect(
      selectGameTabDotColor({
        sessionPhase: 'off-chain',
        sessionError: false,
        peerLiveness: 'dead',
        cleanShutdownInProgress: false,
      }),
    ).toBe('red');
  });

  it('restores between-hand state into the same game view shape live state uses', () => {
    const save: SessionSave = {
      version: 11n,
      playerId: 'p1',
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: 3n,
      pairingToken: 'pair',
      messageNumber: 1n,
      remoteNumber: 0n,
      iStarted: true,
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      rewardPuzzleHash: '11'.repeat(32),
      unackedMessages: [],
      activeGameIds: [],
      channelStatus: {
        state: 'Active',
        advisory: null,
        coin: null,
        our_balance: '100',
        their_balance: '100',
        game_allocated: '0',
        have_potato: true,
      },
      betweenHandMode: 'review-incoming-proposal',
      betweenHandLastTerms: {
        my_contribution: '10',
        their_contribution: '10',
        game_timeout: '23',
        game_type: 'spacepoker',
        spacepoker_unit_size: '1',
      },
      betweenHandReviewPeerProposal: {
        id: '42',
        groupIds: ['42'],
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '31',
        game_type: 'spacepoker',
        spacepoker_unit_size: '2',
      },
    };

    const restored = sessionModelFromSave(save, 10n);
    const live = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active', havePotato: true },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        cleanShutdownStarted: false,
        dismissedChannelStatus: null,
        queue: [],
      },
      game: {
        handKey: 1,
        activeIds: [],
        lastDisplayedId: null,
        activeGameType: 'calpoker',
        handState: null,
        queue: [],
      },
      betweenHand: {
        mode: 'review-incoming-proposal',
        cachedPeerProposal: null,
        reviewPeerProposal: {
          id: '42',
          groupIds: ['42'],
          terms: {
            gameType: 'spacepoker',
            myContribution: 20n,
            theirContribution: 20n,
            gameTimeout: 31n,
            unitSizeMojos: 2n,
          },
        },
        rejectedOnceTerms: null,
        lastTerms: {
          gameType: 'spacepoker',
          myContribution: 10n,
          theirContribution: 10n,
          gameTimeout: 23n,
          unitSizeMojos: 1n,
        },
        compose: {
          selectedGame: 'spacepoker',
          gameTimeout: 23n,
          proposalSent: false,
          calpoker: { amount: 7n },
          krunk: { amount: 300n },
          spacepoker: { unitSize: 1n, stackSize: 10n },
        },
        newHandRequested: false,
        outgoingProposalIds: [],
        pendingRetryTerms: null,
      },
    });

    expect(selectGameSessionView(restored).betweenHands).toBe(true);
    expect(selectGameSessionView(restored).currentHandAmount).toBe(10n);
    expect(restored.betweenHand.reviewPeerProposal).toEqual(live.betweenHand.reviewPeerProposal);
    expect(restored.betweenHand.mode).toBe(live.betweenHand.mode);
  });

  it('keeps an unrolled session on-chain while an active game is unresolved', () => {
    const unrolledWithGame = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        cleanShutdownStarted: false,
        dismissedChannelStatus: null,
        queue: [],
      },
      game: {
        handKey: 1,
        activeIds: ['7'],
        currentHandIds: ['7'],
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: 'abcd', turnState: 'their-turn' },
            handStatus: 'their-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
        lastDisplayedId: '7',
        activeGameType: 'calpoker',
        handState: null,
        queue: [],
      },
    });

    expect(selectSessionPhase(unrolledWithGame)).toBe('on-chain');
    expect(selectShouldAdvertiseAvailable(unrolledWithGame, 'on-chain')).toBe(false);
    const resolvedNoGame = createSessionModel({
      channel: unrolledWithGame.channel,
      game: { ...unrolledWithGame.game, activeIds: [] },
    });
    expect(selectSessionPhase(resolvedNoGame)).toBe('resolved');
    expect(selectShouldAdvertiseAvailable(resolvedNoGame, 'resolved')).toBe(true);
  });

  it('keeps a successful go-on-chain call on-chain until its notification arrives', () => {
    const active = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' },
      },
      game: { activeIds: ['7'] },
    });

    expect(selectSessionPhase(active)).toBe('off-chain');
    expect(selectSessionPhase(active, true)).toBe('on-chain');

    // A terminal zero-payout remap from Rust remains authoritative over the
    // transient host result, so it never revives the session as on-chain.
    const abandoned = createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'ShuttingDown',
          sessionDisposition: 'Abandoned',
          zeroPayout: true,
        },
      },
    });
    expect(selectSessionPhase(abandoned, true)).toBe('resolved');
  });

  it('treats failed channel state as terminal resolved phase with separate error advisory', () => {
    const failed = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Failed' },
        connection: { stateIdentifier: 'end', stateDetail: [] },
        cleanShutdownStarted: false,
        dismissedChannelStatus: null,
        queue: [],
      },
    });

    expect(selectSessionPhase(failed)).toBe('resolved');
    expect(selectShouldAdvertiseAvailable(failed, 'resolved')).toBe(true);
  });

  it('makes the completed hand inert only while a between-hand dialog has content', () => {
    expect(selectInertGameInterfaceForBetweenHandDialog(true, 'decision', false, false)).toBe(
      false,
    );
    expect(
      selectInertGameInterfaceForBetweenHandDialog(true, 'compose-proposal', false, true),
    ).toBe(true);
    expect(
      selectInertGameInterfaceForBetweenHandDialog(true, 'review-incoming-proposal', true, true),
    ).toBe(true);
    expect(
      selectInertGameInterfaceForBetweenHandDialog(true, 'review-incoming-proposal', false, true),
    ).toBe(false);
    expect(
      selectInertGameInterfaceForBetweenHandDialog(true, 'compose-proposal', false, false),
    ).toBe(false);
    expect(
      selectInertGameInterfaceForBetweenHandDialog(false, 'compose-proposal', false, true),
    ).toBe(false);
  });

  it('parses saved session amounts through a shared bigint adapter', () => {
    expect(
      sessionAmountsFromSave({
        myContribution: '100',
        theirContribution: '50',
        perGameAmount: '45',
      }),
    ).toEqual({ myContribution: 100n, theirContribution: 50n, perGameAmount: 45n });

    expect(
      sessionAmountsFromSave({
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
      }),
    ).toEqual({ myContribution: 100n, theirContribution: 100n, perGameAmount: 10n });

    expect(() =>
      sessionAmountsFromSave({ myContribution: '100', theirContribution: '50' } as any),
    ).toThrow('Garbled save');

    expect(() =>
      sessionAmountsFromSave({
        myContribution: 'bad',
        theirContribution: '50',
        perGameAmount: '10',
      }),
    ).toThrow('Garbled save');

    expect(() =>
      sessionAmountsFromSave({ myContribution: '50', perGameAmount: '10' } as any),
    ).toThrow('Garbled save');
  });

  it('separates history, diagnostic log, and wasm notification history in snapshots', () => {
    const model = createSessionModel({
      history: {
        humanHistory: ['human line'],
        wasmNotificationHistory: ['{"ChannelStatus":{}}'],
        diagnosticLog: ['diag line'],
      },
    });

    expect(snapshotFromSessionModel(model)).toMatchObject({
      humanHistory: ['human line'],
      wasmNotificationHistory: ['{"ChannelStatus":{}}'],
      diagnosticLog: ['diag line'],
    });
  });

  it('derives game-specific view from canonical game state', () => {
    const model = createSessionModel({
      game: {
        handKey: 2,
        activeIds: ['7'],
        currentHandIds: ['7'],
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: 'abcd', turnState: 'replaying' },
            handStatus: 'replaying-move',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
        },
        lastDisplayedId: '6',
        activeGameType: 'spacepoker',
        handState: null,
        queue: [],
      },
    });

    expect(selectGameSpecificView(model)).toMatchObject({
      gameType: 'spacepoker',
      displayGameId: '7',
      turnState: 'replaying',
    });
  });

  it('maps frontend Calpoker starter role to the opposite initial mover', () => {
    expect(gameInitialTurn('calpoker', true)).toBe('their-turn');
    expect(gameInitialTurn('calpoker', false)).toBe('my-turn');
  });

  it('does not regress terminal hand status when a local turn callback arrives late', () => {
    expect(nextGameTurnAfterLocalTurn('ended', false, 'Unrolling')).toBe('ended');
    expect(nextGameTurnAfterLocalTurn('finishing', true, 'ResolvedUnrolled')).toBe('finishing');
    expect(nextGameTurnAfterLocalTurn('playing-on-chain', true, 'Unrolling')).toBe(
      'playing-on-chain',
    );
    expect(nextGameTurnAfterLocalTurn('replaying', true, 'ResolvedUnrolled')).toBe('replaying');
    expect(nextGameTurnAfterLocalTurn('my-turn', false, 'Unrolling')).toBe('my-turn');
    expect(nextGameTurnAfterLocalTurn('my-turn', false, 'Active')).toBe('their-turn');
  });

  it('keeps an in-progress on-chain play/replay from reverting to "Your turn"', () => {
    // While the hook is (re)playing our move on-chain, an on-chain-my-turn for
    // the same coin must not downgrade the display back to 'Your turn'.
    expect(isActivelyPlayingOnChain('playing-on-chain')).toBe(true);
    expect(isActivelyPlayingOnChain('replaying')).toBe(true);
    // A genuine new (manual) turn arrives from 'their-turn', and other states
    // are not active play, so they still take the my-turn transition.
    expect(isActivelyPlayingOnChain('their-turn')).toBe(false);
    expect(isActivelyPlayingOnChain('my-turn')).toBe(false);
    expect(isActivelyPlayingOnChain('finishing')).toBe(false);
    expect(isActivelyPlayingOnChain('ended')).toBe(false);
  });

  it('marks terminal moves as finishing regardless of their wire turn status', () => {
    expect(isFinishingGameStatus('on-chain-my-turn', true)).toBe(true);
    expect(isFinishingGameStatus('on-chain-their-turn', true)).toBe(true);
    expect(isFinishingGameStatus('my-turn', true)).toBe(true);
    expect(isFinishingGameStatus('their-turn', true)).toBe(true);
    expect(isFinishingGameStatus('on-chain-my-turn', false)).toBe(false);
    expect(
      projectGameStatus({
        previous: {
          id: '7',
          amount: '100',
          coin: { coinHex: 'coin', turnState: 'my-turn', onChain: true },
          handStatus: 'our-turn',
          terminal: INITIAL_GAME_TERMINAL_MODEL,
        },
        payload: {
          id: '7',
          status: 'on-chain-my-turn',
          coin_id: 'coin',
          other_params: { game_finished: true },
        },
        channelState: 'ResolvedUnrolled',
      }),
    ).toMatchObject({
      coin: { turnState: 'finishing' },
      handStatus: 'finishing',
    });
  });

  it('orders readable gameplay events before the Settled marker', () => {
    const notification = {
      GameStatus: {
        id: '7',
        status: 'their-turn',
        coin_id: null,
        other_params: {
          readable: [1, 2, 3],
          mover_share: '0',
        },
      },
    };

    const terminalEvent = {
      Settled: { gameId: '7', outcome: 'lost' as const, ourShare: '0' },
    };
    expect(gameplayEventsForGameStatus(notification, ['7'], terminalEvent)).toEqual([
      { OpponentMoved: { readable: Uint8Array.from([1, 2, 3]), gameId: '7', moverShare: '0' } },
      { Settled: { gameId: '7', outcome: 'lost', ourShare: '0' } },
    ]);
  });

  it('always emits Settled gameplay events including clean settles', () => {
    expect(
      settledEventForInfo('7', {
        type: 'settled',
        outcome: 'settled_cleanly',
        label: 'Settled cleanly',
        myReward: '20',
        rewardCoinHex: null,
      }),
    ).toEqual({
      Settled: { gameId: '7', outcome: 'settled_cleanly', ourShare: '20' },
    });
  });
});
