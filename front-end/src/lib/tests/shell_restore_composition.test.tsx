import 'fake-indexeddb/auto';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import Shell from '../../components/Shell';
import { realBlockchainInfo } from '../../hooks/RealBlockchainInterface';
import { storageRepository } from '../session/storageRepository';
import { markSavedSession, releaseLeaseIfOwner } from '../../hooks/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../../hooks/saveHardReset';
import { SESSION_DB_NAME } from '../session/indexedDb';
import { TERMINAL_INSTANCE, baseSave } from './session_save_envelope.fixtures';
import { storageRepository } from '../session/storageRepository';

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
  let reload: jest.Mock;
  let requestTrust: jest.Mock;
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage(),
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: storage(),
    });
    reload = jest.fn();
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
        location: { reload },
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
    });
    await storageRepository.checkpointApplicationState(save);
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
      renderer!.root.findByProps({ 'data-testid': 'finished-session-fallback' }),
    ).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Settled cleanly' })).toBeDefined();
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

  it('surfaces malformed aggregate evidence and completes Shell hard reset', async () => {
    await storageRepository.claimApplicationState();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('application-state', 'readwrite');
      transaction.objectStore('application-state').put({ malformed: true }, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    act(() => {
      renderer = create(React.createElement(Shell));
    });
    await waitForText(renderer!, 'Stored application state is malformed');

    await act(async () => {
      await renderer!.root.findByProps({ children: 'Retry Hard Reset' }).props.onClick();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    const databases = await (
      indexedDB as IDBFactory & { databases: () => Promise<Array<{ name?: string }>> }
    ).databases();
    expect(databases.map((database) => database.name)).not.toContain(SESSION_DB_NAME);
    expect(unhandledRejections).toEqual([]);
  });
});
