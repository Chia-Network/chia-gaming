import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  selectDefaultCalpokerInitialTurn,
  selectDefaultCalpokerProposalMyTurn,
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
  nextGameTurnAfterLocalTurn,
  isActivelyPlayingOnChain,
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
    // Mid-hand Hand shows the running pot total (both contributions) as a single
    // value, derived from the hand terms.  game_allocated reads 0 during the
    // hand, so the pot comes from terms while a game is active.
    const active = selectStatusBarBalances(createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'Active',
          ourBalance: '70',
          theirBalance: '30',
          gameAllocated: '0',
        },
      },
      betweenHand: {
        lastTerms: { gameType: 'calpoker', myContribution: 10n, theirContribution: 10n, gameTimeout: 15n },
      },
      game: {
        activeIds: ['game-1'],
      },
    }));
    expect(active).toEqual([
      { label: 'Me', value: '70' },
      { label: 'Opp', value: '30' },
      { label: 'Hand', value: '20' },
    ]);

    // At hand end Me/Opp stay and Hand shows the mine/opp split (pot from the
    // hand terms, since game_allocated is back to zero).
    const reward = selectStatusBarBalances(createSessionModel({
      channel: {
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'Active',
          ourBalance: '85',
          theirBalance: '15',
          gameAllocated: '0',
        },
      },
      betweenHand: {
        lastTerms: { gameType: 'calpoker', myContribution: 10n, theirContribution: 10n, gameTimeout: 15n },
      },
      game: {
        coin: { coinHex: null, turnState: 'ended' },
        terminal: { type: 'we-slashed-opponent', label: 'We won', myReward: '15', rewardCoinHex: null },
      },
    }));
    expect(reward).toEqual([
      { label: 'Me', value: '85' },
      { label: 'Opp', value: '15' },
      { label: 'Hand', value: '15', value2: '5' },
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
      version: 3,
      playerId: 'p1',
      serializedCradle: 'abc',
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
      version: 3,
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
      version: 3n,
      playerId: 'p1',
      gameHandStatus: snapshot.gameHandStatus,
      gameCoinHex: snapshot.gameCoinHex,
      gameTurnState: snapshot.gameTurnState,
    });
    expect(restored.game.handStatus).toBe('playing-move');
    expect(restored.game.coin.turnState).toBe('playing-on-chain');
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
      { amount: '123', perGameAmount: '45' },
      1n,
      2n,
    )).toEqual({ amount: 123n, myContribution: 1n, theirContribution: 1n, perGameAmount: 45n });

    expect(sessionAmountsFromSave(
      { amount: 'bad', perGameAmount: undefined },
      1n,
      2n,
    )).toEqual({ amount: 1n, myContribution: 1n, theirContribution: 1n, perGameAmount: 2n });
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

    const terminalEvent = { Timeout: { byUs: false, forfeited: true } };
    expect(gameplayEventsForGameStatus(notification, ['7'], terminalEvent)).toEqual([
      { OpponentMoved: { readable: Uint8Array.from([1, 2, 3]) } },
      { Timeout: { byUs: false, forfeited: true } },
    ]);
  });

  it('does not emit gameplay timeout events for clean terminal accepts', () => {
    expect(terminalEventForInfo({
      type: 'opponent-timed-out',
      label: 'Ended cleanly',
      myReward: '20',
      rewardCoinHex: null,
      cleanEnd: true,
    }, 'ended-opponent-timed-out')).toBeNull();
  });
});
