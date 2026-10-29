import { mockWasmConnection } from './message_protocol.harness';
import 'fake-indexeddb/auto';
import { createApplication } from '../application/Application';
import type { HubEvent } from '../../services/HubConnection';
import { stubApplicationSession } from './session_frontend.harness';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import Shell from '../../components/Shell';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { markSavedSession, releaseLeaseIfOwner } from '../session/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../session/saveHardReset';
import * as sessionHost from '../session/sessionHost';
import { storageRepository } from '../session/storageRepository';
import * as wasmInit from '../session/wasmLoader';
import { realBlockchainInfo } from '../wallet/RealBlockchainInterface';
import { calpokerStateCodec } from './game_state_helpers';
import { TERMINAL_INSTANCE, activeSave, baseSave } from './session_save_envelope.fixtures';

import { expectConsoleError } from '../../../scripts/testSetup';
import type { HubConnection } from '../../services/HubConnection';
import { PeerSession, encodePeerAppMessage } from '../../services/PeerSession';
import { INITIAL_CHANNEL_STATUS_MODEL, createSessionModel } from '../session/model';

jest.mock('../../components/GameSession', () => {
  const actual = jest.requireActual('../../components/GameSession');
  return { ...actual, __esModule: true, default: () => null };
});

let mockHub: {
  emit: (event: HubEvent) => void;
  getPresence: () => import('../hubPresence').HubPresence;
} | null = null;
const mockSetBusy = jest.fn();
const mockSendToPeer = jest.fn(() => true);
jest.mock('../../services/HubConnection', () => {
  const actual = jest.requireActual('../../services/HubConnection');
  return {
    ...actual,
    HubConnection: jest.fn((_origin, _sessionId, emit, getPresence) => {
      mockHub = { emit, getPresence };
      return {
        disconnect: jest.fn(),
        setBusy: mockSetBusy,
        getPlayerId: () => 'p_' + '11'.repeat(16),
        sendToPeer: mockSendToPeer,
      };
    }),
  };
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function classList() {
  const values = new Set<string>();
  return {
    add: (value: string) => values.add(value),
    contains: (value: string) => values.has(value),
    remove: (value: string) => values.delete(value),
  };
}

async function deleteSessionDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(renderer: ReactTestRenderer, text: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const rendered = renderer.root
      .findAll((node) => typeof node.type === 'string')
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === 'string')
      .join('\n');
    if (rendered.includes(text)) return;
    await flushEffects();
  }
  throw new Error(`Timed out waiting for Shell text: ${text}`);
}

