import { expectConsoleError } from '../../../scripts/testSetup';
import { SessionController } from '../../hooks/SessionController';
import type { NeedCoinSpendRequest, WasmResult } from '../../types/ChiaGaming';
import { requireWasmResult } from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { peekSession } from '../../hooks/save';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { createSessionModel } from '../session/model';
import { DIAGNOSTIC_LOG_LIMIT, WASM_NOTIFICATION_HISTORY_LIMIT } from '../session/historyLimits';
import {
  channelStatus,
  createReadyBlob,
  createUnreadyBlob,
  enc,
  mockRpc,
  setActiveBlob,
  testSpendBundle,
  wasmResult,
} from './message_protocol.harness';
import {
  protocolIdentitiesReady,
  setProtocolIds,
  _resetGameIdentityWarmupForTests,
} from '../gameIdentities';
import { TEST_PROTOCOL_IDS, testProtocolId } from './protocolIdentities';

describe('WASM result boundary', () => {
  it.each(['events', 'watchCoins', 'unwatchCoins', 'actionSucceeded', 'disposition'] as const)(
    'rejects a drain missing required %s',
    (field) => {
      const result = wasmResult();
      delete (result as unknown as Record<string, unknown>)[field];
      expect(() => requireWasmResult(result)).toThrow();
    },
  );

  it('rejects notification tags outside the closed contract', () => {
    const result = wasmResult({
      events: [
        { Notification: { FutureNotification: {} } } as unknown as WasmResult['events'][number],
      ],
    });
    expect(() => requireWasmResult(result)).toThrow('unknown notification');
  });

  it('accepts the host-only local action notification', () => {
    const result = wasmResult({
      events: [
        {
          Notification: {
            LocalActionApplied: { id: 1n, action: 'make_move' },
          },
        },
      ],
    });
    expect(requireWasmResult(result)).toBe(result);
  });

  it('requires outbound protocol messages to remain bytes', () => {
    const result = wasmResult({
      events: [{ OutboundMessage: 'not bytes' } as unknown as WasmResult['events'][number]],
    });
    expect(() => requireWasmResult(result)).toThrow('non-byte OutboundMessage');
  });
});

describe('in-order delivery', () => {
  it('drains an active result to quiescence in one macrotask', async () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const reasons: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'notification' && event.data.ActionFailed) {
        reasons.push(String(event.data.ActionFailed.reason));
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [
        { Notification: { ActionFailed: { reason: 'first' } } },
        { Notification: { ActionFailed: { reason: 'second' } } },
      ],
    });

    expect(reasons).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reasons).toEqual(['first', 'second']);
  });

  it('includes re-entrant active results in that drain', async () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const reasons: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type !== 'notification' || !event.data.ActionFailed) return;
      const reason = String(event.data.ActionFailed.reason);
      reasons.push(reason);
      if (reason === 'first') {
        blob.processResult({
          ...wasmResult(),
          disposition: { kind: 'active' },
          events: [{ Notification: { ActionFailed: { reason: 'second' } } }],
        });
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [{ Notification: { ActionFailed: { reason: 'first' } } }],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reasons).toEqual(['first', 'second']);
  });

  it('yields a self-replenishing active FIFO after the event budget', async () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    let delivered = 0;
    blob.getObservable().subscribe((event) => {
      if (event.type !== 'notification' || !event.data.ActionFailed) return;
      delivered += 1;
      if (delivered < 101) {
        blob.processResult({
          ...wasmResult(),
          disposition: { kind: 'active' },
          events: [{ Notification: { ActionFailed: { reason: String(delivered) } } }],
        });
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [{ Notification: { ActionFailed: { reason: 'first' } } }],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(delivered).toBe(100);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(delivered).toBe(101);
  });

  it('stops active delivery when an observer retires the controller', async () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);
    const reasons: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type !== 'notification' || !event.data.ActionFailed) return;
      reasons.push(String(event.data.ActionFailed.reason));
      blob.cleanup();
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [
        { Notification: { ActionFailed: { reason: 'first' } } },
        { OutboundMessage: enc('must not send') },
        { Notification: { ActionFailed: { reason: 'second' } } },
      ],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reasons).toEqual(['first']);
    expect(sentMessages).toEqual([]);
    expect((blob as any).eventQueue).toEqual([]);
    expect((blob as any).protocolStopped).toBe(true);
  });

  it('delivers messages 1, 2, 3 and ACKs each after durability flush', async () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));
    blob.deliverMessage(3n, enc('c'));

    expect(blob.remoteNumber).toBe(3n);
    expect(sentAcks).toEqual([]);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2, 3]);
    const saved = await peekSession();
    expect(saved?.phase === 'live' && saved.live.remoteNumber).toBe(3n);
    expect(cradle.deliver_message).toHaveBeenCalledTimes(3);
    expect((cradle.deliver_message as jest.Mock).mock.calls.map((c: any[]) => c[0])).toEqual([
      enc('a'),
      enc('b'),
      enc('c'),
    ]);
  });
});

