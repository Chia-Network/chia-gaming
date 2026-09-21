import { indexedDbStoragePort, readApplicationState } from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import type { WalletOperationEntry } from '../session/walletOperationStore';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';
import { decodeDurableApplicationState } from '../session/persistence';
import { createSessionMachineState } from '../session/sessionMachine';
import { createSessionModel } from '../session/model';
import type { SessionController } from '../../hooks/SessionController';
import { activeSave } from './session_save_envelope.fixtures';
import './save.harness';

const entry: WalletOperationEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: { provider: 'simulator', identity: 'player' },
  },
  purpose: { kind: 'funding', operationId: 'funding' },
  stage: 'reserved',
  tradeId: 'trade',
  reason: '',
};

function withWallet(state: ReturnType<typeof activeSave>): ReturnType<typeof activeSave> {
  return {
    ...state,
    walletContext: entry.owner.providerScope,
    walletObligations: [entry],
  };
}

describe('aggregate checkpoints', () => {
  it('logs ordinary aggregate write failures with a stack', async () => {
    const failure = new Error('disk unavailable');
    const write = jest
      .spyOn(indexedDbStoragePort, 'writeApplicationState')
      .mockRejectedValueOnce(failure);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(storageRepository.checkpointApplicationState(activeSave())).rejects.toBe(failure);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toContain(
      '[error] aggregate checkpoint failed: Error: disk unavailable',
    );
    expect(consoleError.mock.calls[0][0]).toContain(failure.stack);
    write.mockRestore();
    consoleError.mockRestore();
  });

  it('writes session and wallet obligations as one application state', async () => {
    const state = withWallet(activeSave());
    await storageRepository.checkpointApplicationState(state);
    const stored = await readApplicationState();
    expect(stored?.session).toEqual(state.session);
    expect(stored?.walletContext).toEqual(entry.owner.providerScope);
    expect(stored?.walletObligations).toEqual([entry]);
  });

  it('a later whole-root checkpoint cannot retain stale wallet or session fields', async () => {
    await storageRepository.checkpointApplicationState(
      withWallet(activeSave({ pairingToken: 'one' })),
    );
    const replacement = activeSave({ pairingToken: 'two' });
    await storageRepository.checkpointApplicationState(replacement);
    const stored = await readApplicationState();
    expect(stored?.session).toEqual(replacement.session);
    expect(stored?.walletObligations).toEqual([]);
  });

  it('semantic clear keeps unresolved obligations in the same aggregate', async () => {
    const state = withWallet(activeSave());
    storageRepository._replaceApplicationStateForTests(state);
    await storageRepository.checkpointApplicationState(state);
    await storageRepository.clearSession();
    const stored = await readApplicationState();
    expect(stored?.session).toBeNull();
    expect(stored?.walletObligations).toHaveLength(1);
    expect(stored?.walletObligations[0]).toMatchObject({ tradeId: entry.tradeId });
  });

  it('preserves concurrent session, wallet, and rejection root transforms', async () => {
    const first = captureDurableApplicationState({
      kind: 'transform',
      transform: () => activeSave({ pairingToken: 'captured-session' }),
    })!;
    const rejection = {
      kind: 'inbound-receipt' as const,
      peerId: 'peer',
      sessionId: 'cd'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 1n,
      unackedMessages: [],
      createdAt: 1,
    };
    const second = captureDurableApplicationState({
      kind: 'transform',
      transform: (state) => ({
        ...state,
        walletContext: entry.owner.providerScope,
        walletObligations: [entry],
        rejectionTransports: [rejection],
      }),
    })!;

    await first.write();
    await second.write();

    const stored = await readApplicationState();
    expect(stored?.session?.phase === 'live' && stored.session.pairing.token).toBe(
      'captured-session',
    );
    expect(stored?.walletObligations).toEqual([entry]);
    expect(stored?.rejectionTransports).toEqual([rejection]);
  });

  it('keeps every durable image whole while live capture races preference and wallet writes', async () => {
    const serializedGameSession = new Uint8Array([22, 4, 9, 1]);
    const controller = {
      getWalletProviderScope: () => entry.owner.providerScope,
      getWasmFields: () => ({
        serializedGameSession,
        gameSessionSchemaVersion: 22n,
        pairingToken: 'captured-live-root',
        gameSessionId: '12'.repeat(16),
        messageNumber: 7n,
        remoteNumber: 5n,
        iStarted: true,
        myContribution: '60',
        theirContribution: '40',
        perGameAmount: '10',
        rewardPuzzleHash: '11'.repeat(32),
        unackedMessages: [{ msgno: 6n, msg: new Uint8Array([3, 2, 1]) }],
        terminalHandoff: null,
        transportDisposition: 'active' as const,
        channelStatus: { state: 'Active' as const },
        wasmNotificationHistory: ['captured notification'],
        diagnosticLog: ['captured diagnostic'],
        waitingStateEnteredAt: null,
        cleanShutdownGraceStartedAt: null,
        durabilityWarning: 'transient controller mirror',
        activeGameIds: ['stale-controller-mirror'],
      }),
    } as unknown as SessionController;
    const machine = createSessionMachineState(
      createSessionModel({
        channel: {
          dismissedChannelStatus: 'Active',
          queue: [
            {
              id: 1n,
              kind: 'durability-error',
              title: 'Transient',
              message: 'Do not persist',
            },
          ],
        },
        betweenHand: {
          compose: {
            selectedGame: 'calpoker',
            gameTimeout: 15n,
            proposalSent: true,
          },
        },
      }),
    );
    const prepared = captureDurableApplicationState({
      kind: 'live',
      controller,
      getState: () => machine,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
    });
    if (!prepared) throw new Error('expected prepared live capture');

    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    storageRepository.holdNextCheckpointAfterCommitForTests(barrier, committed);

    const liveWrite = prepared.write();
    await reachedCommit;
    const duringLiveWrite = await readApplicationState();
    expect(duringLiveWrite).not.toBeNull();
    expect(() => decodeDurableApplicationState(duringLiveWrite!)).not.toThrow();
    expect(duringLiveWrite?.session?.phase).toBe('live');
    if (duringLiveWrite?.session?.phase !== 'live') throw new Error('expected live boundary');
    expect(duringLiveWrite.session.live.serializedGameSession).toEqual(serializedGameSession);
    expect(duringLiveWrite.session.pairing.token).toBe('captured-live-root');
    expect(duringLiveWrite.session.live).not.toHaveProperty('durabilityWarning');
    expect(duringLiveWrite.session.live).not.toHaveProperty('activeGameIds');
    expect(duringLiveWrite.session.presentation).not.toHaveProperty('myRunningBalance');
    expect(duringLiveWrite.session.presentation).not.toHaveProperty('channelNotifQueue');
    expect(duringLiveWrite.session.presentation).not.toHaveProperty('gameNotifQueue');
    expect(duringLiveWrite.session.presentation).not.toHaveProperty('dismissedChannelStatus');
    expect(duringLiveWrite.session.presentation.betweenHandCompose).not.toHaveProperty(
      'proposal_sent',
    );

    const preferenceWrite = storageRepository.updatePreference({
      key: 'alias',
      value: 'Latest Alice',
    });
    storageRepository.reduceWallet({ kind: 'install', entry });
    release();
    await liveWrite;
    await Promise.all([preferenceWrite, storageRepository.flushAggregate()]);

    const final = await readApplicationState();
    expect(final).not.toBeNull();
    expect(() => decodeDurableApplicationState(final!)).not.toThrow();
    expect(final?.session).toEqual(duringLiveWrite.session);
    expect(final?.preferences.alias).toBe('Latest Alice');
    expect(final?.walletContext).toEqual(entry.owner.providerScope);
    expect(final?.walletObligations).toEqual([entry]);
  });
});