describe('Shell production restore composition', () => {
  let renderer: ReactTestRenderer | null = null;
  let requestTrust: jest.Mock;
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  let stop: (() => void) | undefined;
  beforeEach(async () => {
    const session = stubApplicationSession(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Handshaking' } },
        restore: { status: 'restored', error: null },
      }),
    );
    jest.spyOn(sessionHost, 'createSessionController').mockReturnValue(session.controller);
    jest.spyOn(wasmInit, 'ensureWasmLoaded').mockResolvedValue(mockWasmConnection);
    jest.spyOn(sessionHost, 'restoreSession').mockResolvedValue();
    jest
      .spyOn(sessionHost, 'configSessionController')
      .mockImplementation(async (controller) => controller);
    mockHub = null;
    mockSetBusy.mockClear();
    mockSendToPeer.mockClear();
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage(),
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: storage(),
    });
    requestTrust = jest.fn(() => new Promise<never>(() => {}));
    unhandledRejections = [];
    onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __chiaHub: { requestTrust },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        location: { reload: jest.fn() },
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        body: { style: { cursor: '', userSelect: '' } },
        documentElement: { classList: classList() },
        getElementById: jest.fn(() => null),
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: jest.fn() } },
    });
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();

    jest
      .spyOn(realBlockchainInfo, 'beginConnect')
      .mockImplementation(() => new Promise<never>(() => {}));
    jest.spyOn(realBlockchainInfo, 'isConnected').mockReturnValue(false);
    jest.spyOn(realBlockchainInfo, 'isReadyForPlay').mockReturnValue(false);
    jest.spyOn(realBlockchainInfo, 'onConnectionChange').mockReturnValue(() => {});
  });

  afterEach(async () => {
    if (renderer) {
      act(() => {
        renderer?.unmount();
        stop?.();
      });
      renderer = null;
    }
    jest.restoreAllMocks();
    process.off('unhandledRejection', onUnhandledRejection);
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'navigator');
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('presents locally restored game state while wallet and hub promises stay unresolved', async () => {
    await storageRepository.claimApplicationState();
    const save = baseSave({
      blockchainType: 'walletconnect',
      hubUrl: 'https://hub.example.test',
      activeTab: 'game',
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      terminalIStarted: true,
      activeGameIds: [],
      currentHandGameIds: ['game-1'],
      currentHandOrigin: 'local',
      lastDisplayedGameId: 'game-1',
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': TERMINAL_INSTANCE },
      handState: calpokerStateCodec.encode({
        perPlayerStake: 20n,
        playerHand: [],
        opponentHand: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
      }),
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    act(() => {
      const application = createApplication();
      renderer = create(React.createElement(Shell, { application }));
      stop = application.start();
    });
    expect(renderer!.root.findByProps({ children: 'Loading Chia Gaming…' })).toBeDefined();

    await waitForText(renderer!, 'You have previously saved state.');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    await waitForText(renderer!, 'Resolved Clean');

    expect(
      renderer!.root.findByProps({ 'data-testid': 'finished-session-game-view' }),
    ).toBeDefined();
    expect(renderer!.root.findByProps({ 'aria-label': 'Wallet, disconnected' })).toBeDefined();
    expect(renderer!.root.findByProps({ 'aria-label': 'Hub, disconnected' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Connecting…' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Connect to Hub' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Done' }).props.disabled).toBe(true);
    expect(realBlockchainInfo.beginConnect).toHaveBeenCalledTimes(1);
    expect(requestTrust).toHaveBeenCalledWith('https://hub.example.test');
    await flushEffects();
    expect(unhandledRejections).toEqual([]);
  });

  it.each([
    { peerId: undefined, ready: true, busy: false, presence: { busy: false } },
    {
      peerId: 'p_' + '22'.repeat(16),
      ready: true,
      busy: true,
      presence: { busy: true, reasons: ['restoring'] },
    },
    {
      peerId: undefined,
      ready: false,
      busy: true,
      presence: { busy: true, reasons: ['blockchain-not-ready'] },
    },
  ])(
    'reports restored consent presence peer=$peerId ready=$ready busy=$busy',
    async ({ peerId, ready, presence }) => {
      requestTrust.mockResolvedValue('trusted');
      jest.mocked(realBlockchainInfo.beginConnect).mockResolvedValue({
        qrUri: '',
        skipQr: true,
        finalize: async () => {},
      });
      jest.mocked(realBlockchainInfo.isConnected).mockReturnValue(true);
      jest.mocked(realBlockchainInfo.isReadyForPlay).mockReturnValue(ready);
      jest
        .spyOn(realBlockchainInfo, 'getHeightInfo')
        .mockImplementation(() => new Promise<never>(() => {}));
      jest
        .spyOn(realBlockchainInfo, 'getBalance')
        .mockImplementation(() => new Promise<never>(() => {}));
      await storageRepository.claimApplicationState();
      const save = baseSave({
        blockchainType: 'walletconnect',
        hubUrl: 'https://hub.example.test',
        pairingToken: 'cancelled-pairing',
        gameSessionId: '33'.repeat(16),
        myContribution: '1000',
        theirContribution: '1000',
        perGameAmount: '100',
        iStarted: false,
        transportDisposition: 'proposal-received',
        sessionPeerId: peerId,
      });
      await storageRepository.write(storageRepository.patchApplicationState(() => save));
      markSavedSession();
      releaseLeaseIfOwner();
      storageRepository._resetForTests();
      act(() => {
        const application = createApplication();
        renderer = create(React.createElement(Shell, { application }));
        stop = application.start();
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });
      for (let n = 0; n < 30 && !mockHub; n++) await flushEffects();
      await flushEffects();
      expect(mockHub).not.toBeNull();
      expect(mockHub!.getPresence()).toEqual(presence);
      mockSetBusy.mockClear();
      act(() => {
        mockHub!.emit({ type: 'registered', playerId: 'p_' + '11'.repeat(16) });
      });
      expect(mockSetBusy).toHaveBeenLastCalledWith(presence);
    },
  );

  it('lets a restored handshake be cancelled when its peer remains unavailable', async () => {
    requestTrust.mockResolvedValue('trusted');
    jest.mocked(realBlockchainInfo.beginConnect).mockResolvedValue({
      qrUri: '',
      skipQr: true,
      finalize: async () => {},
    });
    jest.mocked(realBlockchainInfo.isConnected).mockReturnValue(true);
    jest.mocked(realBlockchainInfo.isReadyForPlay).mockReturnValue(true);
    jest
      .spyOn(realBlockchainInfo, 'getHeightInfo')
      .mockImplementation(() => new Promise<never>(() => {}));
    jest
      .spyOn(realBlockchainInfo, 'getBalance')
      .mockImplementation(() => new Promise<never>(() => {}));
    await storageRepository.claimApplicationState();
    const save = baseSave({
      blockchainType: 'walletconnect',
      hubUrl: 'https://hub.example.test',
      pairingToken: 'stale-handshake',
      gameSessionId: '33'.repeat(16),
      sessionPeerId: 'p_' + '22'.repeat(16),
      myContribution: '1000',
      theirContribution: '1000',
      perGameAmount: '100',
      iStarted: true,
      transportDisposition: 'active',
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    act(() => {
      const application = createApplication();
      renderer = create(React.createElement(Shell, { application }));
      stop = application.start();
    });
    await waitForText(renderer!, 'You have previously saved state.');
    let finishPeerLoad!: () => void;
    const peerLoading = new Promise<void>((resolve) => {
      finishPeerLoad = resolve;
    });
    const peerLoader = jest
      .spyOn(wasmInit, 'ensurePeerProtocolLoaded')
      .mockReturnValue(peerLoading);
    await act(async () => {
      void renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    for (let n = 0; n < 30 && !peerLoader.mock.calls.length; n++) await flushEffects();
    expect(peerLoader).toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ children: 'Handshaking' })).toHaveLength(0);
    peerLoader.mockRestore();
    await act(async () => {
      finishPeerLoad();
    });
    await waitForText(renderer!, 'Handshaking');
    for (let n = 0; n < 30 && !mockHub; n++) await flushEffects();
    act(() => {
      mockHub!.emit({ type: 'registered', playerId: 'p_' + '11'.repeat(16) });
      mockHub!.emit({ type: 'peer-unavailable', playerId: 'p_' + '22'.repeat(16) });
    });
    expect(mockSetBusy).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    expect(storageRepository.loadState().session?.phase).toBe('pre-handshake');
    const cancel = renderer!.root.findByProps({ children: 'Cancel' });
    expect(cancel.props.disabled).toBe(false);
    await act(async () => {
      cancel.props.onClick();
      await storageRepository.inspect();
    });
    await waitForText(renderer!, 'No Session');
    expect(storageRepository.loadState().session).toBeNull();
    expect(storageRepository.loadState().rejectionTransports).toHaveLength(1);
    expect(mockSetBusy).toHaveBeenLastCalledWith({ busy: false });
  });

  it.each([false, true])(
    'clears failed peer consent during Accept=%s and admits a new attempt',
    async (accepting) => {
      requestTrust.mockResolvedValue('trusted');
      jest.mocked(realBlockchainInfo.beginConnect).mockResolvedValue({
        qrUri: '',
        skipQr: true,
        finalize: async () => {},
      });
      jest.mocked(realBlockchainInfo.isConnected).mockReturnValue(true);
      jest.mocked(realBlockchainInfo.isReadyForPlay).mockReturnValue(true);
      jest
        .spyOn(realBlockchainInfo, 'getHeightInfo')
        .mockImplementation(() => new Promise<never>(() => {}));
      jest
        .spyOn(realBlockchainInfo, 'getBalance')
        .mockImplementation(() => new Promise<never>(() => {}));
      jest.spyOn(realBlockchainInfo, 'getWalletOfferProvider').mockReturnValue({
        capability: 'best-effort',
        scope: { provider: 'walletconnect', fingerprint: '123', chainId: 'chia:mainnet' },
        beginCreation: jest.fn(),
        cancel: jest.fn(),
      });
      await storageRepository.claimApplicationState();
      const save = baseSave({
        blockchainType: 'walletconnect',
        hubUrl: 'https://hub.example.test',
        activeTab: 'game',
        channelStatus: { state: 'ResolvedClean' },
        coinsOfInterest: [],
        terminalIStarted: true,
        activeGameIds: [],
        currentHandGameIds: [],
        gameInstances: {},
      });
      await storageRepository.write(storageRepository.patchApplicationState(() => save));
      markSavedSession();
      releaseLeaseIfOwner();
      storageRepository._resetForTests();
      act(() => {
        const application = createApplication();
        renderer = create(React.createElement(Shell, { application }));
        stop = application.start();
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });
      await waitForText(renderer!, 'Resolved Clean');
      for (let n = 0; n < 30 && !mockHub; n++) await flushEffects();
      expect(mockHub).not.toBeNull();
      const frames: Uint8Array[] = [];
      const carrier = {
        sendToPeer: (_peerId: string, frame: Uint8Array) => {
          frames.push(frame);
          return true;
        },
      } as unknown as HubConnection;
      const firstAttempt = new PeerSession('11'.repeat(16), '33'.repeat(16), carrier);
      const secondAttempt = new PeerSession('11'.repeat(16), '44'.repeat(16), carrier);
      const proposal = encodePeerAppMessage({
        type: 'session_proposal',
        proposer_amount: '1000',
        responder_amount: '1000',
        network: storageRepository.query('network'),
      });
      act(() => {
        firstAttempt.sendMessage(1, proposal);
        secondAttempt.sendMessage(1, proposal);
      });
      await act(async () => {
        mockHub!.emit({
          type: 'peer-message',
          fromId: '22'.repeat(16),
          fromAlias: 'Clyde',
          payload: frames[0],
        });
        await storageRepository.inspect();
      });
      await waitForText(renderer!, 'New Session');
      let releaseCheckpoint = () => {};
      if (accepting) {
        let checkpointCommitted!: () => void;
        const reachedCheckpoint = new Promise<void>((resolve) => {
          checkpointCommitted = resolve;
        });
        const checkpointGate = new Promise<void>((resolve) => {
          releaseCheckpoint = resolve;
        });
        storageRepository.holdNextCheckpointAfterCommitForTests(
          checkpointGate,
          checkpointCommitted,
        );
        await act(async () => {
          renderer!.root.findByProps({ children: 'Accept' }).props.onClick();
          await reachedCheckpoint;
        });
      }
      expectConsoleError('[Shell] invalid provisional reliable session');
      await act(async () => {
        mockHub!.emit({
          type: 'peer-message',
          fromId: '22'.repeat(16),
          fromAlias: 'Clyde',
          payload: frames[1],
        });
        releaseCheckpoint();
        await storageRepository.inspect();
      });
      expect(renderer!.root.findAllByProps({ children: 'Accept' })).toHaveLength(0);
      await waitForText(renderer!, 'Resolved Clean');
      // Cancellation keeps the lobby busy until the pending checkpoint drains.
      for (let attempt = 0; attempt < 30 && mockHub!.getPresence().busy; attempt++) {
        await flushEffects();
      }
      expect(mockHub!.getPresence().busy).toBe(false);
      expect(storageRepository.loadState().session).toBeNull();
      await act(async () => {
        mockHub!.emit({
          type: 'peer-message',
          fromId: '22'.repeat(16),
          fromAlias: 'Clyde',
          payload: frames[1],
        });
        await storageRepository.inspect();
      });
      await waitForText(renderer!, 'New Session');
      expect(storageRepository.loadState().session).toMatchObject({
        phase: 'pre-handshake',
        pairing: { gameSessionId: '44'.repeat(16) },
      });
      await act(async () => {
        firstAttempt.destroy();
        secondAttempt.destroy();
        await storageRepository.inspect();
      });
    },
  );

  it.each(['cancel', 'failure'] as const)(
    'keeps a restored session when wallet reconnect ends in %s',
    async (outcome) => {
      await storageRepository.claimApplicationState();
      const save = activeSave({
        blockchainType: 'walletconnect',
        pairingToken: 'survives-wallet-setup',
      });
      await storageRepository.write(storageRepository.patchApplicationState(() => save));
      markSavedSession();
      releaseLeaseIfOwner();
      storageRepository._resetForTests();
      jest.spyOn(realBlockchainInfo, 'disconnect').mockResolvedValue();
      const application = createApplication();
      act(() => {
        renderer = create(React.createElement(Shell, { application }));
        stop = application.start();
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await application.dispatch({ type: 'resume' });
      });
      await flushEffects();
      const controller = jest.mocked(sessionHost.createSessionController).mock.results[0].value;
      const session = application.snapshot().sessionPresentation;
      expect(session).not.toBeNull();
      await act(async () => {
        await application.dispatch({ type: 'wallet-disconnect' });
      });
      if (outcome === 'failure') {
        jest
          .mocked(realBlockchainInfo.beginConnect)
          .mockRejectedValueOnce(new Error('reconnect failed'));
        expectConsoleError('reconnect failed');
      } else {
        jest.mocked(realBlockchainInfo.beginConnect).mockResolvedValueOnce({
          skipQr: true,
          fields: [{ key: 'wallet', label: 'Wallet', type: 'text' }],
          finalize: jest.fn(),
        } as any);
      }
      await act(async () => {
        await application.dispatch({ type: 'wallet-connect', wallet: 'walletconnect' });
        if (outcome === 'cancel') await application.dispatch({ type: 'wallet-cancel' });
      });
      await flushEffects();
      expect(controller.cleanup).not.toHaveBeenCalled();
      expect(sessionHost.createSessionController).toHaveBeenCalledTimes(1);
      expect(application.snapshot().sessionPresentation).toBe(session);
      expect(storageRepository.loadState().session).toEqual(save.session);
    },
  );

  it('retires the live protocol owner before starting destructive storage reset', async () => {
    await storageRepository.claimApplicationState();
    await storageRepository.write(
      storageRepository.patchApplicationState(() =>
        activeSave({
          blockchainType: 'walletconnect',
        }),
      ),
    );
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const order: string[] = [];
    const controller = jest.mocked(sessionHost.createSessionController).getMockImplementation()!();
    jest.mocked(controller.cleanup).mockImplementation(() => {
      order.push('controller');
    });
    const hardReset = jest.spyOn(storageRepository, 'hardReset').mockImplementation(async () => {
      order.push('storage');
      return { success: true };
    });

    const application = createApplication();
    act(() => {
      renderer = create(React.createElement(Shell, { application }));
      stop = application.start();
    });
    await waitForText(renderer!, 'You have previously saved state.');
    await act(async () => {
      await application.dispatch({ type: 'resume' });
    });
    await flushEffects();
    await act(async () => {
      await application.dispatch({ type: 'reset' });
    });

    expect(controller.cleanup).toHaveBeenCalledTimes(1);
    expect(hardReset).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['controller', 'storage']);
  });
});