describe('protocol identity loading', () => {
  it('delivers a hash ProposalMade in arrival order once protocol ids are known', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    setProtocolIds(TEST_PROTOCOL_IDS);
    const tags: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'notification') {
        tags.push(Object.keys(event.data)[0] ?? '');
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [
        {
          Notification: {
            ProposalMade: {
              id: '7',
              group_ids: ['7'],
              my_contribution: '100',
              their_contribution: '100',
              timeout: '15',
              game_type: testProtocolId('calpoker'),
              parameters: null,
            },
          },
        },
        { Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } },
      ],
    });
    blob.flushDeferredWork();
    expect(protocolIdentitiesReady()).toBe(true);
    expect(tags).toEqual(['ProposalMade', 'ChannelStatus']);
  });

  it('holds a puzzle-hash ProposalMade until protocol identities are ready', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    _resetGameIdentityWarmupForTests();
    const tags: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'notification') {
        tags.push(Object.keys(event.data)[0] ?? '');
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [
        {
          Notification: {
            ProposalMade: {
              id: '7',
              group_ids: ['7'],
              my_contribution: '100',
              their_contribution: '100',
              timeout: '15',
              game_type: testProtocolId('calpoker'),
              parameters: null,
            },
          },
        },
      ],
    });
    blob.flushDeferredWork();
    expect(tags).toEqual([]);
    expect(protocolIdentitiesReady()).toBe(false);

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } }],
    });
    blob.flushDeferredWork();
    expect(protocolIdentitiesReady()).toBe(true);
    expect(tags).toEqual(['ChannelStatus', 'ProposalMade']);
  });

  it('reports a bind failure on Active and still delivers ChannelStatus', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    _resetGameIdentityWarmupForTests();
    blob.wc = {
      registered_game_packages: () => [],
    } as (typeof blob)['wc'];
    expectConsoleError('completeRegisteredGames failed');
    const tags: string[] = [];
    const errors: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'notification') {
        tags.push(Object.keys(event.data)[0] ?? '');
      }
      if (event.type === 'error') {
        errors.push(event.error);
      }
    });

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [
        {
          Notification: {
            ProposalMade: {
              id: '7',
              group_ids: ['7'],
              my_contribution: '100',
              their_contribution: '100',
              timeout: '15',
              game_type: testProtocolId('calpoker'),
              parameters: null,
            },
          },
        },
        { Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } },
      ],
    });
    blob.flushDeferredWork();
    expect(protocolIdentitiesReady()).toBe(false);
    expect(tags).toEqual(['ChannelStatus']);
    expect(errors.some((error) => error.includes('Missing warmed identity'))).toBe(true);
  });
});

describe('SessionController WASM action results', () => {
  function failedResult(reason: string): WasmResult {
    return wasmResult({
      actionSucceeded: false,
      events: [
        {
          Notification: {
            ActionFailed: { reason },
          },
        },
      ],
    });
  }

  it.each([
    [
      'proposeGame',
      (blob: SessionController) =>
        blob.proposeGame({ game_type: testProtocolId('calpoker'), timeout: 5n, parameters: null }),
    ],
    ['acceptProposal', (blob: SessionController) => blob.acceptProposal('7')],
    ['cancelProposal', (blob: SessionController) => blob.cancel_proposal('7')],
    ['cleanShutdown', (blob: SessionController) => blob.cleanShutdown()],
    ['makeMove', (blob: SessionController) => blob.makeMove('7', null)],
    ['acceptSettlement', (blob: SessionController) => blob.acceptSettlement('7')],
    ['cheat', (blob: SessionController) => blob.cheat('7', 0n)],
  ])('rejects actionSucceeded=false from %s', (name, invoke) => {
    if (name !== 'proposeGame') {
      expectConsoleError(`${name} domain error`);
    }
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    Object.assign(cradle, {
      propose_games: jest.fn(() => ({ ...failedResult(`${name} domain error`), ids: ['7'] })),
      accept_proposal: jest.fn(() => failedResult(`${name} domain error`)),
      cancel_proposal: jest.fn(() => failedResult(`${name} domain error`)),
      shut_down: jest.fn(() => failedResult(`${name} domain error`)),
      make_move: jest.fn(() => failedResult(`${name} domain error`)),
      acceptSettlement: jest.fn(() => failedResult(`${name} domain error`)),
      cheat: jest.fn(() => failedResult(`${name} domain error`)),
    });

    expect(() => invoke(blob)).toThrow(`${name} domain error`);
    expect(blob.cleanShutdownCalled).toBe(false);
  });

  it('returns failure and does not enter host on-chain mode when WASM rejects', () => {
    expectConsoleError('go on chain domain error');
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    (cradle.go_on_chain as jest.Mock).mockReturnValue(failedResult('go on chain domain error'));

    expect(blob.goOnChain()).toBe(false);
    expect(blob.onChain).toBe(false);
  });
});

