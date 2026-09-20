import 'fake-indexeddb/auto';

import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  useBootRecoveryBoundary,
  type BootRecoveryBoundaryDependencies,
  type BootRestoreSource,
} from '../../components/BootRecoveryBoundary';
import {
  _resetForTests,
  claimLease,
  flushSessionSave,
  releaseLeaseIfOwner,
  saveSession,
  setAlias,
} from '../../hooks/save';
import { loseAuthority } from '../../hooks/saveCoordination';
import { _resetPendingWalletConnectWipeForTests } from '../../hooks/saveHardReset';
import { _holdNextClaimAfterCommitForTests, SESSION_DB_NAME } from '../session/indexedDb';
import { liveSave } from './session_save_envelope.fixtures';

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
  _holdNextClaimAfterCommitForTests(barrier, claimed);
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
    onAuthorityLost: () => setPresentation(null),
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
    _resetForTests();
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
    _resetForTests();
    _resetPendingWalletConnectWipeForTests();
    await deleteSessionDatabase();
  });

  it('shows local loading then restores while hub and wallet remain unresolved', async () => {
    await claimLease();
    const save = liveSave({
      blockchainType: 'walletconnect',
      pairingToken: 'restore-pair',
      serializedGameSession: new Uint8Array([1, 2, 3]),
    });
    if (save.phase !== 'live') throw new Error('expected live save');
    await saveSession({
      scope: 'common',
      preferences: save.preferences,
    });
    await saveSession({
      scope: 'live',
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
    await flushSessionSave();
    releaseLeaseIfOwner();
    _resetForTests();

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

  it('preserves malformed wallet evidence and offers a successful hard reset retry', async () => {
    await claimLease();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('wallet-reservations', 'readwrite');
      transaction.objectStore('wallet-reservations').put({ malformed: true }, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    releaseLeaseIfOwner();
    _resetForTests();

    const reload = jest.fn();
    act(() => {
      renderer = create(
        createElement(ShellBootHarness, {
          externalHub: new Promise<void>(() => {}),
          externalWallet: new Promise<void>(() => {}),
          reload,
        }),
      );
    });
    await waitForRender(renderer!, 'Stored wallet reservation ledger is malformed');
    await act(async () => {
      await renderer!.root.findByProps({ children: 'Retry Hard Reset' }).props.onClick();
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('flushes pre-authority identity changes only after the atomic claim', async () => {
    setAlias('Buffered Alice');

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
    await flushSessionSave();
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

    act(() => loseAuthority('takeover'));
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
    act(() => loseAuthority('takeover'));
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
    await claimLease();
    const save = liveSave({
      pairingToken: 'stale-resume-pair',
      serializedGameSession: new Uint8Array([7, 8, 9]),
    });
    if (save.phase !== 'live') throw new Error('expected live save');
    await saveSession({
      scope: 'live',
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
    await flushSessionSave();
    releaseLeaseIfOwner();
    _resetForTests();

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
    act(() => loseAuthority('takeover'));
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
    await claimLease();
    const save = liveSave({
      pairingToken: 'authority-loss-pair',
      serializedGameSession: new Uint8Array([4, 5, 6]),
    });
    if (save.phase !== 'live') throw new Error('expected live save');
    await saveSession({
      scope: 'live',
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
    await flushSessionSave();
    releaseLeaseIfOwner();
    _resetForTests();

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
    act(() => loseAuthority('takeover'));
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
