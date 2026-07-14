import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  selectDefaultCalpokerInitialTurn,
  selectDefaultCalpokerProposalMyTurn,
  selectComposeAmountAfterGameTypeChoice,
  selectGameDashboardView,
  selectStatusBarBalances,
  selectGameSessionView,
  selectGameSpecificView,
  selectHideGameInterfaceForBetweenHandDialog,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
  selectSessionPhase,
  selectShellView,
  sessionAmountsFromSave,
  sessionModelFromSave,
  snapshotFromSessionModel,
  updateSessionModel,
} from '../session/model';
import type { SessionState } from '../../hooks/save';
import {
  gameplayEventsForGameStatus,
  nextGameInstanceAfterLocalTurn,
  nextGameTurnAfterLocalTurn,
  isActivelyPlayingOnChain,
  isFinishingGameStatus,
  parseGameStatusTerminalInfo,
  terminalEventForInfo,
} from '../../hooks/useGameSession';

describe('session model selectors', () => {
  it('derives dashboard actions for no-session, waiting, active, and terminal states', () => {
    expect(selectGameDashboardView(null)).toMatchObject({
      channelStatusLabel: 'No Session',
      handStatusLabel: 'No hand',
      actionLabel: 'No Session',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'MakingOffer' } },
    }))).toMatchObject({
      actionLabel: 'Cancel',
      actionEnabled: true,
      actionKind: 'cancel',
    });

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'OfferSent' } },
    }))).toMatchObject({
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: { activeIds: [] },
    }))).toMatchObject({
      channelStatusLabel: 'Active',
      handStatusLabel: 'No hand',
      actionLabel: 'Clean Shutdown',
      actionEnabled: true,
      actionKind: 'clean-shutdown',
    });
    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active', havePotato: true } },
      game: { activeIds: [] },
    })).channelStatusLabel).toBe('Active');
    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: { activeIds: [] },
    }), { cleanShutdownGraceActive: true })).toMatchObject({
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: { activeIds: ['7'] },
    }))).toMatchObject({
      handStatusLabel: 'Active',
      actionLabel: 'Go On-Chain',
      actionEnabled: true,
      actionKind: 'go-on-chain',
    });

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedClean' } },
    }))).toMatchObject({
      actionLabel: 'Done',
      actionEnabled: false,
      channelDetail: null,
    });
  });

  it('uses a clean-shutdown grace window before offering go-on-chain escalation', () => {
    const shuttingDown = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ShuttingDown' },
        cleanShutdownStarted: true,
      },
    });

    expect(selectGameDashboardView(shuttingDown, { cleanShutdownGraceActive: true })).toMatchObject({
      actionLabel: 'Waiting',
      actionEnabled: false,
      actionKind: 'none',
    });
    expect(selectGameDashboardView(shuttingDown, { cleanShutdownGraceActive: false })).toMatchObject({
      actionLabel: 'Go On-Chain',
      actionEnabled: true,
      actionKind: 'go-on-chain',
    });
  });

  it('enables abandon action after timeout for waiting states', () => {
    const waitingStates = [
      'OfferSent', 'TransactionPending', 'ShutdownTransactionPending',
      'GoingOnChain', 'Unrolling',
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
    const cleanShutdown = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: { activeIds: [] },
    }));
    expect(cleanShutdown).toMatchObject({
      actionLabel: 'Clean Shutdown',
      actionEnabled: true,
      actionKind: 'clean-shutdown',
    });

    const goOnChain = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: { activeIds: ['7'] },
    }));
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
        coin: { coinHex: null, turnState: 'ended' },
        terminal: {
          type: 'forfeit',
          label: 'Forfeited',
          myReward: '20',
          rewardCoinHex: null,
        },
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
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
        terminal: { type: 'none', label: null, myReward: null, rewardCoinHex: null },
      },
    }));

    expect(view.handStatusLabel).toBe('Active');
    expect(view.handDetail).toBeNull();
  });

  it('uses turn-specific hand status in the bar only once a game coin is on-chain', () => {
    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'their-turn' },
      },
    })).handStatusLabel).toBe('Active');

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: null, turnState: 'their-turn' },
      },
    })).handStatusLabel).toBe('Active');

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'their-turn' },
      },
    })).handStatusLabel).toBe('Their turn');

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
      },
    })).handStatusLabel).toBe('Playing move');

    // 'replaying' is a distinct WASM state (a redo replayed after unroll) and is
    // communicated as 'Replaying move', not collapsed into 'Playing move'.
    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'replaying' },
      },
    })).handStatusLabel).toBe('Replaying move');

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'finishing' },
      },
    })).handStatusLabel).toBe('Finishing');

    // Detecting the opponent's illegal on-chain move puts us in the slash flow;
    // the bar should say so explicitly instead of a generic "Your turn".
    const slashing = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'opponent-illegal-move' },
      },
    }));
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

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game,
    })).lifecycleRows).toEqual([]);

    expect(selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game,
    })).lifecycleRows).toEqual([
      { id: '7', label: 'Hand 1', statusLabel: 'Your turn', detail: null },
      { id: '9', label: 'Hand 2', statusLabel: 'Their turn', detail: null },
    ]);
  });

  it('derives Playing move identically for one or many keyed games', () => {
    const makeInstance = (id: string, handStatus: 'our-turn' | 'their-turn') => ({
      id,
      amount: '100',
      coin: { coinHex: `${id}${id}`, turnState: handStatus === 'our-turn' ? 'my-turn' as const : 'their-turn' as const },
      handStatus,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    });
    const first = makeInstance('7', 'our-turn');
    const second = makeInstance('9', 'their-turn');
    const updated = {
      '7': nextGameInstanceAfterLocalTurn(first, false, 'Unrolling'),
      '9': second,
    };

    expect(updated['7']).toMatchObject({
      coin: { turnState: 'playing-on-chain' },
      handStatus: 'playing-move',
    });
    expect(updated['9']).toBe(second);
    expect(nextGameInstanceAfterLocalTurn(first, true, 'Active')).toMatchObject({
      coin: { turnState: 'my-turn' },
      handStatus: 'active',
    });

    const singleton = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: { activeIds: ['7'], currentHandIds: ['7'], instances: { '7': updated['7'] } },
    }));
    const multiple = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: { activeIds: ['7', '9'], currentHandIds: ['7', '9'], instances: updated },
    }));
    expect(singleton.lifecycleRows[0]).toMatchObject({ label: 'Hand', statusLabel: 'Playing move' });
    expect(multiple.lifecycleRows).toEqual([
      { id: '7', label: 'Hand 1', statusLabel: 'Playing move', detail: null },
      { id: '9', label: 'Hand 2', statusLabel: 'Their turn', detail: null },
    ]);
  });

  it('shows a premature opponent timeout as an explicit ended detail', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        coin: { coinHex: null, turnState: 'ended' },
        terminal: {
          type: 'opponent-timed-out',
          label: 'Opponent took too long to move',
          myReward: '20',
          rewardCoinHex: 'abcd',
        },
      },
    }));

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Opponent took too long to move');
  });

  it('keeps a clean opponent timeout collapsed (no premature-timeout detail)', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        coin: { coinHex: null, turnState: 'ended' },
        terminal: {
          type: 'opponent-timed-out',
          label: 'Ended cleanly',
          myReward: '20',
          rewardCoinHex: null,
          cleanEnd: true,
        },
      },
    }));

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBeNull();
  });

  it('shows move-too-late as an ended detail distinct from forfeit', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        coin: { coinHex: null, turnState: 'ended' },
        terminal: {
          type: 'we-timed-out',
          label: 'Move too late',
          myReward: '0',
          rewardCoinHex: null,
        },
      },
    }));

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Move too late');
  });

  it('labels off-chain non-terminal accepts as folds instead of timeouts', () => {
    expect(parseGameStatusTerminalInfo({
      id: '7',
      status: 'ended-we-timed-out',
      my_reward: { amt: 0n },
      coin_id: null,
      reason: null,
      other_params: null,
    }, null, 'my-turn')).toMatchObject({
      label: 'Folded',
    });

    expect(parseGameStatusTerminalInfo({
      id: '7',
      status: 'ended-opponent-timed-out',
      my_reward: { amt: 20n },
      coin_id: null,
      reason: null,
      other_params: null,
    }, null, 'their-turn')).toMatchObject({
      label: 'Opponent folded',
    });
  });

  it('does not mislabel an explicit on-chain clock timeout as a fold', () => {
    expect(parseGameStatusTerminalInfo({
      id: '7',
      status: 'ended-we-timed-out',
      my_reward: { amt: 0n },
      coin_id: null,
      reason: null,
      other_params: { forfeited: false },
    }, null, 'my-turn')).toMatchObject({
      type: 'we-timed-out',
      label: 'Timed out',
    });

    expect(parseGameStatusTerminalInfo({
      id: '7',
      status: 'ended-opponent-timed-out',
      my_reward: { amt: 20n },
      coin_id: null,
      reason: null,
      other_params: { forfeited: false },
    }, null, 'their-turn')).toMatchObject({
      type: 'opponent-timed-out',
      label: 'Opponent timed out',
    });
  });

  it('keeps explicit on-chain move-too-late labels', () => {
    expect(parseGameStatusTerminalInfo({
      id: '7',
      status: 'ended-we-timed-out',
      my_reward: { amt: 0n },
      coin_id: null,
      reason: 'move too late',
      other_params: null,
    }, null, 'their-turn')).toMatchObject({
      label: 'Move too late',
    });
  });

  it('prefers terminal hand state over stale on-chain turn state', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
        terminal: {
          type: 'forfeit',
          label: 'Forfeited',
          myReward: '20',
          rewardCoinHex: null,
        },
      },
    }));

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBe('Forfeited');
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
        type: 'opponent-timed-out' as const,
        label: 'Ended cleanly',
        myReward,
        rewardCoinHex: null,
        cleanEnd: true,
      },
    });

    const active = selectStatusBarBalances(createSessionModel({
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
    }));
    expect(active).toEqual([
      { label: 'Me', value: '70' },
      { label: 'Opp', value: '30' },
      { label: 'Hand 1', value: '100' },
      { label: 'Hand 2', value: '100' },
    ]);

    const partiallyResolvedGroup = selectStatusBarBalances(createSessionModel({
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
    }));
    expect(partiallyResolvedGroup).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
      { label: 'Hand', value: '100' },
    ]);

    const bothResolved = selectStatusBarBalances(createSessionModel({
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
    }));
    expect(bothResolved).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
    ]);

    const onChainSplits = selectStatusBarBalances(createSessionModel({
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
    }));
    expect(onChainSplits).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
      { label: 'Hand 1', value: '80', value2: '20' },
      { label: 'Hand 2', value: '20', value2: '80' },
    ]);

    const malformedReward = selectStatusBarBalances(createSessionModel({
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
    }));
    expect(malformedReward).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
    ]);

    const clean = selectStatusBarBalances(createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedClean', ourBalance: '60', theirBalance: '40' },
      },
      game: {
        terminal: { type: 'opponent-timed-out', label: 'done', myReward: '10', rewardCoinHex: null, cleanEnd: true },
      },
    }));
    expect(clean).toEqual([
      { label: 'Me', value: '60' },
      { label: 'Opp', value: '40' },
    ]);

    const errored = selectStatusBarBalances(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Failed', ourBalance: '60', theirBalance: '40' } },
    }));
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
        trackerReconciled: false,
        error: null,
      },
      peer: { connected: false },
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        goOnChainPressed: false,
        cleanShutdownStarted: false,
        dismissedChannelState: null,
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

  it('restores between-hand state into the same game view shape live state uses', () => {
    const save: SessionState = {
      version: 5n,
      playerId: 'p1',
      serializedCradle: new Uint8Array([1, 2, 3]),
      channelReady: true,
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
      },
      betweenHandReviewPeerProposal: {
        id: '42',
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '31',
        game_type: 'spacepoker',
      },
    };

    const restored = sessionModelFromSave(save, 10n);
    const live = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active', havePotato: true },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        goOnChainPressed: false,
        cleanShutdownStarted: false,
        dismissedChannelState: null,
        queue: [],
      },
      game: {
        coin: { coinHex: null, turnState: 'my-turn' },
        terminal: INITIAL_GAME_TERMINAL_MODEL,
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
          groupIds: [],
          terms: { gameType: 'spacepoker', myContribution: 20n, theirContribution: 20n, gameTimeout: 31n, spacepokerUnitSize: 2n },
        },
        rejectedOnceTerms: null,
        lastTerms: { gameType: 'spacepoker', myContribution: 10n, theirContribution: 10n, gameTimeout: 23n, spacepokerUnitSize: 1n },
        composePerHandAmount: 10n,
        composeGameTimeout: 23n,
        composeGameType: 'spacepoker',
        composeProposalSent: false,
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

  it('normalizes restored notification ids to bigint', () => {
    const save = {
      version: 5n,
      playerId: 'p1',
      channelNotifQueue: [
        { id: 7, kind: 'channel-state', title: 'Channel', message: 'Ready' },
      ],
      gameNotifQueue: [
        { id: '8', kind: 'game-terminal', title: 'Game', message: 'Done' },
      ],
    } as unknown as SessionState;

    const restored = sessionModelFromSave(save);

    expect(restored.channel.queue[0].id).toBe(7n);
    expect(restored.game.queue[0].id).toBe(8n);
  });

  it('round-trips hand status through session snapshots', () => {
    const model = createSessionModel({
      game: {
        handStatus: 'playing-move',
        coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.gameHandStatus).toBe('playing-move');

    const restored = sessionModelFromSave({
      version: 5n,
      playerId: 'p1',
      gameHandStatus: snapshot.gameHandStatus,
      gameCoinHex: snapshot.gameCoinHex,
      gameTurnState: snapshot.gameTurnState,
    });
    expect(restored.game.handStatus).toBe('playing-move');
    expect(restored.game.coin.turnState).toBe('playing-on-chain');
  });

  it('round-trips current-hand game instances through session snapshots', () => {
    const model = createSessionModel({
      game: {
        currentHandIds: ['7', '9'],
        instances: {
          '7': {
            id: '7',
            amount: '100',
            coin: { coinHex: 'aaaa', turnState: 'my-turn' },
            handStatus: 'our-turn',
            terminal: INITIAL_GAME_TERMINAL_MODEL,
          },
          '9': {
            id: '9',
            amount: '100',
            coin: { coinHex: null, turnState: 'ended' },
            handStatus: 'ended',
            terminal: {
              type: 'opponent-timed-out',
              label: 'Ended cleanly',
              myReward: '80',
              rewardCoinHex: null,
              cleanEnd: true,
            },
          },
        },
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    const restored = sessionModelFromSave({
      version: 5n,
      playerId: 'p1',
      currentHandGameIds: snapshot.currentHandGameIds,
      gameInstances: snapshot.gameInstances,
    });

    expect(restored.game.currentHandIds).toEqual(['7', '9']);
    expect(restored.game.instances).toEqual(model.game.instances);
  });

  it('keeps an unrolled session on-chain while an active game is unresolved', () => {
    const unrolledWithGame = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' },
        connection: { stateIdentifier: 'running', stateDetail: [] },
        goOnChainPressed: true,
        cleanShutdownStarted: false,
        dismissedChannelState: null,
        queue: [],
      },
      game: {
        coin: { coinHex: 'abcd', turnState: 'their-turn' },
        terminal: INITIAL_GAME_TERMINAL_MODEL,
        handKey: 1,
        activeIds: ['7'],
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

  it('treats failed channel state as terminal resolved phase with separate error advisory', () => {
    const failed = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Failed' },
        connection: { stateIdentifier: 'end', stateDetail: [] },
        goOnChainPressed: true,
        cleanShutdownStarted: false,
        dismissedChannelState: null,
        queue: [],
      },
    });

    expect(selectSessionPhase(failed)).toBe('resolved');
    expect(selectShouldAdvertiseAvailable(failed, 'resolved')).toBe(true);
  });

  it('hides completed hand UI while compose or review dialogs are open between hands', () => {
    expect(selectHideGameInterfaceForBetweenHandDialog(true, 'decision')).toBe(false);
    expect(selectHideGameInterfaceForBetweenHandDialog(true, 'compose-proposal')).toBe(true);
    expect(selectHideGameInterfaceForBetweenHandDialog(true, 'review-incoming-proposal')).toBe(true);
    expect(selectHideGameInterfaceForBetweenHandDialog(false, 'compose-proposal')).toBe(false);
  });

  it('parses saved session amounts through a shared bigint adapter', () => {
    expect(sessionAmountsFromSave(
      { myContribution: '100', theirContribution: '50', perGameAmount: '45' },
    )).toEqual({ myContribution: 100n, theirContribution: 50n, perGameAmount: 45n });

    expect(sessionAmountsFromSave(
      { myContribution: '100', theirContribution: '100', perGameAmount: '10' },
    )).toEqual({ myContribution: 100n, theirContribution: 100n, perGameAmount: 10n });

    expect(() => sessionAmountsFromSave(
      { myContribution: '100', theirContribution: '50' } as any,
    )).toThrow('Garbled save');

    expect(() => sessionAmountsFromSave(
      { myContribution: 'bad', theirContribution: '50', perGameAmount: '10' },
    )).toThrow('Garbled save');

    expect(() => sessionAmountsFromSave(
      { myContribution: '50', perGameAmount: '10' } as any,
    )).toThrow('Garbled save');
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
        coin: { coinHex: 'abcd', turnState: 'replaying' },
        terminal: { type: 'none', label: null, myReward: null, rewardCoinHex: null },
        handKey: 2,
        activeIds: ['7'],
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
    expect(selectDefaultCalpokerProposalMyTurn(true)).toBe(false);
    expect(selectDefaultCalpokerInitialTurn(true)).toBe('their-turn');

    expect(selectDefaultCalpokerProposalMyTurn(false)).toBe(true);
    expect(selectDefaultCalpokerInitialTurn(false)).toBe('my-turn');
  });

  it('defaults Krunk to 100 only when it is selected', () => {
    expect(selectComposeAmountAfterGameTypeChoice('calpoker', 'krunk', 25n)).toBe(100n);
    expect(selectComposeAmountAfterGameTypeChoice('krunk', 'krunk', 300n)).toBe(300n);
    expect(selectComposeAmountAfterGameTypeChoice('krunk', 'calpoker', 300n)).toBe(300n);
  });

  it('does not regress an ended hand when a local turn callback arrives late', () => {
    expect(nextGameTurnAfterLocalTurn('ended', false, 'Unrolling')).toBe('ended');
    expect(nextGameTurnAfterLocalTurn('my-turn', false, 'Unrolling')).toBe('playing-on-chain');
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

  it('marks either side of a terminal on-chain coin as finishing', () => {
    expect(isFinishingGameStatus('on-chain-my-turn', true)).toBe(true);
    expect(isFinishingGameStatus('on-chain-their-turn', true)).toBe(true);
    expect(isFinishingGameStatus('on-chain-my-turn', false)).toBe(false);
    expect(isFinishingGameStatus('my-turn', true)).toBe(false);
  });

  it('orders terminal readable gameplay events before the terminal marker', () => {
    const notification = {
      GameStatus: {
        id: '7',
        status: 'ended-opponent-timed-out',
        coin_id: null,
        other_params: {
          readable: [1, 2, 3],
          mover_share: '0',
          forfeited: true,
        },
      },
    };

    const terminalEvent = { Timeout: { gameId: '7', byUs: false, forfeited: true } };
    expect(gameplayEventsForGameStatus(notification, ['7'], terminalEvent)).toEqual([
      { OpponentMoved: { readable: Uint8Array.from([1, 2, 3]), gameId: '7' } },
      { Timeout: { gameId: '7', byUs: false, forfeited: true } },
    ]);
  });

  it('does not emit gameplay timeout events for clean terminal accepts', () => {
    expect(terminalEventForInfo('7', {
      type: 'opponent-timed-out',
      label: 'Ended cleanly',
      myReward: '20',
      rewardCoinHex: null,
      cleanEnd: true,
    }, 'ended-opponent-timed-out')).toBeNull();
  });
});