describe('active game tracking', () => {
  it('retires only the settled member of an atomic hand', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.activeGameIds = ['1', '3'];

    blob.processResult({
      ...wasmResult(),
      events: [
        {
          Notification: {
            GameSettled: {
              id: '1',
              outcome: 'accept_settlement',
              on_chain: false,
              our_share: '100',
              coin_id: null,
            },
          },
        },
      ],
    });
    blob.flushDeferredWork();
    expect(blob.activeGameIds).toEqual(['3']);

    blob.processResult({
      ...wasmResult(),
      events: [
        {
          Notification: {
            GameSettled: {
              id: '3',
              outcome: 'accept_settlement',
              on_chain: false,
              our_share: '100',
              coin_id: null,
            },
          },
        },
      ],
    });
    blob.flushDeferredWork();
    expect(blob.activeGameIds).toEqual([]);
  });

  it.each([
    ['1', '3'],
    ['3', '1'],
  ])(
    'preserves split Krunk terminal drains through session terminalization (%s then %s)',
    (firstId, lastId) => {
      const { blob } = createReadyBlob();
      setActiveBlob(blob);
      const terms = {
        gameType: 'krunk' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      };
      let machine = createSessionMachineState(createSessionModel());
      machine = reduceSessionMachine(machine, {
        type: 'upsert-proposal-group',
        group: {
          primaryId: '1',
          memberIds: ['1', '3'],
          handProposal: terms,
          origin: 'local',
          disposition: 'outgoing',
        },
      }).state;
      const settledIds: string[] = [];
      blob.getObservable().subscribe((event) => {
        if (event.type !== 'notification') return;
        if (event.data.GameSettled) settledIds.push(String(event.data.GameSettled.id));
        machine = reduceSessionNotification(machine, event.data, true, reduceSessionMachine).state;
      });

      blob.processResult({
        ...wasmResult(),
        disposition: { kind: 'active' },
        events: [
          { Notification: { ProposalAccepted: { id: '1', amount: '100', our_turn: true } } },
          { Notification: { ProposalAccepted: { id: '3', amount: '100', our_turn: false } } },
        ],
      });
      blob.flushDeferredWork();
      expect(machine.model.game.activeIds).toEqual(['1', '3']);

      const firstSettlement = {
        Notification: {
          GameSettled: {
            id: firstId,
            outcome: 'timed_out_waiting_for_our_move' as const,
            our_share: '0',
            coin_id: null,
          },
        },
      };
      blob.processResult({
        ...wasmResult(),
        disposition: { kind: 'active' },
        events: [firstSettlement, firstSettlement],
      });
      blob.processResult({
        ...wasmResult(),
        disposition: { kind: 'terminal' },
        events: [
          {
            Notification: {
              GameSettled: {
                id: lastId,
                outcome: 'opponent_timed_out',
                our_share: '100',
                coin_id: null,
              },
            },
          },
        ],
      });

      expect(settledIds).toEqual([firstId, firstId, lastId]);
      expect(blob.activeGameIds).toEqual([]);
      expect(machine.model.game.activeIds).toEqual([]);
      expect(machine.model.game.instances['1'].presentation).toBe('ended');
      expect(machine.model.game.instances['3'].presentation).toBe('ended');
      expect(machine.model.betweenHand.mode).toBe('decision');
    },
  );
});

