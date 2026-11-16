import 'fake-indexeddb/auto';
import { useEffect, useRef } from 'react';
import { Recovery } from '../application/Recovery';

import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  type BootRecoveryBoundaryDependencies,
  type BootRestoreSource,
} from '../application/Recovery';
import {
  _encodeRawApplicationStateForTests,
  indexedDbStoragePort,
  readApplicationState,
  SESSION_DB_NAME,
} from '../session/indexedDb';
import { rehydrateDurableApplicationState } from '../session/persistence';
import { releaseLeaseIfOwner } from '../session/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../session/saveHardReset';
import { SessionController } from '../session/SessionController';
import { storageRepository } from '../session/storageRepository';
import { commitRuntime, ControlledRuntime } from './runtime_capability.harness';
import { baseSave, liveSave } from './session_save_envelope.fixtures';

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

async function waitForRender(renderer: ReactTestRenderer, text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rendered = renderer.root
      .findAllByType('p')
      .map((node) => node.children.join(''))
      .join('\n');
    if (rendered.includes(text)) return;
    await flushEffects();
  }
  throw new Error(`Timed out waiting for rendered text: ${text}`);
}

function holdNextClaim(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let claimed!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  storageRepository.holdNextClaimAfterCommitForTests(barrier, claimed);
  return { entered, release };
}

function ShellBootHarness(props: {
  externalHub: Promise<void>;
  externalWallet: Promise<void>;
  reload: () => void;
  onRestore?: (
    save: Parameters<BootRecoveryBoundaryDependencies['onRestore']>[0],
    source: BootRestoreSource,
  ) => ReturnType<BootRecoveryBoundaryDependencies['onRestore']>;
  onSessionId?: (sessionId: string) => void;
  onFreshClaim?: BootRecoveryBoundaryDependencies['onFreshClaim'];
  onAuthorityLost?: () => void;
}) {
  const [presentation, setPresentation] = useState<string | null>(null);
  const [walletReady] = useState(false);
  const [hubReady] = useState(false);
  const boundary = useBootRecoveryBoundary({
    onSessionId: props.onSessionId ?? (() => {}),
    onRestore:
      props.onRestore ??
      ((_save, source: BootRestoreSource) => {
        setPresentation(`restored-${source}`);
        // Reconnection starts, but neither promise participates in local presentation.
        void props.externalHub;
        void props.externalWallet;
      }),
    onFreshClaim: props.onFreshClaim ?? (() => {}),
    onAuthorityLost: () => {
      props.onAuthorityLost?.();
      setPresentation(null);
    },
    beforeHardReset: () => {},
    reload: props.reload,
  });

  if (boundary.state.kind === 'loading') {
    return createElement('p', null, 'Loading Chia Gaming…');
  }
  if (boundary.state.kind === 'resumeDialog') {
    return createElement(
      'section',
      null,
      createElement('p', null, boundary.state.loadError ?? 'You have previously saved state.'),
      boundary.state.loadError === null
        ? createElement('button', { onClick: boundary.resume }, 'Resume Session')
        : null,
      createElement('button', { onClick: boundary.retryHardReset }, 'Retry Hard Reset'),
    );
  }
  if (boundary.state.kind === 'tabConflict') {
    return createElement(
      'section',
      null,
      createElement('p', null, 'Tab conflict'),
      createElement('button', { onClick: boundary.takeOver }, 'Take over'),
    );
  }
  return createElement(
    'main',
    null,
    createElement('p', null, presentation ?? 'Fresh dashboard'),
    createElement('p', null, hubReady ? 'Hub connected' : 'Hub reconnecting'),
    createElement('p', null, walletReady ? 'Wallet connected' : 'Wallet reconnecting'),
    createElement('button', { disabled: !walletReady }, 'Wallet action'),
    createElement('button', { disabled: !hubReady }, 'Hub action'),
  );
}

