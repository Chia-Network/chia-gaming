import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  selectDefaultCalpokerInitialTurn,
  selectDefaultCalpokerProposalMyTurn,
  selectGameDashboardView,
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
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'WaitingForOffer' } },
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

  it('uses hand terminology for per-hand dashboard details', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      game: {
        activeIds: ['7'],
        coin: { coinHex: 'abcd', turnState: 'playing-on-chain' },
        terminal: { type: 'none', label: null, myReward: null, rewardCoinHex: null },
      },
    }), { currentHandSize: '10 mojos' });

    expect(view.handStatusLabel).toBe('Active');
    expect(view.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Hand size', value: '10 mojos' }),
      expect.objectContaining({ label: 'Hand status', value: 'Active' }),
      expect.objectContaining({ label: 'Raw turn state', value: 'Playing our move on-chain' }),
      expect.objectContaining({ label: 'Hand result', value: null }),
    ]));
    expect(view.details.some(row => row.label === 'Game state' || row.label === 'Game size')).toBe(false);
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
        coin: { coinHex: 'abcd', turnState: 'replaying' },
      },
    })).handStatusLabel).toBe('Playing move');
  });

  it('summarizes terminal hands in the bar while keeping result details expanded', () => {
    const view = selectGameDashboardView(createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' } },
      game: {
        coin: { coinHex: null, turnState: 'ended' },
        terminal: {
          type: 'opponent-timed-out',
          label: 'Opponent timed out',
          myReward: '20',
          rewardCoinHex: null,
        },
      },
    }));

    expect(view.handStatusLabel).toBe('Ended');
    expect(view.handDetail).toBeNull();
    expect(view.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Hand status', value: 'Ended' }),
      expect.objectContaining({ label: 'Terminal kind', value: 'opponent-timed-out' }),
      expect.objectContaining({ label: 'Hand result', value: 'Opponent timed out' }),
    ]));
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
    expect(view.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Terminal kind', value: 'we-timed-out' }),
      expect.objectContaining({ label: 'Hand result', value: 'Move too late' }),
    ]));
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
    expect(view.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Hand status', value: 'Ended' }),
      expect.objectContaining({ label: 'Hand result', value: 'Forfeited' }),
    ]));
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
      shouldAutoGoOnChain: false,
      sessionError: false,
    });

    const reconciled = updateSessionModel(restoring, { type: 'tracker-reconciled', reconciled: true });
    expect(selectShellView(reconciled, 'off-chain').shouldAutoGoOnChain).toBe(true);
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
    )).toEqual({ amount: 123n, perGameAmount: 45n });

    expect(sessionAmountsFromSave(
      { amount: 'bad', perGameAmount: undefined },
      1n,
      2n,
    )).toEqual({ amount: 1n, perGameAmount: 2n });
  });

  it('separates history, diagnostic log, chat, and wasm notification history in snapshots', () => {
    const model = createSessionModel({
      history: {
        humanHistory: ['human line'],
        wasmNotificationHistory: ['{"ChannelStatus":{}}'],
        diagnosticLog: ['diag line'],
        chatMessages: [{ text: 'hi', fromAlias: 'me', timestamp: 1n, isMine: true }],
      },
    });

    expect(snapshotFromSessionModel(model)).toMatchObject({
      humanHistory: ['human line'],
      wasmNotificationHistory: ['{"ChannelStatus":{}}'],
      diagnosticLog: ['diag line'],
      chatMessages: [{ text: 'hi', fromAlias: 'me', timestamp: 1n, isMine: true }],
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

    const terminalEvent = { Timeout: { byUs: false } };
    expect(gameplayEventsForGameStatus(notification, ['7'], terminalEvent)).toEqual([
      { OpponentMoved: { readable: Uint8Array.from([1, 2, 3]) } },
      { Timeout: { byUs: false } },
    ]);
  });
});