describe('lifecycle flush', () => {
  it('drains transient handshake events before resolving the save flush', async () => {
    const outbound = enc('next-handshake-message');
    const { blob, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('incoming-handshake-message'));
    await blob.flushPendingSave();

    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
    const saved = await peekSession();
    expect(saved?.phase === 'live' && saved.live.remoteNumber).toBe(1n);
    expect(saved?.phase === 'live' && saved.live.messageNumber).toBe(2n);
    expect(saved?.phase === 'live' && saved.live.unackedMessages).toEqual([
      { msgno: 1n, msg: outbound },
    ]);
  });
});

describe('game action failure events', () => {
  it('scopes failed terminal submissions to their game and action', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { blob, cradle } = createReadyBlob();
    (
      cradle as unknown as {
        make_move: (gameId: string, readable: Uint8Array) => WasmResult;
      }
    ).make_move = () => {
      throw new Error('cannot reveal');
    };
    (
      cradle as unknown as {
        acceptSettlement: (gameId: string) => WasmResult;
      }
    ).acceptSettlement = () => {
      throw new Error('cannot accept settlement');
    };
    const events: import('../../types/ChiaGaming').WasmEvent[] = [];
    const subscription = blob.getObservable().subscribe((event) => events.push(event));

    expect(() => blob.makeMove('41', null)).toThrow('cannot reveal');
    expect(() => blob.acceptSettlement('42')).toThrow('cannot accept settlement');
    subscription.unsubscribe();

    expect(events).toContainEqual({
      type: 'game-action-error',
      gameId: '41',
      action: 'make-move',
      error: 'cannot reveal',
    });
    expect(events).toContainEqual({
      type: 'game-action-error',
      gameId: '42',
      action: 'accept-settlement',
      error: 'cannot accept settlement',
    });
    errorSpy.mockRestore();
  });

  it('does not drain or save a synchronous actionSucceeded=false result', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { blob, cradle } = createReadyBlob();
    const save = jest.fn();
    blob.onSaveNeeded = save;
    (
      cradle as unknown as {
        make_move: (gameId: string, readable: Uint8Array) => WasmResult;
      }
    ).make_move = () =>
      wasmResult({
        actionSucceeded: false,
        events: [
          {
            Notification: {
              ActionFailed: { id: 41n, reason: 'not our turn' },
            },
          },
        ],
      });
    const notifications: unknown[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'notification') notifications.push(event.data);
    });

    expect(() => blob.makeMove('41', null)).toThrow('not our turn');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(notifications).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    subscription.unsubscribe();
    errorSpy.mockRestore();
  });

  it('returns rejection before a local candidate can be committed', () => {
    const { blob, cradle } = createReadyBlob();
    const makeMove = jest.fn(() =>
      wasmResult({
        events: [
          {
            Notification: {
              MoveRejected: { id: 41n, tag: 'illegal_move', message: 'not allowed' },
            },
          },
        ],
      }),
    );
    (
      cradle as unknown as {
        make_move: (gameId: string, readable: Uint8Array) => WasmResult;
      }
    ).make_move = makeMove;

    expect(blob.makeMove('41', null)).toBe('rejected');
    makeMove.mockReturnValue(wasmResult());
    expect(blob.makeMove('41', null)).toBe('queued');
    makeMove.mockReturnValue(
      wasmResult({
        events: [
          {
            Notification: {
              LocalActionApplied: { id: 41n, action: 'make_move' },
            },
          },
        ],
      }),
    );
    expect(blob.makeMove('41', null)).toBe('applied');
  });
});

describe('duplicate detection', () => {
  it('delivers once but ACKs twice after pending durability flush', async () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(1n, enc('a'));

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 1]);
  });

  it('retransmits unacked outbound when a duplicate inbound arrives (post-reload peer)', async () => {
    const { blob, sentMessages, sentAcks } = createReadyBlob();
    setActiveBlob(blob);
    const offer = enc('offer-sent-payload');
    blob.unackedMessages = [{ msgno: 2n, msg: offer }];

    blob.deliverMessage(1n, enc('first'));
    await blob.flushPendingWork();
    sentMessages.length = 0;
    sentAcks.length = 0;

    // Peer reloaded and resent msgno 1; we must replay our still-unacked offer.
    blob.deliverMessage(1n, enc('first-again'));
    await blob.flushPendingWork();

    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([{ msgno: 2, msg: offer }]);
  });
});

