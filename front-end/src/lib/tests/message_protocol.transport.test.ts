import { expectConsoleError } from '../../../scripts/testSetup';
import { walletReservationLedger } from '../session/walletReservationLedger';
import { Program } from 'clvm-lib';
import { SessionController } from '../../hooks/SessionController';
import type {
  NeedCoinSpendRequest,
  TransactionSubmission,
  WasmResult,
} from '../../types/ChiaGaming';
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
  submissionDrain,
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
  it('rejects number state fields in a direct controller event', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const status = {
      ...channelStatus({ state: 'Active' }),
      state_number: 1,
    };

    expectConsoleError('invalid channelStatus.state_number');
    blob.processResult(
      wasmResult({
        events: [
          {
            Notification: { ChannelStatus: status },
          } as unknown as WasmResult['events'][number],
        ],
      }),
    );

    expect(blob.lastChannelStatus).toBeNull();
  });

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

  it('binds protocol identities before publishing a puzzle-hash ProposalMade', () => {
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
    expect(tags).toEqual(['ProposalMade']);
    expect(protocolIdentitiesReady()).toBe(true);

    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'active' },
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } }],
    });
    blob.flushDeferredWork();
    expect(protocolIdentitiesReady()).toBe(true);
    expect(tags).toEqual(['ProposalMade', 'ChannelStatus']);
  });

  it('reports a bind failure on Active and still delivers ChannelStatus', () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    _resetGameIdentityWarmupForTests();
    blob.wc = {
      registered_game_packages: () => [],
    } as (typeof blob)['wc'];
    expectConsoleError('completeRegisteredGames failed');
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
  it('reconstructs a lost receive gap solely from the sender reliable journal after both peers reload', async () => {
    const sender = createReadyBlob();
    sender.blob.processResult(
      wasmResult({
        events: [{ OutboundMessage: enc('frame-n') }, { OutboundMessage: enc('frame-n-plus-one') }],
      }),
    );
    await sender.blob.flushPendingWork();
    expect(sender.sentMessages.map(({ msgno }) => msgno)).toEqual([1, 2]);
    const senderCheckpoint = {
      messageNumber: sender.blob.messageNumber,
      unackedMessages: structuredClone(sender.blob.unackedMessages),
    };

    const beforeReload = createReadyBlob();
    beforeReload.blob.deliverMessage(
      BigInt(sender.sentMessages[1].msgno),
      sender.sentMessages[1].msg,
    );
    expect(beforeReload.cradle.deliver_message).not.toHaveBeenCalled();
    expect((beforeReload.blob as any).reorderQueue.size).toBe(1);
    beforeReload.blob.cleanup();

    let authoritativeMoveEvents = 0;
    const afterReload = createReadyBlob((message) =>
      new TextDecoder().decode(message) === 'frame-n-plus-one'
        ? {
            events: [
              {
                Notification: {
                  LocalActionApplied: { id: 'game-1', action: 'make_move' },
                },
              },
            ],
          }
        : { events: [] },
    );
    afterReload.blob.getObservable().subscribe((event) => {
      if (event.type === 'notification' && event.data.LocalActionApplied?.action === 'make_move') {
        authoritativeMoveEvents += 1;
      }
    });
    expect((afterReload.blob as any).reorderQueue.size).toBe(0);

    const retransmitted: Array<{ msgno: number; msg: Uint8Array }> = [];
    const restoredSender = new SessionController(
      mockBlockchain,
      'test-sender-restored',
      100n,
      100n,
      makePeerConn(retransmitted, []),
    );
    restoredSender.messageNumber = senderCheckpoint.messageNumber;
    restoredSender.unackedMessages = senderCheckpoint.unackedMessages;
    restoredSender.loadWasm(mockWasmConnection);
    restoredSender.setGameSession(makeMockCradle());
    restoredSender.kickSystem(2);

    expect(restoredSender.resendUnacked()).toBe(true);
    expect(retransmitted.map(({ msgno }) => msgno)).toEqual([1, 2]);
    for (const frame of retransmitted) {
      afterReload.blob.deliverMessage(BigInt(frame.msgno), frame.msg);
    }

    expect(
      (afterReload.cradle.deliver_message as jest.Mock).mock.calls.map(([message]) =>
        new TextDecoder().decode(message),
      ),
    ).toEqual(['frame-n', 'frame-n-plus-one']);
    expect(afterReload.blob.remoteNumber).toBe(2n);
    expect(authoritativeMoveEvents).toBe(1);
    expect((afterReload.blob as any).reorderQueue.size).toBe(0);
  });

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
    expect((blob as any).reorderQueue.size).toBe(0);
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
    expect((byteLimited.blob as any).reorderQueue.size).toBe(0);
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

  it('forwards a typed NeedCoinSpend payload to the wallet offer lifecycle', async () => {
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('coin-spend') },
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer }, 60000);
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

    expect(beginWalletOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: expect.objectContaining({ kind: 'funding' }),
      }),
      {
        kind: 'funding',
        uniqueId: 'test',
        offer: { '1': -100n },
        extraConditions: [{ opcode: 60n, args: ['launcher'] }],
        coinIds: ['ab'.repeat(32)],
        maxHeight: 123n,
        openingFee: 10n,
      },
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
    const beginWalletOffer = jest.fn().mockImplementation(async () => {
      order.push('funding');
      return {
        kind: 'created',
        material: { kind: 'bundle', bundle: testSpendBundle('coin-spend') },
      };
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer }, 60000);
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
    expect(beginWalletOffer).not.toHaveBeenCalled();
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ amount: '100', fee: '10' }),
      }),
    ]);
    await expect(blob.flushPendingSave()).rejects.toThrow('disk full');
    await Promise.resolve();

    expect(order.slice(0, 2)).toEqual(['persist', 'funding']);
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    await blob.flushPendingSave();
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
  });

  it('deduplicates duplicate initial funding events by canonical key', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('initial') },
    });
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer }, 60000);

    blob.processResult(
      wasmResult({ events: [{ NeedCoinSpend: request }, { NeedCoinSpend: request }] }),
    );
    await blob.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
  });

  it('does not coordinate a successful offer result with an unexpected successor request', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const successor: NeedCoinSpendRequest = {
      amount: '101',
      fee: '0',
      conditions: [{ opcode: 60, args: ['unexpected-successor'] }],
    };
    const unexpectedResult = wasmResult({ events: [{ NeedCoinSpend: successor }] });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1unexpected' },
      tradeId: 'trade-1',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValue(unexpectedResult);
    const processResult = jest.spyOn(
      blob as unknown as { processResultNow(result: WasmResult | undefined): void },
      'processResultNow',
    );
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    expectConsoleError('concurrent funding request');
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(processResult.mock.calls.filter(([result]) => result === unexpectedResult)).toHaveLength(
      1,
    );
    expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    expect(walletCallbackFailed).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).toHaveBeenCalledWith(
      expect.stringContaining('concurrent funding request'),
    );
    expect(walletReservationLedger.snapshot()).toEqual([]);
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('cancels the original trade and reports one callback failure when offer validation throws', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1invalid' },
      tradeId: 'trade-1',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockImplementation(() => {
        throw new Error('wallet funding offer failed validation');
      });
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    expectConsoleError('wallet funding offer failed validation');
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-1');
    expect(walletCallbackFailed).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).toHaveBeenCalledWith('wallet funding offer failed validation');
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('routes a late funding result through the ledger after controller teardown', async () => {
    let resolveOffer!: (value: {
      kind: 'created';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const beginWalletOffer = jest.fn(
      () =>
        new Promise<{
          kind: 'created';
          material: { kind: 'offer'; offer: string };
          tradeId: string;
        }>((resolve) => {
          resolveOffer = resolve;
        }),
    );
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    const provideOffer = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = provideOffer;
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    blob.processResult(
      wasmResult({
        events: [
          {
            NeedCoinSpend: {
              amount: '100',
              fee: '0',
              conditions: [{ opcode: 60, args: ['launcher'] }],
            },
          },
        ],
      }),
    );
    await blob.flushPendingSave();
    for (let i = 0; i < 20 && beginWalletOffer.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    blob.cleanup();
    resolveOffer({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1late' },
      tradeId: 'trade-late',
    });
    for (
      let pass = 0;
      pass < 20 && beginWalletOfferCancellation.mock.calls.length === 0;
      pass += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await walletReservationLedger.awaitOwner({
      installationPlayerId: 'test',
      peerSessionId: '00'.repeat(16),
      providerScope: { provider: 'simulator', identity: 'submission-handoff' },
    });

    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late');
    expect(provideOffer).not.toHaveBeenCalled();
  });

  it('processes a successful persisted offer result once and advances once', async () => {
    const request: NeedCoinSpendRequest = {
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60, args: ['launcher'] }],
    };
    const successfulResult = wasmResult({
      events: [{ Notification: { ActionFailed: { reason: 'advanced' } } }],
    });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1success' },
      tradeId: 'trade-1',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    (cradle as unknown as { provide_offer_bech32: jest.Mock }).provide_offer_bech32 = jest
      .fn()
      .mockReturnValue(successfulResult);
    const processResult = jest.spyOn(
      blob as unknown as { processResultNow(result: WasmResult | undefined): void },
      'processResultNow',
    );
    const advances: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'notification' && event.data.ActionFailed) {
        advances.push(String(event.data.ActionFailed.reason));
      }
    });
    setActiveBlob(blob);
    blob.blockchain = blockchain;

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    await blob.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(processResult.mock.calls.filter(([result]) => result === successfulResult)).toHaveLength(
      1,
    );
    expect(advances).toEqual(['advanced']);
    expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('keeps funding pending on wallet unavailability and retries on readiness', async () => {
    const beginWalletOffer = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'wallet disconnected' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'bundle', bundle: testSpendBundle('funding-retry') },
      });
    let readiness: ((ready: boolean) => void) | undefined;
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        beginWalletOffer,
        onPlayReadinessChange: (callback: (ready: boolean) => void) => {
          readiness = callback;
          return () => {};
        },
      },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    setActiveBlob(blob);
    blob.attachBlockchain(blockchain);

    blob.processResult(
      wasmResult({
        events: [
          {
            NeedCoinSpend: {
              amount: '100',
              fee: '0',
              conditions: [{ opcode: 60, args: ['launcher'] }],
            },
          },
        ],
      }),
    );
    await blob.flushPendingWork();
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(walletCallbackFailed).not.toHaveBeenCalled();
    expect(blob.getWasmFields()?.fundingOutbox).toHaveLength(1);

    readiness?.(true);
    await blob.flushPendingWork();
    expect(beginWalletOffer).toHaveBeenCalledTimes(2);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    expect(blob.getWasmFields()?.fundingOutbox).toEqual([]);
  });

  it('asks Rust for fee upgrades only on provider attach or readiness', async () => {
    let readiness: ((ready: boolean) => void) | undefined;
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        onPlayReadinessChange: (callback: (ready: boolean) => void) => {
          readiness = callback;
          return () => {};
        },
      },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);

    blob.attachBlockchain(blockchain);
    await blob.flushPendingWork();
    expect(cradle.request_fee_upgrades).toHaveBeenCalledTimes(1);

    readiness?.(false);
    await blob.flushPendingWork();
    expect(cradle.request_fee_upgrades).toHaveBeenCalledTimes(1);

    readiness?.(true);
    await blob.flushPendingWork();
    expect(cradle.request_fee_upgrades).toHaveBeenCalledTimes(2);
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
    let resolveFirst!: (outcome: {
      kind: 'created';
      material: { kind: 'bundle'; bundle: ReturnType<typeof testSpendBundle> };
    }) => void;
    const firstWalletRequest = new Promise<{
      kind: 'created';
      material: { kind: 'bundle'; bundle: ReturnType<typeof testSpendBundle> };
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const beginWalletOffer = jest.fn(() => firstWalletRequest);
    const { blob, cradle } = createReadyBlob();
    const walletCallbackFailed = jest.fn().mockReturnValue(wasmResult());
    (cradle as unknown as { wallet_callback_failed: jest.Mock }).wallet_callback_failed =
      walletCallbackFailed;
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer }, 60000);
    const errors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });

    expectConsoleError('concurrent funding request');
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: first }] }));
    await blob.flushPendingSave();
    for (let i = 0; i < 10 && beginWalletOffer.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: second }] }));
    resolveFirst({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('first') },
    });
    await blob.flushPendingWork();
    subscription.unsubscribe();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
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
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('replacement-runtime') },
    });
    const { blob } = createReadyBlob();
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer }, 60000);

    blob.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    const replacement = createCoordinatorOnlySessionMachineRuntime(blob);
    await replacement.persist();
    await blob.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
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
    (
      blob as unknown as {
        cradle: {
          finalize_submission: (
            id: string,
            goal: TransactionSubmission['delivery_goal'],
            variantFingerprint: string,
            feeSourceJson?: string,
          ) => unknown;
        };
      }
    ).cradle.finalize_submission = (id, _goal, variantFingerprint, feeSourceJson) => ({
      ...(finalize(id, feeSourceJson) as object),
      variant_fingerprint: variantFingerprint,
      should_broadcast: true,
    });
  }

  it('does not attach a second fee spend to a channel-opening bundle', async () => {
    const beginWalletOffer = jest.fn();
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
      fee_source_disposition: 'not-requested',
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, { ...testSpendBundle('coin'), name: 'arbitrary-name' });
    await transactionSubmitQueue(blob);

    expect(beginWalletOffer).not.toHaveBeenCalled();
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
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'fee-aggregate-trade',
    });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'already-terminal', detail: 'offer already spent' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: aggregated,
      applied_fee: '10',
      warning: null,
      fee_source_disposition: 'attached',
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, spend, beginWalletOfferCancellation },
      60000,
    );
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);

    expect(beginWalletOffer).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: { kind: 'fee', operationId: expect.any(String) } }),
      {
        kind: 'fee',
        uniqueId: 'test',
        fee: 10n,
        concurrentSpendCoinId: feeTarget,
      },
    );
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
    expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    expect(walletReservationLedger.snapshot()[0]).toEqual(
      expect.objectContaining({
        tradeId: 'fee-aggregate-trade',
        stage: 'retained-for-replay',
      }),
    );
  });

  it('does not retain fee material when finalized-result conversion fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'fee-conversion-failure-trade',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const spend = jest.fn();
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation, spend },
      60000,
    );
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(
      blob,
      jest.fn(() => {
        throw new Error('failed to convert finalized transaction result');
      }),
    );

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    await transactionSubmitQueue(blob);
    await blob.flushPendingWork();

    expect(spend).not.toHaveBeenCalled();
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('fee-conversion-failure-trade');
    expect(walletReservationLedger.snapshot()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to convert finalized transaction result'),
    );
    errorSpy.mockRestore();
  });

  it('gates fee creation and finalized broadcast on persistence attempts, continuing after failure', async () => {
    const order: string[] = [];
    const beginWalletOffer = jest.fn().mockImplementation(async () => {
      order.push('fee');
      return {
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1signed' },
        tradeId: 'fee-gated-trade',
      };
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
        fee_source_disposition: 'attached',
      };
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
    setFinalizer(blob, finalize);
    let writes = 0;
    setTestPersistence(blob, async () => {
      writes += 1;
      order.push(`persist-${writes}`);
      if (writes <= 2) throw new Error(`disk full ${writes}`);
    });

    submitTransaction(blob, testSpendBundle('coin'), { target: feeTarget, amount: '10' });
    expect(beginWalletOffer).not.toHaveBeenCalled();
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
        fee_source_disposition: 'not-requested',
      })
      .mockReturnValueOnce({
        protocol_bundle: testSpendBundle('good'),
        bundle: protocolBundle,
        applied_fee: '0',
        warning: null,
        fee_source_disposition: 'not-requested',
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
      fee_source_disposition: 'not-requested',
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

  it('tracks launched submission only in the ordered queue', async () => {
    const unavailableFee = {
      kind: 'failure' as const,
      reason: 'the wallet could not build a signed fee source',
    };
    let resolveFirstFee!: (value: typeof unavailableFee) => void;
    const firstFee = new Promise<typeof unavailableFee>((resolve) => {
      resolveFirstFee = resolve;
    });
    const beginWalletOffer = jest
      .fn()
      .mockImplementationOnce(() => firstFee)
      .mockResolvedValue(unavailableFee);
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning: null,
      fee_source_disposition: 'unused',
    });
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
    setFinalizer(blob, finalize);
    const pendingEffects = (blob as unknown as { pendingEffects: Set<Promise<void>> })
      .pendingEffects;
    const deliveries = (blob as any).submissionDeliveries;

    submitTransaction(blob, testSpendBundle('first'), { target: feeTarget, amount: '10' });
    expect(pendingEffects.size).toBe(0);
    expect(deliveries.hasPending()).toBe(true);
    await blob.flushPendingSave();
    for (let i = 0; i < 10 && beginWalletOffer.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(pendingEffects.size).toBe(0);
    expect(deliveries.hasPending()).toBe(true);

    resolveFirstFee(unavailableFee);
    await blob.flushPendingWork();
    expect(pendingEffects.size).toBe(0);
    expect(deliveries.hasPending()).toBe(false);

    submitTransaction(blob, testSpendBundle('second'), { target: feeTarget, amount: '10' });
    expect(pendingEffects.size).toBe(0);
    expect(deliveries.hasPending()).toBe(true);
    await blob.quiesceForTerminalFinalization();
    expect(beginWalletOffer).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(pendingEffects.size).toBe(0);
    expect(deliveries.hasPending()).toBe(false);
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
      fee_source_disposition: 'not-requested',
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
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: feeSpend },
    });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: aggregated,
      applied_fee: '10',
      warning: null,
      fee_source_disposition: 'attached',
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
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

  it('broadcasts base immediately and requests an upgrade on provider attachment', async () => {
    const submission = {
      id: 'fee-retry',
      bundle: testSpendBundle('coin'),
      fee_request: { target: feeTarget, amount: '10' },
    };
    const beginWalletOffer = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'wallet transport disconnected' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1signed' },
        tradeId: 'fee-retry-trade',
      });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, spend, isReadyForPlay: () => true },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    (cradle.drain_submissions as jest.Mock)
      .mockReturnValueOnce(submissionDrain([submission]))
      .mockReturnValueOnce(submissionDrain([{ ...submission, delivery_goal: 'fee-upgrade' }]));
    (cradle.finalize_submission as jest.Mock)
      .mockImplementationOnce(
        (_id: string, _goal: string, variantFingerprint: string, feeSourceJson: string) => {
          expect(JSON.parse(feeSourceJson)).toEqual({
            kind: 'failure',
            reason: 'wallet transport disconnected',
          });
          return {
            protocol_bundle: testSpendBundle('coin'),
            bundle: protocolBundle,
            applied_fee: '0',
            warning: null,
            fee_source_disposition: 'unused',
            variant_fingerprint: variantFingerprint,
            should_broadcast: true,
          };
        },
      )
      .mockImplementationOnce(
        (_id: string, _goal: string, _variantFingerprint: string, _feeSourceJson: string) => ({
          protocol_bundle: testSpendBundle('coin'),
          bundle: protocolBundle,
          applied_fee: '10',
          warning: null,
          fee_source_disposition: 'attached',
          variant_fingerprint: 'cc'.repeat(32),
          should_broadcast: true,
        }),
      );

    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      undefined,
    );

    blob.attachBlockchain(blockchain);
    await transactionSubmitQueue(blob);
    await transactionSubmitQueue(blob);
    for (
      let attempt = 0;
      attempt < 20 && (cradle.finalize_submission as jest.Mock).mock.calls.length < 2;
      attempt += 1
    ) {
      await blob.flushPendingWork();
      await Promise.resolve();
    }
    await transactionSubmitQueue(blob);

    expect(cradle.request_fee_upgrades).toHaveBeenCalledTimes(1);
    expect(beginWalletOffer).toHaveBeenCalledTimes(2);
    expect(cradle.finalize_submission).toHaveBeenLastCalledWith(
      submission.id,
      'fee-upgrade',
      'bb'.repeat(32),
      jsonStringify({ kind: 'offer', offer: 'offer1signed' }),
    );
    expect(spend).toHaveBeenLastCalledWith(
      expect.any(String),
      protocolBundle,
      '11'.repeat(32),
      'submitTransaction',
      10n,
    );
  });

  it('replays an attached fee source exactly without requesting a second trade', async () => {
    const initial = {
      id: 'attached-replay',
      bundle: testSpendBundle('coin'),
      fee_request: { target: feeTarget, amount: '10' },
    };
    const exactReplay = { ...initial, fee_request: null };
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'attached-replay-trade',
    });
    const spend = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'wallet disconnected' })
      .mockResolvedValueOnce({ status: 'acknowledged' });
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'already-terminal', detail: 'offer already spent' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        beginWalletOffer,
        spend,
        beginWalletOfferCancellation,
        isReadyForPlay: () => true,
      },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    (cradle.drain_submissions as jest.Mock)
      .mockReturnValueOnce(submissionDrain([initial]))
      .mockReturnValueOnce(submissionDrain())
      .mockReturnValueOnce(submissionDrain([exactReplay]));
    (cradle.finalize_submission as jest.Mock).mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '10',
      warning: null,
      fee_source_disposition: 'attached',
      variant_fingerprint: 'bb'.repeat(32),
      should_broadcast: true,
    });

    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'attached-replay-trade',
        stage: 'retained-for-replay',
      }),
    ]);

    blob.reportNewBlock(2n);
    await transactionSubmitQueue(blob);

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.finalize_submission).toHaveBeenLastCalledWith(
      initial.id,
      'ensure-broadcast',
      'bb'.repeat(32),
      undefined,
    );
    expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    expect(walletReservationLedger.snapshot()[0]).toEqual(
      expect.objectContaining({
        tradeId: 'attached-replay-trade',
        stage: 'retained-for-replay',
      }),
    );
  });

  it('cancels retained fee sources from Rust retirement output', async () => {
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOfferCancellation }, 60000);
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    const owner = (
      blob as unknown as {
        walletReservationOwner(): { installationPlayerId: string; peerSessionId: string };
      }
    ).walletReservationOwner();
    walletReservationLedger.registerReserved(
      'retired-trade',
      owner,
      { kind: 'fee', operationId: 'retired-submission' },
      'fee-offer-created',
    );
    walletReservationLedger.retainForReplay('retired-trade');
    (cradle.drain_submissions as jest.Mock).mockReturnValueOnce(
      submissionDrain([], ['retired-submission']),
    );

    blob.processResult(wasmResult());
    await blob.flushPendingWork();

    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('retired-trade');
  });

  it('propagates drain conversion failure without a recoverable dialog', () => {
    const { blob, cradle } = createReadyBlob();
    (cradle.drain_submissions as jest.Mock).mockImplementation(() => {
      throw new Error('failed to convert transaction submission drain');
    });
    const recoverableEvents: Array<{ error: string }> = [];
    const ordinaryErrors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'recoverable-internal-error') recoverableEvents.push(event);
      if (event.type === 'error') ordinaryErrors.push(event.error);
    });

    expect(() => blob.processResult(wasmResult())).toThrow(
      'failed to convert transaction submission drain',
    );
    subscription.unsubscribe();

    expect(recoverableEvents).toEqual([]);
    expect(ordinaryErrors).toEqual([]);
  });

  it('reports typed drain failures once without blocking valid submissions', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller({ ...mockRpc, spend }, 60000);
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    const valid = {
      id: 'valid-after-quarantine',
      bundle: testSpendBundle('coin'),
      fee_request: null,
    };
    (cradle.drain_submissions as jest.Mock)
      .mockReturnValueOnce(
        submissionDrain(
          [valid],
          [],
          [
            {
              candidate_index: '1',
              retained_submission_id: null,
              candidate_submission_id: '7',
              intent_fingerprint: 'aa'.repeat(32),
              stage: 'expected-outputs',
              message: 'Failed to derive expected outputs for queued submission',
              rust_context: 'invalid conditions',
            },
          ],
        ),
      )
      .mockReturnValue(submissionDrain());
    const recoverableEvents: Array<{ error: string }> = [];
    const ordinaryErrors: string[] = [];
    const subscription = blob.getObservable().subscribe((event) => {
      if (event.type === 'recoverable-internal-error') recoverableEvents.push(event);
      if (event.type === 'error') ordinaryErrors.push(event.error);
    });

    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);
    subscription.unsubscribe();

    expect(spend).toHaveBeenCalledTimes(1);
    expect(recoverableEvents).toHaveLength(1);
    expect(recoverableEvents[0]?.error).toMatch(/failed item was quarantined/i);
    expect(ordinaryErrors).toEqual([]);
    expect(blob.diagnosticLog.join('\n')).toContain('invalid conditions');
    expect(blob.diagnosticLog.join('\n')).toContain('javascript_stack');
  });

  it('submits with zero fee and warns the user when the wallet cannot build a fee offer', async () => {
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'failure',
      reason: 'the wallet could not build a signed fee source',
    });
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
        fee_source_disposition: 'unused',
      };
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
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

    expect(beginWalletOffer).toHaveBeenCalled();
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
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'Offer_fee',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '0',
      warning:
        'Configured fee was not applied: fee bundle reuses protocol input coin. The transaction will be attempted without a fee.',
      fee_source_disposition: 'unused',
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation, spend },
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
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('Offer_fee');
  });

  it('retains a Cloud fee offer when broadcast is rejected before chain terminality', async () => {
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1signed' },
      tradeId: 'Offer_fee',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'invalid spend' });
    const finalize = jest.fn().mockReturnValue({
      protocol_bundle: testSpendBundle('coin'),
      bundle: protocolBundle,
      applied_fee: '10',
      warning: null,
      fee_source_disposition: 'attached',
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer, beginWalletOfferCancellation, spend },
      60000,
    );
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    blob.blockchain = blockchain;
    blob.getFee = () => 10n;
    setFinalizer(blob, finalize);
    const submission: TransactionSubmission = {
      id: 'rejected-with-fee',
      bundle: testSpendBundle('coin'),
      fee_request: { target: feeTarget, amount: '10' },
      delivery_goal: 'ensure-broadcast',
      intent_fingerprint: 'aa'.repeat(32),
      variant_fingerprint: 'bb'.repeat(32),
    };
    (cradle.drain_submissions as jest.Mock).mockReturnValueOnce(
      submissionDrain([], [submission.id]),
    );

    (
      blob as unknown as { submitTransaction(submission: TransactionSubmission): void }
    ).submitTransaction(submission);
    await transactionSubmitQueue(blob);

    expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    expect(walletReservationLedger.snapshot()[0]).toEqual(
      expect.objectContaining({ tradeId: 'Offer_fee', stage: 'retained-for-replay' }),
    );
  });

  it('surfaces the real wallet error in the warning when the fee offer fails', async () => {
    const beginWalletOffer = jest.fn().mockRejectedValue(new Error('Internal error (code=-32603)'));
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const finalize = jest.fn().mockImplementation((_id: string, feeSource: string) => {
      const source = JSON.parse(feeSource);
      return {
        protocol_bundle: testSpendBundle('coin'),
        bundle: protocolBundle,
        applied_fee: '0',
        warning: `Configured fee was not applied: ${source.reason}. The transaction will be attempted without a fee.`,
        fee_source_disposition: 'unused',
      };
    });
    const blockchain = new BlockchainPoller({ ...mockRpc, beginWalletOffer, spend }, 60000);
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

    expect(beginWalletOffer).toHaveBeenCalled();
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
