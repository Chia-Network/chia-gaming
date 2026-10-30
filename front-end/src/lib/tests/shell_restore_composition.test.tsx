import 'fake-indexeddb/auto';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import Shell from '../../components/Shell';
import * as wasmInit from '../../hooks/WasmStateInit';
import * as blobSingleton from '../../hooks/blobSingleton';
import { realBlockchainInfo } from '../../hooks/RealBlockchainInterface';
import { storageRepository } from '../session/storageRepository';
import { markSavedSession, releaseLeaseIfOwner } from '../../hooks/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../../hooks/saveHardReset';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { TERMINAL_INSTANCE, baseSave } from './session_save_envelope.fixtures';
import { calpokerStateCodec } from './game_state_helpers';

import type { HubConnection } from '../../services/HubConnection';
import { PeerSession, decodeReliableFrame, encodePeerAppMessage } from '../../services/PeerSession';
import { SessionController } from '../../hooks/SessionController';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { GameSessionProps } from '../../components/GameSession';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';

jest.mock('../../components/GameSession', () => {
  const actual = jest.requireActual('../../components/GameSession');
  return {
    ...actual,
    __esModule: true,
    default: function MockRestoredHandshake({ onSessionModelChange }: GameSessionProps) {
      const React = jest.requireActual<typeof import('react')>('react');
      React.useEffect(() => {
        onSessionModelChange?.(
          createSessionModel({
            channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Handshaking' } },
          }),
        );
      }, [onSessionModelChange]);
      return null;
    },
  };
});

