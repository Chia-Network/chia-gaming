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
import { PeerSession, encodePeerAppMessage } from '../../services/PeerSession';
import { expectConsoleError } from '../../../scripts/testSetup';

let mockHubCallbacks: ConstructorParameters<typeof HubConnection>[2] | null = null;
const mockSendToPeer = jest.fn(() => true);
jest.mock('../../services/HubConnection', () => {
  const actual = jest.requireActual('../../services/HubConnection');
  return {
    ...actual,
    HubConnection: jest.fn((_origin, _sessionId, callbacks) => {
      mockHubCallbacks = callbacks;
      return {
        disconnect: jest.fn(),
        setBusy: jest.fn(),
        getPlayerId: () => '11'.repeat(16),
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
    mockHubCallbacks = null;
    mockSendToPeer.mockClear();
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
      await flushEffects();
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
