import { expectConsoleError } from '../../../scripts/testSetup';
import { Program } from 'clvm-lib';
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
  attachTestCommitCoordinator,
  channelStatus,
  createReadyBlob,
  createUnreadyBlob,
  enc,
  makeMockCradle,
  makePeerConn,
  mockBlockchain,
  mockRpc,
  mockWasmConnection,
  setActiveBlob,
  setTestPersistence,
  submitTransaction,
  testSpendBundle,
  transactionSubmitQueue,
  wasmResult,
} from './message_protocol.harness';
import { createCoordinatorOnlySessionMachineRuntime } from './session_machine.harness';
import { jsonStringify } from '../../util/jsonSafe';
import {
  protocolIdentitiesReady,
  setProtocolIds,
  _resetGameIdentityWarmupForTests,
} from '../gameIdentities';
import { TEST_PROTOCOL_IDS, testProtocolId } from './protocolIdentities';
import { sessionReceivePolicy } from '../session/receivePolicy';
import { readSessionRecord, writeSessionRecord } from '../session/indexedDb';
import { decodeSessionSaveEnvelope } from '../session/persistence';
import { liveSave } from './session_save_envelope.fixtures';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';

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
  it('drains an active result to the runtime fixed point', () => {
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

  it('drains a self-replenishing active FIFO to the commit fixed point', async () => {
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

    await blob.flushPendingWork();
    expect(delivered).toBe(101);
  });

  it('reaches the runtime fixed point when work is flushed explicitly', () => {
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
    blob.flushDeferredWork();
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
    expect(errors.some((error) => error.includes('Missing built identity'))).toBe(true);
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
        blob.proposeGame({
          game_type: testProtocolId('calpoker'),
          timeout: 5n,
          player_a_contribution: 1n,
          player_b_contribution: 1n,
          sender_is_player_a: true,
          parameters: null,
        }),
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
      propose: jest.fn(() => ({ ...failedResult(`${name} domain error`), id: '7' })),
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
        type: 'upsert-pending-proposal',
        proposal: {
          id: '1',
          handProposal: terms,
          lifecycle: 'local-outgoing',
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
          {
            Notification: {
              ProposalAcceptedGroup: {
                id: 1n,
                members: [
                  {
                    id: '1',
                    player_a_contribution: '100',
                    player_b_contribution: '0',
                    our_turn: true,
                    readable_parameters: Program.fromBigInt(100n).serialize(),
                  },
                  {
                    id: '3',
                    player_a_contribution: '0',
                    player_b_contribution: '100',
                    our_turn: false,
                    readable_parameters: Program.fromBigInt(100n).serialize(),
                  },
                ],
              },
            },
          },
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
    setTestPersistence(blob, save);
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
  it('delivers once and coalesces duplicate ACKs behind durability', async () => {
    const { blob, cradle, sentAcks } = createReadyBlob();
    setActiveBlob(blob);

    blob.deliverMessage(1n, enc('a'));
    blob.deliverMessage(1n, enc('a'));

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    await blob.flushPendingWork();
    expect(sentAcks).toEqual([1]);
  });

  it('acknowledges a duplicate inbound without retransmitting unacked outbound', async () => {
    const { blob, sentMessages, sentAcks } = createReadyBlob();
    setActiveBlob(blob);
    const offer = enc('offer-sent-payload');
    blob.messageNumber = 3n;
    blob.unackedMessages = [{ msgno: 2n, msg: offer }];

    blob.deliverMessage(1n, enc('first'));
    await blob.flushPendingWork();
    sentMessages.length = 0;
    sentAcks.length = 0;

    blob.deliverMessage(1n, enc('first-again'));
    await blob.flushPendingWork();

    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([]);
  });
});

describe('keepalive activity', () => {
  it('does not retransmit unacked outbound when a peer keepalive arrives', () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);
    const pending = enc('pending-offer');
    blob.unackedMessages = [{ msgno: 3n, msg: pending }];

    blob.receiveKeepalive();

    expect(sentMessages).toEqual([]);
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

  it('fails and clears queued frames when the future gap is exceeded', () => {
    const policy = sessionReceivePolicy({ maxFutureReliableMsgnoGap: 1n });
    const { blob, cradle } = createReadyBlob(undefined, policy);

    blob.deliverMessage(3n, enc('too-far'));

    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(cradle.go_on_chain).toHaveBeenCalledTimes(1);
    expect((blob as any).reorderQueue.size).toBe(0);
    expect(blob.storedMessages).toEqual([]);
  });

  it('fails on queued message count and aggregate bytes', () => {
    const countLimited = createReadyBlob(undefined, sessionReceivePolicy({ maxQueuedMessages: 1 }));
    countLimited.blob.deliverMessage(2n, enc('a'));
    countLimited.blob.deliverMessage(3n, enc('b'));
    expect(countLimited.cradle.go_on_chain).toHaveBeenCalledTimes(1);
    expect((countLimited.blob as any).reorderQueue.size).toBe(0);

    const byteLimited = createUnreadyBlob(undefined, sessionReceivePolicy({ maxQueuedBytes: 3 }));
    byteLimited.blob.deliverMessage(1n, enc('ab'));
    byteLimited.blob.deliverMessage(2n, enc('cd'));
    expect(byteLimited.cradle.go_on_chain).toHaveBeenCalledTimes(1);
    expect(byteLimited.blob.storedMessages).toEqual([]);
  });

  it('does not double-account duplicate queued msgnos', () => {
    const { blob, cradle } = createReadyBlob(
      undefined,
      sessionReceivePolicy({ maxQueuedMessages: 1, maxQueuedBytes: 1 }),
    );

    blob.deliverMessage(2n, enc('x'));
    blob.deliverMessage(2n, enc('x'));
    blob.deliverMessage(1n, enc('a'));

    expect(cradle.go_on_chain).not.toHaveBeenCalled();
    expect((cradle.deliver_message as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      enc('a'),
      enc('x'),
    ]);
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
    blob.messageNumber = 4n;
    blob.receiveAck(2n);

    expect(blob.unackedMessages).toEqual([{ msgno: 3n, msg: enc('c') }]);
  });
});

describe('outbound message numbering', () => {
  it('continues numbering from the proposal transport state without reset', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const peer = makePeerConn(sentMessages, []);
    const proposal = enc('session proposal');
    peer.reliableState!.messageNumber = 2n;
    peer.reliableState!.unackedMessages = [{ msgno: 1n, msg: proposal }];
    const blob = new SessionController(null, 'test', 100n, 100n, peer);
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(makeMockCradle());
    attachTestCommitCoordinator(blob);
    setTestPersistence(blob, jest.fn());

    expect(blob.queueHostMessage(enc('handshake A'))).toBe(2n);
    await blob.flushPendingWork();

    expect(blob.messageNumber).toBe(3n);
    expect(blob.unackedMessages.map(({ msgno }) => msgno)).toEqual([1n, 2n]);
    expect(sentMessages.map(({ msgno }) => msgno)).toEqual([2]);
  });

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
  it('starts the handshake with the configured opening fee without selecting a coin', () => {
    const selectCoins = jest.fn();
    const { blob, cradle } = createReadyBlob();
    const startHandshake = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { start_handshake: jest.Mock }).start_handshake = startHandshake;
    setActiveBlob(blob);
    blob.getFee = () => 10n;
    blob.blockchain = new BlockchainPoller({ ...mockRpc, selectCoins }, 60000);

    blob.activateSpend();

    expect(startHandshake).toHaveBeenCalledWith('10');
    expect(selectCoins).not.toHaveBeenCalled();
  });

  it('forwards a typed NeedCoinSpend payload to createOfferForIds', async () => {
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('coin-spend'));
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60, args: ['launcher'] }],
      coin_id: 'ab'.repeat(32),
      max_height: 123,
    };

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledWith(
      'test',
      { '1': -100n },
      [{ opcode: 60n, args: ['launcher'] }],
      ['ab'.repeat(32)],
      123n,
      10n,
    );
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledWith(
      JSON.stringify(testSpendBundle('coin-spend')),
    );
  });

  it('round-trips null-valued WASM funding output through persistence and restore', async () => {
    const blob = new SessionController(mockBlockchain, 'source', 100n, 100n, makePeerConn([], []));
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(makeMockCradle());
    const wasmRequest = {
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60, args: ['launcher'] }],
      coin_id: null,
      max_height: null,
    } as unknown as NeedCoinSpendRequest;

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: wasmRequest }] }));
    blob.flushDeferredWork();
    const fundingOutbox = blob.getWasmFields()?.fundingOutbox;
    expect(fundingOutbox).toEqual([
      {
        key: expect.stringMatching(/^funding:/),
        request: {
          amount: '100',
          fee: '10',
          conditions: [{ opcode: 60n, args: ['launcher'] }],
        },
      },
    ]);
    blob.cleanup();

    const save = liveSave();
    if (save.phase !== 'live') throw new Error('expected live funding save');
    save.live.fundingOutbox = fundingOutbox;
    await writeSessionRecord(save);
    const encodedThenDecoded = await readSessionRecord();
    const decoded = decodeSessionSaveEnvelope(encodedThenDecoded).save;
    if (decoded.phase !== 'live') throw new Error('expected live funding round-trip');

    const restored = new SessionController(
      mockBlockchain,
      'restored',
      100n,
      100n,
      makePeerConn([], []),
    );
    restored.loadWasm(mockWasmConnection);
    restored.setGameSession(makeMockCradle());
    try {
      restored.restoreFundingOutbox(decoded.live.fundingOutbox ?? []);
      expect(restored.getWasmFields()?.fundingOutbox).toEqual(fundingOutbox);
    } finally {
      restored.cleanup();
    }
  });

  it('rejects restoring more than one distinct canonical funding request', () => {
    const { blob } = createReadyBlob();
    const first = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['first'] }],
    });
    const second = canonicalizeFundingRequest({
      amount: '101',
      fee: '0',
      conditions: [{ opcode: 60, args: ['second'] }],
    });

    expect(() =>
      blob.restoreFundingOutbox([
        { key: fundingRequestKey(first), request: first },
        { key: fundingRequestKey(second), request: second },
      ]),
    ).toThrow('more than one distinct request');
  });

  it('attempts persistence before funding and continues after storage failure', async () => {
    const order: string[] = [];
    const createOfferForIds = jest.fn().mockImplementation(async () => {
      order.push('funding');
      return testSpendBundle('coin-spend');
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);
    let persistenceAttempts = 0;
    setTestPersistence(blob, async () => {
      persistenceAttempts += 1;
      order.push('persist');
      if (persistenceAttempts === 1) throw new Error('disk full');
    });
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    blob.flushDeferredWork();
    expect(createOfferForIds).not.toHaveBeenCalled();
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ amount: '100', fee: '10' }),
      }),
    ]);
    await expect(blob.flushPendingSave()).rejects.toThrow('disk full');
    await Promise.resolve();

    expect(order.slice(0, 2)).toEqual(['persist', 'funding']);
    expect(createOfferForIds).toHaveBeenCalledTimes(1);
    await blob.flushPendingSave();
    expect(createOfferForIds).toHaveBeenCalledTimes(1);
  });

  it('cancels a rejected persisted offer before creating its retry', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
      coin_id: 'ab'.repeat(32),
      max_height: 123,
    };
    const createOfferForIds = jest
      .fn()
      .mockResolvedValueOnce({ offer: 'offer1first', tradeId: 'trade-1' })
      .mockResolvedValueOnce({ offer: 'offer1second', tradeId: 'trade-2' });
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds, cancelOffer }, 60000);
    const { blob, cradle } = createReadyBlob();
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValueOnce(wasmResult({ events: [{ NeedCoinSpend: request }] }))
      .mockReturnValueOnce(wasmResult());
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledTimes(2);
    expect(cancelOffer).toHaveBeenCalledTimes(1);
    expect(cancelOffer).toHaveBeenCalledWith('trade-1');
    expect(cancelOffer.mock.invocationCallOrder[0]).toBeLessThan(
      createOfferForIds.mock.invocationCallOrder[1],
    );
  });

  it('reports one failed cancellation through its successor and permits later funding', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const laterRequest: NeedCoinSpendRequest = {
      amount: '101',
      fee: '0',
      conditions: [{ opcode: 60, args: ['later'] }],
    };
    const createOfferForIds = jest
      .fn()
      .mockResolvedValueOnce({ offer: 'offer1first', tradeId: 'trade-1' })
      .mockResolvedValueOnce(testSpendBundle('later'));
    const cancelOffer = jest.fn().mockRejectedValue(new Error('cancellation failed'));
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds, cancelOffer }, 60000);
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValue(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    expectConsoleError('handleNeedCoinSpend error');
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(cancelOffer).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).toHaveBeenCalledTimes(1);
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
    expect(createOfferForIds).toHaveBeenCalledTimes(1);

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: laterRequest }] }));
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledTimes(2);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
  });

  it('reports replacement processing errors without stealing successor cancellation failure', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    let resolveOffer!: (value: { offer: string; tradeId: string }) => void;
    const offer = new Promise<{ offer: string; tradeId: string }>((resolve) => {
      resolveOffer = resolve;
    });
    const createOfferForIds = jest.fn(() => offer);
    const cancelOffer = jest.fn().mockRejectedValue(new Error('cancellation failed'));
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds, cancelOffer }, 60000);
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValue(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingSave();
    for (let i = 0; i < 10 && createOfferForIds.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    const processResult = blob.processResult.bind(blob);
    jest
      .spyOn(blob, 'processResult')
      .mockImplementationOnce(() => {
        throw new Error('replacement processing failed');
      })
      .mockImplementation(processResult);

    expectConsoleError('replacement processing failed');
    expectConsoleError('cancellation failed');
    resolveOffer({ offer: 'offer1first', tradeId: 'trade-1' });
    await blob.flushPendingWork();

    expect(cancelOffer).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).toHaveBeenCalledTimes(2);
    expect(walletCallbackFailed).toHaveBeenCalledWith('replacement processing failed');
    expect(walletCallbackFailed).toHaveBeenCalledWith('cancellation failed');
    expect(
      walletCallbackFailed.mock.calls.filter(
        ([message]) => message === 'replacement processing failed',
      ),
    ).toHaveLength(1);
    expect(
      walletCallbackFailed.mock.calls.filter(([message]) => message === 'cancellation failed'),
    ).toHaveLength(1);
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('deduplicates duplicate replacement funding keys behind one cancellation', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const createOfferForIds = jest
      .fn()
      .mockResolvedValueOnce({ offer: 'offer1first', tradeId: 'trade-1' })
      .mockResolvedValueOnce(testSpendBundle('replacement'));
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds, cancelOffer }, 60000);
    const { blob, cradle } = createReadyBlob();
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValueOnce(
        wasmResult({
          events: [{ NeedCoinSpend: request }, { NeedCoinSpend: request }],
        }),
      );
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(cancelOffer).toHaveBeenCalledTimes(1);
    expect(createOfferForIds).toHaveBeenCalledTimes(2);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('fails one distinct concurrent funding request without launching it', async () => {
    const first: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['first'] }],
    };
    const second: NeedCoinSpendRequest = {
      amount: '101',
      fee: '0',
      conditions: [{ opcode: 60, args: ['second'] }],
    };
    let resolveFirst!: (bundle: ReturnType<typeof testSpendBundle>) => void;
    const firstWalletRequest = new Promise<ReturnType<typeof testSpendBundle>>((resolve) => {
      resolveFirst = resolve;
    });
    const createOfferForIds = jest.fn(() => firstWalletRequest);
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    blob.blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);
    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    expectConsoleError('concurrent funding request');
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: first }] }));
    await blob.flushPendingSave();
    for (let i = 0; i < 10 && createOfferForIds.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: second }] }));
    resolveFirst(testSpendBundle('first'));
    await blob.flushPendingWork();
    subscription.unsubscribe();

    expect(createOfferForIds).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).toHaveBeenCalledTimes(1);
    expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
    expect(errors.filter((error) => error.includes('concurrent funding request'))).toHaveLength(1);
  });

  it('reschedules an unlaunched funding attempt onto a replacement runtime once', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('replacement-runtime'));
    const { blob } = createReadyBlob();
    blob.blockchain = new BlockchainPoller({ ...mockRpc, createOfferForIds }, 60000);

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    const replacement = createCoordinatorOnlySessionMachineRuntime(blob);
    await replacement.persist();
    await blob.flushPendingWork();

    expect(createOfferForIds).toHaveBeenCalledTimes(1);
    replacement.retire();
  });
});