let mockHubCallbacks: ConstructorParameters<typeof HubConnection>[2] | null = null;
const mockSetBusy = jest.fn();
const mockSendToPeer = jest.fn((_peerId: string, _frame: Uint8Array) => true);
jest.mock('../../services/HubConnection', () => {
  const actual = jest.requireActual('../../services/HubConnection');
  return {
    ...actual,
    HubConnection: jest.fn((_origin, _sessionId, callbacks) => {
      mockHubCallbacks = callbacks;
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

  beforeEach(async () => {
    mockHubCallbacks = null;
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
      act(() => renderer?.unmount());
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
      renderer = create(React.createElement(Shell));
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
        renderer = create(React.createElement(Shell));
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });
      for (let n = 0; n < 30 && !mockHubCallbacks; n++) await flushEffects();
      await flushEffects();
      expect(mockHubCallbacks).not.toBeNull();
      expect(mockHubCallbacks!.getPresence()).toEqual(presence);
      mockSetBusy.mockClear();
      act(() => {
        mockHubCallbacks!.onRegistered('p_' + '11'.repeat(16));
      });
      expect(mockSetBusy).toHaveBeenLastCalledWith(presence);
    },
  );

  it('keeps automatic wallet recovery quiet and makes terminal connection loss actionable', async () => {
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
    let connectionChanged!: (connected: boolean, recovering?: boolean) => void;
    jest.mocked(realBlockchainInfo.onConnectionChange).mockImplementation((cb) => {
      connectionChanged = cb;
      return () => {};
    });
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
      sessionPeerId: 'p_' + '22'.repeat(16),
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    act(() => {
      renderer = create(React.createElement(Shell));
    });
    await waitForText(renderer!, 'You have previously saved state.');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    for (let n = 0; n < 30 && !mockHubCallbacks; n++) await flushEffects();
    await flushEffects();
    const walletTab = () => renderer!.root.findByProps({ 'aria-label': 'Wallet, connected' });
    expect(walletTab()).toBeDefined();
    act(() => connectionChanged(false, true));
    expect(walletTab()).toBeDefined();
    expect(storageRepository.query('walletAlert')).toBe(false);
    expect(mockSetBusy).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    act(() => walletTab().props.onClick());
    await waitForText(renderer!, 'Connected');
    expect(renderer!.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
    act(() => connectionChanged(true, false));
    expect(walletTab()).toBeDefined();
    expect(storageRepository.query('walletAlert')).toBe(false);
    // Failure of automatic recovery, including session deletion, is actionable.
    act(() => renderer!.root.findByProps({ 'aria-label': 'Hub, disconnected' }).props.onClick());
    act(() => connectionChanged(false, true));
    act(() => connectionChanged(false, false));
    expect(storageRepository.query('walletAlert')).toBe(true);
    const lostTab = renderer!.root.findByProps({ 'aria-label': 'Wallet, disconnected' });
    act(() => lostTab.props.onClick());
    await waitForText(renderer!, 'Connection was lost');
    expect(renderer!.root.findAllByProps({ children: 'Reconnect' }).length).toBeGreaterThan(0);
  });

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
      renderer = create(React.createElement(Shell));
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
    for (let n = 0; n < 30 && !mockHubCallbacks; n++) await flushEffects();
    act(() => {
      mockHubCallbacks!.onRegistered('p_' + '11'.repeat(16));
      mockHubCallbacks!.onPeerUnavailable('p_' + '22'.repeat(16));
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
        renderer = create(React.createElement(Shell));
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });
      await waitForText(renderer!, 'Resolved Clean');
      for (let n = 0; n < 30 && !mockHubCallbacks; n++) await flushEffects();
      expect(mockHubCallbacks).not.toBeNull();
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
        mockHubCallbacks!.onPeerMessage('22'.repeat(16), 'Clyde', frames[0]);
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
        mockHubCallbacks!.onPeerMessage('22'.repeat(16), 'Clyde', frames[1]);
        releaseCheckpoint();
        await storageRepository.inspect();
      });
      expect(renderer!.root.findAllByProps({ children: 'Accept' })).toHaveLength(0);
      await waitForText(renderer!, 'Resolved Clean');
      // Cancellation keeps the lobby busy until the pending checkpoint drains.
      for (let attempt = 0; attempt < 30 && mockHubCallbacks!.getPresence().busy; attempt++) {
        await flushEffects();
      }
      expect(mockHubCallbacks!.getPresence().busy).toBe(false);
      expect(storageRepository.loadState().session).toBeNull();
      await act(async () => {
        mockHubCallbacks!.onPeerMessage('22'.repeat(16), 'Clyde', frames[1]);
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

  it.each([false, true])(
    'checkpoints a fresh proposal before sending with retained controller=%s',
    async (retainedController) => {
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
        renderer = create(React.createElement(Shell));
      });
      await waitForText(renderer!, 'You have previously saved state.');
      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });
      await waitForText(renderer!, 'Resolved Clean');
      for (let n = 0; n < 30 && !mockHubCallbacks; n++) await flushEffects();
      await flushEffects();
      expect(mockHubCallbacks).not.toBeNull();

      const oldPeer = new PeerSession('old-peer', '55'.repeat(16), {
        sendToPeer: () => true,
      } as unknown as HubConnection);
      let oldController: SessionController | null = null;
      if (retainedController) {
        oldController = new SessionController(null, 'old-controller', 100n, 100n, oldPeer);
        oldController
          .getPeerProtocol()
          .accept_session({ proposer_amount: '100', responder_amount: '100' }, false);
        oldController.restoreChannelStatus({
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'ResolvedClean',
        });
        jest.replaceProperty(blobSingleton, 'sessionController', oldController);
      }
      const oldOwner = oldController?.getPeerProtocol();
      let releaseCheckpoint!: () => void;
      const checkpointGate = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      let checkpointStarted = false;
      const write = storageRepository.write.bind(storageRepository);
      jest.spyOn(storageRepository, 'write').mockImplementation(async (snapshot) => {
        if (snapshot.session?.phase === 'pre-handshake') {
          checkpointStarted = true;
          await checkpointGate;
        }
        await write(snapshot);
      });
      mockSendToPeer.mockClear();
      try {
        act(() => {
          mockHubCallbacks!.onAdvisoryStart({
            peer_id: '22'.repeat(16),
            peer_alias: 'Clyde',
            my_amount: '1000',
            their_amount: '1000',
          });
        });
        await waitForText(renderer!, 'New Session');
        await act(async () => {
          renderer!.root.findByProps({ children: 'Accept' }).props.onClick();
        });
        // Run the automatic transport timer while the first write is still blocked.
        await flushEffects();
        expect(checkpointStarted).toBe(true);
        const pending = storageRepository.loadState().session;
        if (pending?.phase !== 'pre-handshake') throw new Error('Missing fresh checkpoint');
        const remote = new PeerSession('11'.repeat(16), pending.pairing.gameSessionId, {
          sendToPeer: (_peerId: string, frame: Uint8Array) => {
            mockHubCallbacks!.onPeerMessage('22'.repeat(16), 'Clyde', frame);
            return true;
          },
        } as unknown as HubConnection);
        act(() => {
          mockHubCallbacks!.onHubDisconnected();
          mockHubCallbacks!.onHubReconnected();
          mockHubCallbacks!.onPeerAvailable('22'.repeat(16));
          remote.sendAck(1);
          remote.sendMessage(1, Uint8Array.of(0x01));
          remote.sendKeepalive();
          remote.destroy();
        });
        await flushEffects();
        expect(mockSendToPeer).not.toHaveBeenCalled();
        expect((await storageRepository.inspect()).applicationState?.session?.phase).toBe(
          'terminal',
        );
        expect(oldController?.getPeerProtocol()).toBe(oldOwner);
        expect(blobSingleton.sessionController).toBe(oldController);

        await act(async () => {
          releaseCheckpoint();
        });
        await waitForText(renderer!, 'Handshaking');
        expect(blobSingleton.sessionController).toBeNull();
        expect(mockSendToPeer).toHaveBeenCalledTimes(1);
        const frame = decodeReliableFrame(mockSendToPeer.mock.calls[0][1]);
        const saved = (await storageRepository.inspect()).applicationState;
        expect(saved?.session?.phase).toBe('pre-handshake');
        if (saved?.session?.phase !== 'pre-handshake' || frame?.tag !== 0x01) {
          throw new Error('Fresh session did not persist and emit its proposal');
        }
        expect(frame.sessionId).toBe(saved.session.pairing.gameSessionId);
        expect(frame.sessionId).not.toBe(oldPeer.sessionId);
        expect(saved.session.transport.unackedMessages).toEqual([{ msgno: 1n, msg: frame.data }]);
        expect(unhandledRejections).toEqual([]);
      } finally {
        await act(async () => {
          releaseCheckpoint();
          oldController?.cleanup();
          oldPeer.destroy();
          await storageRepository.inspect();
        });
      }
    },
  );

  it('retires the live protocol owner before starting destructive storage reset', async () => {
    await storageRepository.claimApplicationState();
    await storageRepository.write(
      storageRepository.patchApplicationState(() =>
        baseSave({
          blockchainType: 'walletconnect',
        }),
      ),
    );
    markSavedSession();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const order: string[] = [];
    const destroyController = jest
      .spyOn(blobSingleton, 'destroySessionController')
      .mockImplementation(() => {
        order.push('controller');
      });
    const hardReset = jest.spyOn(storageRepository, 'hardReset').mockImplementation(async () => {
      order.push('storage');
      return { success: true };
    });

    act(() => {
      renderer = create(React.createElement(Shell));
    });
    await waitForText(renderer!, 'You have previously saved state.');

    await act(async () => {
      await renderer!.root.findByProps({ children: 'Start over' }).props.onClick();
    });

    expect(destroyController).toHaveBeenCalledTimes(1);
    expect(hardReset).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['controller', 'storage']);
  });
});