describe('keepalive retransmission', () => {
  it('retransmits unacked outbound when a peer keepalive arrives', () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);
    const pending = enc('pending-offer');
    blob.unackedMessages = [{ msgno: 3n, msg: pending }];

    blob.receiveKeepalive();

    expect(sentMessages).toEqual([{ msgno: 3, msg: pending }]);
  });

  it('does not send when there is nothing unacked', () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);

    blob.receiveKeepalive();

    expect(sentMessages).toEqual([]);
  });
});

describe('out-of-order delivery with reorder queue', () => {
  it('delivers 3, 1, 2 → cradle sees a, b, c in order', async () => {
    const delivered: Uint8Array[] = [];
    const { blob, sentAcks } = createReadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    setActiveBlob(blob);

    blob.deliverMessage(3n, enc('c'));
    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));

    expect(delivered).toEqual([enc('a'), enc('b'), enc('c')]);
    expect(blob.remoteNumber).toBe(3n);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2, 3]);
  });
});

describe('buffering before system ready, then spill', () => {
  it('buffers messages and delivers when system reaches qe=7', async () => {
    const { blob, cradle, sentAcks } = createUnreadyBlob();
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(2n, enc('b'));
    expect(cradle.deliver_message).not.toHaveBeenCalled();

    blob.kickSystem(2);

    expect(cradle.deliver_message).toHaveBeenCalledTimes(2);
    expect(blob.remoteNumber).toBe(2n);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1, 2]);
  });

  it('delivers out-of-order buffered messages in correct order', () => {
    const delivered: Uint8Array[] = [];
    const { blob } = createUnreadyBlob((msg) => {
      delivered.push(msg);
      return { events: [] };
    });
    setActiveBlob(blob);

    blob.deliverMessage(2n, enc('b'));
    blob.deliverMessage(1n, enc('a'));
    expect(delivered).toEqual([]);

    blob.kickSystem(2);

    expect(delivered).toEqual([enc('a'), enc('b')]);
    expect(blob.remoteNumber).toBe(2n);
  });
});

describe('ACK pruning', () => {
  it('removes messages ≤ ackMsgno from unackedMessages', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);

    blob.unackedMessages = [
      { msgno: 1n, msg: enc('a') },
      { msgno: 2n, msg: enc('b') },
      { msgno: 3n, msg: enc('c') },
    ];
    blob.receiveAck(2n);

    expect(blob.unackedMessages).toEqual([{ msgno: 3n, msg: enc('c') }]);
  });
});

describe('outbound message numbering', () => {
  it('assigns sequential numbers and tracks in unackedMessages', async () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('trigger'));
    blob.flushDeferredWork();
    await blob.flushPendingWork();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });

    blob.deliverMessage(2n, enc('trigger2'));
    blob.flushDeferredWork();
    await blob.flushPendingWork();

    expect(sentMessages[1]).toEqual({ msgno: 2, msg: helloBytes });
    expect(blob.messageNumber).toBe(3n);
  });
});

describe('bounded controller histories', () => {
  it('keeps only recent WASM notifications and diagnostic lines', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.processResult({
      ...wasmResult(),
      events: [
        ...Array.from({ length: WASM_NOTIFICATION_HISTORY_LIMIT + 2 }, (_, i) => ({
          Notification: { ActionFailed: { reason: `notification-${i}` } },
        })),
        ...Array.from({ length: DIAGNOSTIC_LOG_LIMIT + 2 }, (_, i) => ({ Log: `diagnostic-${i}` })),
      ],
    });
    blob.flushDeferredWork();

    expect(blob.wasmNotificationHistory).toHaveLength(WASM_NOTIFICATION_HISTORY_LIMIT);
    expect(blob.wasmNotificationHistory[0]).toContain('notification-2');
    expect(blob.diagnosticLog).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(blob.diagnosticLog[0]).toBe('diagnostic-2');
  });
});

describe('WASM wallet funding requests', () => {
  it('forwards a typed NeedCoinSpend payload to createOfferForIds', async () => {
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('coin-spend'));
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    const request: NeedCoinSpendRequest = {
      amount: 100,
      conditions: [{ opcode: 60, args: ['launcher'] }],
      coin_id: 'funding-coin',
      max_height: 123,
    };

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledWith(
      'test',
      { '1': -100n },
      [{ opcode: 60n, args: ['launcher'] }],
      ['funding-coin'],
      123n,
    );
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledWith(
      JSON.stringify(testSpendBundle('coin-spend')),
    );
  });
});
