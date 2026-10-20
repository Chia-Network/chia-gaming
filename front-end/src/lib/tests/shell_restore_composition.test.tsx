import 'fake-indexeddb/auto';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import Shell from '../../components/Shell';
import * as blobSingleton from '../../hooks/blobSingleton';
import { realBlockchainInfo } from '../../hooks/RealBlockchainInterface';
import { storageRepository } from '../session/storageRepository';
import { markSavedSession, releaseLeaseIfOwner } from '../../hooks/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../../hooks/saveHardReset';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { TERMINAL_INSTANCE, baseSave } from './session_save_envelope.fixtures';
import { calpokerStateCodec } from './game_state_helpers';

import type { HubConnection } from '../../services/HubConnection';
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
        sendToPeer: jest.fn(() => true),
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
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
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