describe('BootRecoveryBoundary composed Shell recovery', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(async () => {
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage(),
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: storage(),
    });
    await deleteSessionDatabase();
  });

  afterEach(async () => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = null;
    }
    storageRepository._resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();
  });

  it('finishes a pending wipe before automatic inspection, claim, identity, or restore', async () => {
    const originalIndexedDb = indexedDB;
    localStorage.setItem('appState_pendingWipe', '1');
    localStorage.setItem('appState_savedSession', '1');
    sessionStorage.setItem('appState_autoResumeOnce', '1');
    const deletes: Array<{ onsuccess?: () => void }> = [];
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        databases: jest.fn().mockResolvedValue([{ name: SESSION_DB_NAME }]),
        deleteDatabase: jest.fn(() => {
          const request: { onsuccess?: () => void } = {};
          deletes.push(request);
          return request;
        }),
      },
    });
    const inspect = jest.spyOn(storageRepository, 'inspect');
    const claim = jest.spyOn(storageRepository, 'claimAndRead');
    const onSessionId = jest.fn();
    const onRestore = jest.fn();
    const onFreshClaim = jest.fn();

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onSessionId,
          onRestore,
          onFreshClaim,
        }),
      );
    });
    await flushEffects();

    expect(renderer!.root.findByProps({ children: 'Loading Chia Gaming…' })).toBeDefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(onSessionId).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb,
    });
    for (const request of deletes) request.onsuccess?.();
    await waitForRender(renderer!, 'Fresh dashboard');

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onFreshClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        session: null,
        channelFundingOperations: [],
        feeAttachments: [],
        rejectionTransports: [],
      }),
      'boot',
    );
    expect(onRestore).not.toHaveBeenCalled();
    expect(localStorage.getItem('appState_savedSession')).toBeNull();
    inspect.mockRestore();
    claim.mockRestore();
  });

  it('keeps a blocked pending wipe on recovery UI without inspecting or claiming', async () => {
    const originalIndexedDb = indexedDB;
    localStorage.setItem('appState_pendingWipe', '1');
    const deletes: Array<{ onblocked?: () => void }> = [];
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        databases: jest.fn().mockResolvedValue([{ name: SESSION_DB_NAME }]),
        deleteDatabase: jest.fn(() => {
          const request: { onblocked?: () => void } = {};
          deletes.push(request);
          return request;
        }),
      },
    });
    const inspect = jest.spyOn(storageRepository, 'inspect');
    const claim = jest.spyOn(storageRepository, 'claimAndRead');

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
        }),
      );
    });
    await flushEffects();
    for (const request of deletes) request.onblocked?.();
    await waitForRender(renderer!, 'pending hard reset is still blocked');

    expect(inspect).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb,
    });
    inspect.mockRestore();
    claim.mockRestore();
  });

  it('shows local loading then restores while hub and wallet remain unresolved', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      blockchainType: 'walletconnect',
      pairingToken: 'restore-pair',
      serializedGameSession: new Uint8Array([1, 2, 3]),
    });
    if (save.session?.phase !== 'live') throw new Error('expected live save');
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const hub = new Promise<void>(() => {});
    const wallet = new Promise<void>(() => {});
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: hub,
          externalWallet: wallet,
          reload: jest.fn(),
        }),
      );
    });
    expect(renderer!.toJSON()).toEqual(
      expect.objectContaining({ children: ['Loading Chia Gaming…'] }),
    );

    await waitForRender(renderer!, 'You have previously saved state.');

    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });

    expect(renderer!.root.findByType('main').children).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'restored-manual' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Hub reconnecting' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Wallet reconnecting' })).toBeDefined();
    expect(renderer!.root.findByProps({ children: 'Wallet action' }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ children: 'Hub action' }).props.disabled).toBe(true);
  });

  it('offers and restores a durable live session without localStorage hints', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      pairingToken: 'markerless-restore-pair',
      serializedGameSession: new Uint8Array([9, 8, 7]),
    });
    if (save.session?.phase !== 'live') throw new Error('expected live save');
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    localStorage.clear();

    const onRestore = jest.fn();
    const claim = jest.spyOn(storageRepository, 'claimAndRead');
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
        }),
      );
    });

    await waitForRender(renderer!, 'You have previously saved state.');
    expect(claim).not.toHaveBeenCalled();
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });

    expect(claim).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          phase: 'live',
          pairing: expect.objectContaining({ token: 'markerless-restore-pair' }),
        }),
      }),
      'manual',
    );
    claim.mockRestore();
  });

  it('routes an unsupported cradle restore to hard-reset recovery without changing the root', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      sessionId: 'stable-restore-session',
      pairingToken: 'unsupported-cradle-pair',
      serializedGameSession: new Uint8Array([9, 8, 7]),
      gameSessionSchemaVersion: 3n,
      diagnosticLog: ['preserve restore evidence'],
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();
    localStorage.clear();
    const onRestore = jest.fn(async () => {
      throw new Error('Unsupported saved game format: cradle schema 3; current schema is 4');
    });

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
        }),
      );
    });

    await waitForRender(renderer!, 'You have previously saved state.');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    await waitForRender(renderer!, 'Unsupported saved game format');

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByProps({ children: 'Resume Session' })).toHaveLength(0);
    expect(renderer!.root.findByProps({ children: 'Retry Hard Reset' })).toBeDefined();
    expect(await readApplicationState()).toEqual(save);
    expect(storageRepository.loadState()).toEqual(save);
  });

  it('preserves malformed aggregate evidence and offers hard reset recovery', async () => {
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
    localStorage.setItem('appState_savedSession', '1');
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const claim = jest.spyOn(storageRepository, 'claimAndRead');
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
        }),
      );
    });

    await waitForRender(renderer!, 'Stored application state is malformed');
    expect(claim).not.toHaveBeenCalled();
    await expect(readApplicationState()).rejects.toThrow('Stored application state is malformed');
    expect(localStorage.getItem('appState_savedSession')).toBe('1');
    claim.mockRestore();
  });

  it.each([
    ['session', (state: any) => (state.session = { phase: 'live' })],
    ['wallet', (state: any) => (state.channelFundingOperations = [{}])],
    ['rejection', (state: any) => (state.rejectionTransports = [{}])],
  ])(
    'uses the same hard-reset UI for malformed %s state without changing disk',
    async (_part, corrupt) => {
      await storageRepository.claimApplicationState();
      const malformed: any = structuredClone(baseSave({ playerId: 'corrupt-root' }));
      corrupt(malformed);
      const raw = _encodeRawApplicationStateForTests(malformed);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(SESSION_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('application-state', 'readwrite');
        transaction.objectStore('application-state').put(raw, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      releaseLeaseIfOwner();
      storageRepository._resetForTests();

      act(() => {
        renderer = create(
          createElement(ShellBootHarness, {
            externalHub: new Promise<void>(() => {}),
            externalWallet: new Promise<void>(() => {}),
            reload: jest.fn(),
          }),
        );
      });
      await waitForRender(renderer!, 'Stored application state is malformed');

      const verify = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(SESSION_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stored = await new Promise<Uint8Array>((resolve, reject) => {
        const transaction = verify.transaction('application-state', 'readonly');
        const request = transaction.objectStore('application-state').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      verify.close();
      expect(stored).toEqual(raw);
    },
  );

  it.each([
    [
      'live',
      () =>
        liveSave({
          sessionId: 'race-live-hub-session',
          pairingToken: 'race-live-pair',
          serializedGameSession: new Uint8Array([6, 5, 4]),
        }),
    ],
    [
      'terminal',
      () =>
        baseSave({
          sessionId: 'race-terminal-hub-session',
          channelStatus: { state: 'ResolvedClean' },
          coinsOfInterest: [],
        }),
    ],
  ])(
    'recovers a %s session committed between inspection and atomic claim without a second claim',
    async (_label, makeSave) => {
      const racingSave = makeSave();
      const originalInspect = storageRepository.inspect.bind(storageRepository);
      const inspect = jest.spyOn(storageRepository, 'inspect').mockImplementationOnce(async () => {
        const inspected = await originalInspect();
        const racingClaim = await indexedDbStoragePort.claimAndRead('racing-tab');
        await indexedDbStoragePort.writeApplicationState(racingSave, racingClaim.authority);
        return inspected;
      });
      const claim = jest.spyOn(storageRepository, 'claimAndRead');
      const onFreshClaim = jest.fn();
      const onRestore = jest.fn();

      act(() => {
        renderer = create(
          createElement(ShellBootHarness, {
            externalHub: new Promise<void>(() => {}),
            externalWallet: new Promise<void>(() => {}),
            reload: jest.fn(),
            onFreshClaim,
            onRestore,
          }),
        );
      });

      await waitForRender(renderer!, 'You have previously saved state.');
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(onFreshClaim).not.toHaveBeenCalled();

      await act(async () => {
        await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      });

      expect(claim).toHaveBeenCalledTimes(1);
      expect(onFreshClaim).not.toHaveBeenCalled();
      expect(onRestore).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ phase: racingSave.session?.phase }),
        }),
        'manual',
      );
      inspect.mockRestore();
      claim.mockRestore();
    },
  );

  it('treats a save cleared between resume inspection and claim as a fresh claim', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      pairingToken: 'cleared-before-resume-claim',
      serializedGameSession: new Uint8Array([3, 2, 1]),
    });
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const originalInspect = storageRepository.inspect.bind(storageRepository);
    let inspectionCount = 0;
    const inspect = jest.spyOn(storageRepository, 'inspect').mockImplementation(async () => {
      const inspected = await originalInspect();
      inspectionCount += 1;
      if (inspectionCount === 2) {
        const racingClaim = await indexedDbStoragePort.claimAndRead('clearing-tab');
        await indexedDbStoragePort.writeApplicationState(baseSave(), racingClaim.authority);
      }
      return inspected;
    });
    const onSessionId = jest.fn();
    const onFreshClaim = jest.fn();
    const onRestore = jest.fn();

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onSessionId,
          onFreshClaim,
          onRestore,
        }),
      );
    });

    await waitForRender(renderer!, 'You have previously saved state.');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
    });
    await waitForRender(renderer!, 'Fresh dashboard');

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onFreshClaim).toHaveBeenCalledWith(expect.objectContaining({ session: null }), 'boot');
    expect(onRestore).not.toHaveBeenCalled();
    inspect.mockRestore();
  });

  it('hard-resets preserved malformed aggregate evidence on explicit retry', async () => {
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

    const reload = jest.fn();
    const claim = jest.spyOn(storageRepository, 'claimAndRead');
    const beginHardReset = jest.spyOn(indexedDbStoragePort, 'beginHardReset');
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload,
        }),
      );
    });
    await waitForRender(renderer!, 'Stored application state is malformed');
    expect(claim).not.toHaveBeenCalled();
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Retry Hard Reset' }).props.onClick();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beginHardReset).not.toHaveBeenCalled();
    claim.mockRestore();
    beginHardReset.mockRestore();
  });

  it('flushes pre-authority identity changes only after the atomic claim', async () => {
    storageRepository.updatePreference({ key: 'alias', value: 'Buffered Alice' });

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
        }),
      );
    });
    await waitForRender(renderer!, 'Fresh dashboard');
    expect(renderer!.root.findByProps({ children: 'Fresh dashboard' })).toBeDefined();
    await storageRepository.checkpointDomainMutations();
  });

  it('kills the old controller and rehydrates the durable live root after takeover', async () => {
    const durableLive = liveSave({
      pairingToken: 'terminal-owner-death-pair',
      serializedGameSession: new Uint8Array([5, 4, 3]),
    });
    const oldController = new SessionController(null, 'old-owner', 100n, 100n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const oldRuntime = new ControlledRuntime();
    commitRuntime(oldController, oldRuntime);
    const onRestore = jest.fn((save) => {
      const bootstrap = rehydrateDurableApplicationState(save);
      expect(bootstrap.state.session?.phase).toBe('live');
      expect(
        bootstrap.state.session?.phase === 'live' &&
          bootstrap.state.session.live.serializedGameSession,
      ).toEqual(new Uint8Array([5, 4, 3]));
    });

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
          onAuthorityLost: () => oldController.cleanup(),
        }),
      );
    });
    await waitForRender(renderer!, 'Fresh dashboard');
    await storageRepository.write(storageRepository.patchApplicationState(() => durableLive));

    act(() => storageRepository.loseAuthority('takeover'));
    await waitForRender(renderer!, 'Tab conflict');
    expect(oldController.executionActive).toBe(false);

    await act(async () => {
      await renderer!.root.findByProps({ children: 'Take over' }).props.onClick();
    });

    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('purges with a waiting sibling and takes over the new state written after the owner reloads', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const sharedStorage = localStorage;
    const intervals: ReturnType<typeof setInterval>[] = [];
    const realSetInterval = setInterval;
    const intervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation((handler, ms) => {
      const timer = realSetInterval(handler, ms);
      intervals.push(timer);
      return timer;
    });
    type Tab = {
      repository: typeof storageRepository;
      recovery: Recovery;
      session: Storage;
      listeners: Array<(event: StorageEvent) => void>;
      restored: jest.Mock;
      lostAuthority: jest.Mock;
      reload: jest.Mock;
    };
    const tabs = new Set<Tab>();
    let active: Tab | undefined;
    const events: Array<{ recipients: Tab[]; event: StorageEvent }> = [];
    const setItem = sharedStorage.setItem.bind(sharedStorage);
    const storageWrite = jest.spyOn(sharedStorage, 'setItem').mockImplementation((key, value) => {
      const oldValue = sharedStorage.getItem(key);
      setItem(key, value);
      if (oldValue !== String(value)) {
        events.push({
          recipients: [...tabs].filter((tab) => tab !== active),
          event: { key, oldValue, newValue: String(value) } as StorageEvent,
        });
      }
    });
    const activate = (tab: Tab) => {
      active = tab;
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: tab.session,
      });
    };
    const deliverEvents = () => {
      for (const { recipients, event } of events.splice(0)) {
        for (const tab of recipients) {
          if (tabs.has(tab)) for (const listener of tab.listeners) listener(event);
        }
      }
    };
    const createTab = async (id: string): Promise<Tab> => {
      const session = storage();
      session.setItem('appState_tabId', id);
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
      const listeners: Tab['listeners'] = [];
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
            if (type === 'storage') listeners.push(listener);
          },
        },
      });
      let repository!: typeof storageRepository;
      let RecoveryClass!: typeof Recovery;
      await jest.isolateModulesAsync(async () => {
        repository = (await import('../session/storageRepository')).storageRepository;
        RecoveryClass = (await import('../application/Recovery')).Recovery;
      });
      const restored = jest.fn();
      const lostAuthority = jest.fn();
      const reload = jest.fn();
      const recovery = new RecoveryClass(
        {
          onSessionId: jest.fn(),
          onRestore: restored,
          onFreshClaim: jest.fn(),
          onAuthorityLost: lostAuthority,
          beforeHardReset: jest.fn(),
          reload,
        },
        jest.fn(),
      );
      const tab = { repository, recovery, session, listeners, restored, lostAuthority, reload };
      tabs.add(tab);
      activate(tab);
      return tab;
    };
    let stopWaiting: (() => void) | undefined;
    try {
      const owner = await createTab('owner-before-purge');
      await owner.repository.claimApplicationState();
      const oldSave = liveSave({
        playerId: 'before-purge',
        alias: 'Old alias',
        pairingToken: 'old-pair',
        serializedGameSession: new Uint8Array([1, 2, 3]),
      });
      await owner.repository.write(owner.repository.patchApplicationState(() => oldSave));

      const waiting = await createTab('waiting-sibling');
      stopWaiting = waiting.recovery.start();
      for (let turn = 0; turn < 30 && waiting.recovery.view.state.kind === 'loading'; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(waiting.recovery.view.state.kind).toBe('resumeDialog');
      await waiting.recovery.resume();
      expect(waiting.recovery.view.state).toMatchObject({ kind: 'tabConflict', save: oldSave });
      expect(waiting.repository.hasAuthority()).toBe(false);

      activate(owner);
      await owner.recovery.retryHardReset();
      expect(owner.reload).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
      expect(await readApplicationState()).toBeNull();
      deliverEvents();
      expect(waiting.lostAuthority).toHaveBeenCalledTimes(1);
      expect(waiting.recovery.view.state.kind).toBe('tabConflict');
      expect(waiting.repository.loadState().session).toBeNull();

      tabs.delete(owner);
      const continued = await createTab('owner-after-reload');
      await continued.repository.claimApplicationState();
      const newSave = liveSave({
        playerId: 'after-purge',
        sessionId: 'post-purge-hub',
        alias: 'New alias',
        pairingToken: 'new-pair',
        serializedGameSession: new Uint8Array([9, 8, 7]),
      });
      await continued.repository.write(continued.repository.patchApplicationState(() => newSave));
      await continued.repository.updatePreference({ key: 'alias', value: 'Latest alias' });
      await continued.repository.checkpointDomainMutations();
      const latest = continued.repository.loadState();
      deliverEvents();

      activate(waiting);
      await waiting.recovery.takeOver();
      expect(waiting.recovery.view.state.kind).toBe('ready');
      expect(waiting.restored).toHaveBeenCalledTimes(1);
      expect(waiting.restored).toHaveBeenCalledWith(latest, 'takeover');
      expect(waiting.repository.loadState()).toEqual(latest);
      expect(await readApplicationState()).toEqual(latest);
      await expect(continued.repository.write(newSave)).rejects.toMatchObject({
        code: 'STORAGE_AUTHORITY_LOST',
      });
      expect(await readApplicationState()).toEqual(latest);
    } finally {
      stopWaiting?.();
      storageWrite.mockRestore();
      for (const timer of intervals) clearInterval(timer);
      intervalSpy.mockRestore();
      for (const tab of tabs) tab.repository._resetForTests();
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('suppresses fresh-claim callbacks when authority is lost before snapshot delivery', async () => {
    const claim = holdNextClaim();
    const onSessionId = jest.fn();
    const onFreshClaim = jest.fn();
    const onRestore = jest.fn();

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
          onSessionId,
          onFreshClaim,
        }),
      );
    });
    await act(async () => {
      await claim.entered;
    });

    act(() => storageRepository.loseAuthority('takeover'));
    claim.release();
    await waitForRender(renderer!, 'Tab conflict');

    expect(onSessionId).not.toHaveBeenCalled();
    expect(onFreshClaim).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('suppresses takeover callbacks when authority is lost before snapshot delivery', async () => {
    localStorage.setItem('appState_activeTab', 'other-tab');
    const onSessionId = jest.fn();
    const onFreshClaim = jest.fn();
    const onRestore = jest.fn();

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
          onSessionId,
          onFreshClaim,
        }),
      );
    });
    await waitForRender(renderer!, 'Tab conflict');

    const claim = holdNextClaim();
    let takeover!: Promise<void>;
    await act(async () => {
      takeover = renderer!.root.findByProps({ children: 'Take over' }).props.onClick();
      await claim.entered;
    });
    act(() => storageRepository.loseAuthority('takeover'));
    claim.release();
    await act(async () => {
      await takeover;
    });

    expect(renderer!.root.findByProps({ children: 'Tab conflict' })).toBeDefined();
    expect(onSessionId).not.toHaveBeenCalled();
    expect(onFreshClaim).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('suppresses identity and restore callbacks when a resume claim becomes stale', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      pairingToken: 'stale-resume-pair',
      serializedGameSession: new Uint8Array([7, 8, 9]),
    });
    if (save.session?.phase !== 'live') throw new Error('expected live save');
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    const onSessionId = jest.fn();
    const onFreshClaim = jest.fn();
    const onRestore = jest.fn();
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
          onSessionId,
          onFreshClaim,
        }),
      );
    });
    await waitForRender(renderer!, 'You have previously saved state.');

    const claim = holdNextClaim();
    let resume!: Promise<void>;
    await act(async () => {
      resume = renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      await claim.entered;
    });
    act(() => storageRepository.loseAuthority('takeover'));
    claim.release();
    await act(async () => {
      await resume;
    });

    expect(renderer!.root.findByProps({ children: 'Tab conflict' })).toBeDefined();
    expect(onSessionId).not.toHaveBeenCalled();
    expect(onFreshClaim).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('does not finish an in-flight restore after storage authority is lost', async () => {
    await storageRepository.claimApplicationState();
    const save = liveSave({
      pairingToken: 'authority-loss-pair',
      serializedGameSession: new Uint8Array([4, 5, 6]),
    });
    if (save.session?.phase !== 'live') throw new Error('expected live save');
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    let releaseRestore!: () => void;
    let restoreStarted!: () => void;
    const restoreBarrier = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const restoreEntered = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    const onSessionId = jest.fn();
    const onFreshClaim = jest.fn();
    const onRestore = jest.fn(async () => {
      restoreStarted();
      await restoreBarrier;
    });

    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload: jest.fn(),
          onRestore,
          onSessionId,
          onFreshClaim,
        }),
      );
    });
    await waitForRender(renderer!, 'You have previously saved state.');

    let resume!: Promise<void>;
    await act(async () => {
      resume = renderer!.root.findByProps({ children: 'Resume Session' }).props.onClick();
      await restoreEntered;
    });
    act(() => storageRepository.loseAuthority('takeover'));
    expect(renderer!.root.findByProps({ children: 'Tab conflict' })).toBeDefined();

    releaseRestore();
    await act(async () => {
      await resume;
    });

    expect(renderer!.root.findByProps({ children: 'Tab conflict' })).toBeDefined();
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onFreshClaim).not.toHaveBeenCalled();
  });
});

function useBootRecoveryBoundary(dependencies: BootRecoveryBoundaryDependencies) {
  const [view, setView] = useState<RecoveryView>({
    state: { kind: 'loading' },
    resuming: false,
    startingOver: false,
  });
  const owner = useRef<Recovery | null>(null);
  if (!owner.current) owner.current = new Recovery(dependencies, setView);
  const recovery = owner.current;
  recovery.dependencies = dependencies;
  useEffect(() => recovery.start(), [recovery]);
  return {
    ...view,
    resume: recovery.resume,
    takeOver: recovery.takeOver,
    closeTab: recovery.closeTab,
    retryHardReset: recovery.retryHardReset,
    revealReady: recovery.revealReady,
  };
}
