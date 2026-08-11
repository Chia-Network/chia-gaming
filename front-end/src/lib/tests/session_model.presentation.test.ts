import {
  createSessionModel,
  channelStatusModelFromPayload,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  isChannelAbandonable,
  selectGameDashboardView,
  selectStatusBarBalances,
  selectGameSessionView,
  selectGameSpecificView,
  selectSessionPhase,
  sessionModelFromSave,
  nextGameInstanceAfterLocalTurn,
} from '../session/model';
import type { SessionSave } from '../../hooks/save';
import { baseSave, liveSave } from './session_save_envelope.fixtures';

function liveEnvelope(fields: Partial<SessionSave>): SessionSave {
  return liveSave({
    myContribution: '100',
    theirContribution: '100',
    perGameAmount: '10',
    ...(fields as unknown as Record<string, unknown>),
  });
}

describe('session model dashboard and on-chain presentation contracts', () => {
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

  it('uses the existing dashboard action across the setup commitment boundary', () => {
    expect(selectGameDashboardView(null, { setupPending: true })).toMatchObject({
      channelStatusLabel: 'Setting Up',
      actionLabel: 'Cancel',
      actionEnabled: true,
      actionKind: 'cancel',
    });

    // Accepting after a finished freeze keeps the terminal model until
    // retireTerminalDisplay; setupPending must still expose Cancel.
    const finishedFreeze = createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedClean' } },
    });
    expect(selectGameDashboardView(finishedFreeze)).toMatchObject({
      actionLabel: 'Done',
      actionEnabled: false,
      actionKind: 'none',
    });
    expect(selectGameDashboardView(finishedFreeze, { setupPending: true })).toMatchObject({
      channelStatusLabel: 'Setting Up',
      actionLabel: 'Cancel',
      actionEnabled: true,
      actionKind: 'cancel',
    });

    for (const state of [
      'Handshaking',
      'WaitingForHeightToOffer',
      'WaitingForHeightToAccept',
      'OurWalletMakingOffer',
      'OurWalletMakingOfferAcceptance',
    ] as const) {
      expect(
        selectGameDashboardView(
          createSessionModel({
            channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state } },
          }),
        ).actionKind,
      ).toBe('cancel');
    }

    for (const state of ['OfferSent', 'TransactionPending'] as const) {
      expect(
        selectGameDashboardView(
          createSessionModel({
            channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state } },
          }),
        ),
      ).toMatchObject({
        actionLabel: 'Waiting',
        actionEnabled: false,
        actionKind: 'none',
      });
    }
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
    const restored = sessionModelFromSave(
      baseSave({
        version: 11n,
        playerId: 'p1',
        activeGameIds: [],
        channelStatus,
        coinsOfInterest: [],
      }),
    );

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
});
