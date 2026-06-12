import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  selectDefaultCalpokerInitialTurn,
  selectDefaultCalpokerProposalMyTurn,
  selectGameSessionView,
  selectGameSpecificView,
  selectHideGameInterfaceForBetweenHandDialog,
  selectRestoreBlocked,
  selectSessionPhase,
  selectShellView,
  sessionAmountsFromSave,
  sessionModelFromSave,
  snapshotFromSessionModel,
  updateSessionModel,
} from '../session/model';
import type { SessionState } from '../../hooks/save';

describe('session model selectors', () => {
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
        game_type: 'spacepoker',
      },
      betweenHandReviewPeerProposal: {
        id: '42',
        my_contribution: '20',
        their_contribution: '20',
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
          terms: { gameType: 'spacepoker', myContribution: 20n, theirContribution: 20n, spacepokerUnitSize: 2n },
        },
        rejectedOnceTerms: null,
        lastTerms: { gameType: 'spacepoker', myContribution: 10n, theirContribution: 10n, spacepokerUnitSize: 1n },
        composePerHandAmount: 10n,
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
        chatMessages: [{ text: 'hi', fromAlias: 'me', timestamp: 1, isMine: true }],
      },
    });

    expect(snapshotFromSessionModel(model)).toMatchObject({
      humanHistory: ['human line'],
      wasmNotificationHistory: ['{"ChannelStatus":{}}'],
      diagnosticLog: ['diag line'],
      chatMessages: [{ text: 'hi', fromAlias: 'me', timestamp: 1, isMine: true }],
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
});
