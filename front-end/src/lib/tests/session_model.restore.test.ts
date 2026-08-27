import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  selectGameSessionView,
  selectGameSpecificView,
  selectInertGameInterfaceForBetweenHandDialog,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
  selectSessionPhase,
  selectShellView,
  selectGameTabConnected,
  isCleanShutdownInProgress,
  sessionAmountsFromSave,
  sessionModelFromSave,
  snapshotFromSessionModel,
  isFinishingGameStatus,
  nextGameTurnAfterLocalTurn,
  isActivelyPlayingOnChain,
  projectGameStatus,
} from '../session/model';
import type { SessionSave } from '../../hooks/save';
import { liveSave } from './session_save_envelope.fixtures';

function liveEnvelope(fields: Partial<SessionSave>): SessionSave {
  return liveSave({
    myContribution: '100',
    theirContribution: '100',
    perGameAmount: '10',
    ...(fields as unknown as Record<string, unknown>),
  });
}

describe('session model restore, schema, and event contracts', () => {
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

  it('treats a live game tab as connected until the peer is dead or the session ends', () => {
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
    expect(
      selectGameTabConnected({
        sessionPhase: 'off-chain',
        peerLiveness: 'connected',
      }),
    ).toBe(true);
    expect(
      selectGameTabConnected({
        sessionPhase: 'off-chain',
        peerLiveness: 'degraded',
      }),
    ).toBe(true);
    expect(
      selectGameTabConnected({
        sessionPhase: 'off-chain',
        peerLiveness: null,
      }),
    ).toBe(true);
    expect(
      selectGameTabConnected({
        sessionPhase: 'off-chain',
        peerLiveness: 'dead',
      }),
    ).toBe(false);
    expect(
      selectGameTabConnected({
        sessionPhase: 'none',
        peerLiveness: null,
      }),
    ).toBe(false);
    expect(
      selectGameTabConnected({
        sessionPhase: 'resolved',
        peerLiveness: 'connected',
      }),
    ).toBe(false);
    expect(
      selectGameTabConnected({
        sessionPhase: 'on-chain',
        peerLiveness: 'dead',
      }),
    ).toBe(false);
    expect(
      selectGameTabConnected({
        sessionPhase: 'on-chain',
        peerLiveness: 'connected',
      }),
    ).toBe(true);
  });

  it('restores between-hand state into the same game view shape live state uses', () => {
    const save: SessionSave = liveEnvelope({
      version: 21n,
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
      activeGameType: 'spacepoker',
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
      betweenHandLastHandProposal: {
        player_a_contribution: '10',
        player_b_contribution: '10',
        sender_is_player_a: false,
        game_timeout: '23',
        game_type: 'spacepoker',
        parameters: 1n,
      },
      proposalGroups: [
        {
          primary_id: '42',
          member_ids: ['42'],
          origin: 'peer',
          disposition: 'incoming-review',
          hand_proposal: {
            player_a_contribution: '20',
            player_b_contribution: '20',
            sender_is_player_a: false,
            game_timeout: '31',
            game_type: 'spacepoker',
            parameters: 2n,
          },
        },
      ],
    });

    const restored = sessionModelFromSave(save);
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
        activeGameType: 'spacepoker',
        handState: null,
        queue: [],
      },
      betweenHand: {
        mode: 'review-incoming-proposal',
        proposalGroups: [
          {
            primaryId: '42',
            memberIds: ['42'],
            origin: 'peer',
            disposition: 'incoming-review',
            handProposal: {
              gameType: 'spacepoker',
              playerAContribution: 20n,
              playerBContribution: 20n,
              senderIsPlayerA: false,
              gameTimeout: 31n,
              parameters: 2n,
            },
          },
        ],
        rejectedOnceHandProposal: null,
        lastHandProposal: {
          gameType: 'spacepoker',
          playerAContribution: 10n,
          playerBContribution: 10n,
          senderIsPlayerA: false,
          gameTimeout: 23n,
          parameters: 1n,
        },
        compose: {
          selectedGame: 'spacepoker',
          gameTimeout: 23n,
          proposalSent: false,
        },
        newHandRequested: false,
        pendingRetryHandProposal: null,
      },
    });

    expect(selectGameSessionView(restored).betweenHands).toBe(true);
    expect(selectGameSessionView(restored).currentHandAmount).toBe(10n);
    expect(restored.betweenHand.proposalGroups).toEqual(live.betweenHand.proposalGroups);
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
      sessionAmountsFromSave(
        liveEnvelope({
          myContribution: '100',
          theirContribution: '50',
          perGameAmount: '45',
        } as any),
      ),
    ).toEqual({ myContribution: 100n, theirContribution: 50n, perGameAmount: 45n });

    expect(
      sessionAmountsFromSave(
        liveEnvelope({
          myContribution: '100',
          theirContribution: '100',
          perGameAmount: '10',
        } as any),
      ),
    ).toEqual({ myContribution: 100n, theirContribution: 100n, perGameAmount: 10n });

    expect(() =>
      sessionAmountsFromSave(
        liveEnvelope({
          myContribution: '100',
          theirContribution: '50',
          perGameAmount: undefined,
        } as any),
      ),
    ).toThrow('Garbled save');

    expect(() =>
      sessionAmountsFromSave(
        liveEnvelope({
          myContribution: 'bad',
          theirContribution: '50',
          perGameAmount: '10',
        } as any),
      ),
    ).toThrow('Garbled save');

    expect(() =>
      sessionAmountsFromSave(
        liveEnvelope({
          myContribution: '50',
          theirContribution: undefined,
          perGameAmount: '10',
        } as any),
      ),
    ).toThrow('Garbled save');
  });

  it('keeps histories out of the presentation snapshot', () => {
    const model = createSessionModel({
      history: {
        humanHistory: ['human line'],
        wasmNotificationHistory: ['{"ChannelStatus":{}}'],
        diagnosticLog: ['diag line'],
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot).not.toHaveProperty('humanHistory');
    expect(snapshot).not.toHaveProperty('wasmNotificationHistory');
    expect(snapshot).not.toHaveProperty('diagnosticLog');
    expect(model.history).toEqual({
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

  it('maps WASM finishing-timeout statuses to wait versus spend', () => {
    const previous = {
      id: '7',
      amount: '100',
      coin: { coinHex: 'coin', turnState: 'my-turn' as const, onChain: true },
      handStatus: 'our-turn' as const,
      terminal: INITIAL_GAME_TERMINAL_MODEL,
    };
    expect(
      projectGameStatus({
        previous,
        payload: {
          id: '7',
          status: 'finishing-waiting-timeout',
          coin_id: 'coin',
          other_params: { game_finished: true },
        },
        channelState: 'ResolvedUnrolled',
      }),
    ).toMatchObject({
      coin: { turnState: 'finishing-waiting-timeout', onChain: true },
      handStatus: 'finishing-waiting-timeout',
    });
    expect(
      projectGameStatus({
        previous,
        payload: {
          id: '7',
          status: 'finishing-spending',
          coin_id: 'coin',
          other_params: { game_finished: true, submitting_timeout_claim: true },
        },
        channelState: 'ResolvedUnrolled',
      }),
    ).toMatchObject({
      coin: { turnState: 'finishing-spending', onChain: true },
      handStatus: 'finishing-spending',
    });
  });
});