describe('wallet fee attachment on submission', () => {
  const protocolBundle = {
    coin_spends: [
      {
        coin: {
          parent_coin_info: `0x${'aa'.repeat(32)}`,
          puzzle_hash: `0x${'bb'.repeat(32)}`,
          amount: 100n,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      },
      {
        coin: {
          parent_coin_info: `0x${'cc'.repeat(32)}`,
          puzzle_hash: '0xeff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9',
          amount: 0n,
        },
        puzzle_reveal: '0x80',
        solution: '0x80',
      },
    ],
    aggregated_signature: '0xproto',
  };

  const feeTarget = 'dd'.repeat(32);

  function setFinalizer(blob: SessionController, finalize: jest.Mock) {
    (blob as unknown as { cradle: { finalize_submission: jest.Mock } }).cradle.finalize_submission =
      finalize;
  }

  it('does not attach a second fee spend to a channel-opening bundle', async () => {
    const createFeeSpend = jest.fn();
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, { ...testSpendBundle('coin'), name: 'arbitrary-name' });
    await transactionSubmitQueue(blob);

    expect(createFeeSpend).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      undefined,
    );
  });

  it('aggregates a wallet fee spend into the submitted bundle', async () => {
    const aggregated = { coin_spends: [], aggregated_signature: '0xcombined' };
    const createFeeSpend = jest.fn().mockResolvedValue({ kind: 'offer', offer: 'offer1signed' });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: aggregated,
      applied_fee: '10',
      warning: null,
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);

    expect(createFeeSpend).toHaveBeenCalledWith(10n, feeTarget);
    expect(finalize).toHaveBeenCalledWith(
      expect.any(String),
      jsonStringify({ kind: 'offer', offer: 'offer1signed' }),
    );
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      aggregated,
      '11'.repeat(32),
      'submitTransaction',
      10n,
    );
  });

  it('gates fee creation and finalized broadcast on persistence attempts, continuing after failure', async () => {
    const order: string[] = [];
    const createFeeSpend = jest.fn().mockImplementation(async () => {
      order.push('fee');
      return { kind: 'offer', offer: 'offer1signed' };
    });
    const spend = jest.fn().mockImplementation(async () => {
      order.push('spend');
      return { status: 'acknowledged' };
    });
    const finalize = jest.fn().mockImplementation(() => {
      order.push('finalize');
      return {
        protocol_bundle: testSpendBundle('coin'),
        bundle: protocolBundle,
        applied_fee: '10',
        warning: null,
      };
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    setFinalizer(blob, finalize);
    let writes = 0;
    setTestPersistence(blob, async () => {
      writes += 1;
      order.push(`persist-${writes}`);
      if (writes <= 2) throw new Error(`disk full ${writes}`);
    });

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    expect(createFeeSpend).not.toHaveBeenCalled();
    await expect(blob.flushPendingSave()).rejects.toThrow('disk full 1');
    for (let i = 0; i < 10 && finalize.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(order.slice(0, 2)).toEqual(['persist-1', 'fee']);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(spend).not.toHaveBeenCalled();

    await expect(blob.flushPendingSave()).rejects.toThrow('disk full 2');
    await blob.flushTransactionSubmissions();

    expect(order).toEqual(['persist-1', 'fee', 'finalize', 'persist-2', 'spend']);
    expect(spend).toHaveBeenCalledTimes(1);
    await blob.flushPendingSave();
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('contains synchronous broadcast preparation failure and runs the next submission', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest
      .fn()
      .mockReturnValueOnce({
        protocol_bundle: testSpendBundle('bad'),
        bundle: protocolBundle,
        applied_fee: 'not-a-bigint',
        warning: null,
      })
      .mockReturnValueOnce({
        protocol_bundle: testSpendBundle('good'),
        bundle: protocolBundle,
        applied_fee: '0',
        warning: null,
      });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, spend }, 60000);
    setFinalizer(blob, finalize);

    expectConsoleError('submitTransaction failed');
    submitTransaction(blob, testSpendBundle('first'));
    submitTransaction(blob, testSpendBundle('second'));
    await transactionSubmitQueue(blob);

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('contains an asynchronous wallet failure and runs the next submission', async () => {
    const spend = jest
      .fn()
      .mockRejectedValueOnce(new Error('wallet disconnected'))
      .mockResolvedValueOnce({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, spend }, 60000);
    setFinalizer(blob, finalize);
    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    expectConsoleError('submitTransaction failed');
    submitTransaction(blob, testSpendBundle('first'));
    submitTransaction(blob, testSpendBundle('second'));
    await transactionSubmitQueue(blob);
    subscription.unsubscribe();

    expect(spend).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([
      expect.stringContaining('retained for retry after a local submission failure'),
    ]);
    expect((blob as unknown as { resubmitAfterChainSync: boolean }).resubmitAfterChainSync).toBe(
      true,
    );
  });

  it('tracks one outer release through fee, broadcast, and outcome recording', async () => {
    let resolveFirstFee!: (value: undefined) => void;
    const firstFee = new Promise<undefined>((resolve) => {
      resolveFirstFee = resolve;
    });
    const createFeeSpend = jest
      .fn()
      .mockImplementationOnce(() => firstFee)
      .mockResolvedValue(undefined);
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    setFinalizer(blob, finalize);
    const pendingEffects = (blob as unknown as { pendingEffects: Set<Promise<void>> })
      .pendingEffects;

    submitTransaction(blob, testSpendBundle('first'), { target: feeTarget, amount: '10' });
    expect(pendingEffects.size).toBe(1);
    await blob.flushPendingSave();
    for (let i = 0; i < 10 && pendingEffects.size > 0; i += 1) {
      await Promise.resolve();
    }

    expect(createFeeSpend).toHaveBeenCalledTimes(1);
    expect(pendingEffects.size).toBe(1);

    resolveFirstFee(undefined);
    await blob.flushPendingWork();
    expect(pendingEffects.size).toBe(0);

    submitTransaction(blob, testSpendBundle('second'), { target: feeTarget, amount: '10' });
    expect(pendingEffects.size).toBe(1);
    await blob.quiesceForTerminalFinalization();
    expect(createFeeSpend).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(pendingEffects.size).toBe(0);
  });

  it('keeps terminal quiescence blocked through broadcast and persists the wallet outcome', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spendGate = new Promise<{ status: 'acknowledged' }>((resolve) => {
      resolveSpend = resolve;
    });
    const spend = jest.fn(() => spendGate);
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
    });
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, spend }, 60000);
    setFinalizer(blob, finalize);
    const persistedAcknowledgementCounts: number[] = [];
    setTestPersistence(blob, () => {
      persistedAcknowledgementCounts.push(cradle.acknowledge_submission.mock.calls.length);
    });

    submitTransaction(blob, testSpendBundle('coin'));
    let quiesced = false;
    const quiescence = blob.quiesceForTerminalFinalization().then(() => {
      quiesced = true;
    });
    for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(spend).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(cradle.acknowledge_submission).not.toHaveBeenCalled();

    resolveSpend({ status: 'acknowledged' });
    await quiescence;
    expect(quiesced).toBe(true);
    expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
    expect(persistedAcknowledgementCounts.at(-1)).toBe(1);
  });

  it('passes through an already-complete provider fee bundle', async () => {
    const feeSpend = {
      coin_spends: [
        {
          coin: {
            parent_coin_info: `0x${'99'.repeat(32)}`,
            puzzle_hash: `0x${'88'.repeat(32)}`,
            amount: 1000n,
          },
          puzzle_reveal: '0x80',
          solution: '0x80',
        },
      ],
      aggregated_signature: '0xfee',
    };
    const aggregated = { coin_spends: [], aggregated_signature: '0xcombined' };
    const createFeeSpend = jest.fn().mockResolvedValue({ kind: 'bundle', bundle: feeSpend });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: aggregated,
      applied_fee: '10',
      warning: null,
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);

    expect(finalize).toHaveBeenCalledWith(
      expect.any(String),
      jsonStringify({ kind: 'bundle', bundle: feeSpend }),
    );
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      aggregated,
      '11'.repeat(32),
      'submitTransaction',
      10n,
    );
  });

  it('retains an unavailable fee request and requests the fee again after fresh sync', async () => {
    const submission = {
      id: 'fee-retry',
      bundle: testSpendBundle('coin'),
      fee_request: { target: feeTarget, amount: '10' },
    };
    const createFeeSpend = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'wallet transport disconnected' })
      .mockResolvedValueOnce({ kind: 'offer', offer: 'offer1signed' });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, createFeeSpend, spend, isReadyForPlay: () => true },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    (cradle.drain_submissions as jest.Mock)
      .mockReturnValueOnce([submission])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([submission]);
    (cradle.finalize_submission as jest.Mock).mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '10',
      warning: null,
    });

    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(createFeeSpend).toHaveBeenCalledTimes(1);
    expect(cradle.finalize_submission).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();

    blob.reportNewBlock(2n);
    await transactionSubmitQueue(blob);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    expect(createFeeSpend).toHaveBeenCalledTimes(2);
    expect(cradle.finalize_submission).toHaveBeenCalledWith(
      submission.id,
      jsonStringify({ kind: 'offer', offer: 'offer1signed' }),
    );
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      10n,
    );
  });

  it('submits with zero fee and warns the user when the wallet cannot build a fee offer', async () => {
    const createFeeSpend = jest.fn().mockResolvedValue(null);
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockImplementation((_id: string, feeSource: string) => {
      expect(JSON.parse(feeSource)).toEqual({
        kind: 'failure',
        reason: 'the wallet could not build a signed fee source',
      });
      return {
        protocol_bundle: testSpendBundle('coin'),
        bundle: protocolBundle,
        applied_fee: '0',
        warning:
          'Configured fee was not applied: the wallet could not build a signed fee source. The transaction will be attempted without a fee.',
      };
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);
    subscription.unsubscribe();

    expect(createFeeSpend).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalled();
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      undefined,
    );
    // The user is warned that their configured fee was dropped for this tx.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/fee was not applied/i);
  });

  it('surfaces Rust fallback warning when a fee source reuses a protocol input coin', async () => {
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer1signed',
      tradeId: 'Offer_fee',
    });
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning:
        'Configured fee was not applied: fee bundle reuses protocol input coin. The transaction will be attempted without a fee.',
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, createFeeSpend, cancelOffer, spend },
      60000,
    );
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);
    subscription.unsubscribe();

    expect(finalize).toHaveBeenCalledWith(
      expect.any(String),
      jsonStringify({ kind: 'offer', offer: 'offer1signed' }),
    );
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      undefined,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/reuses protocol input coin/i);
    expect(cancelOffer).toHaveBeenCalledWith('Offer_fee');
  });

  it('cancels a Cloud fee offer when the finalized transaction is rejected', async () => {
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer1signed',
      tradeId: 'Offer_fee',
    });
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'invalid spend' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '10',
      warning: null,
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, createFeeSpend, cancelOffer, spend },
      60000,
    );
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);

    expect(cancelOffer).toHaveBeenCalledWith('Offer_fee');
  });

  it('surfaces the real wallet error in the warning when the fee offer fails', async () => {
    const createFeeSpend = jest.fn().mockRejectedValue(new Error('Internal error (code=-32603)'));
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockImplementation((_id: string, feeSource: string) => {
      const source = JSON.parse(feeSource);
      return {
        protocol_bundle: testSpendBundle('coin'),
        bundle: protocolBundle,
        applied_fee: '0',
        warning: `Configured fee was not applied: ${source.reason}. The transaction will be attempted without a fee.`,
      };
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, createFeeSpend, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);
    subscription.unsubscribe();

    expect(createFeeSpend).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalled();
    // Zero-fee fallback still submits the protocol bundle.
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      undefined,
    );
    // The warning carries the actual wallet reason, not a blanket balance guess.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/fee was not applied/i);
    expect(errors[0]).toContain('Internal error (code=-32603)');
  });
});
