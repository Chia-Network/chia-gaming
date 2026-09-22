import { indexedDbStoragePort, readApplicationState } from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import type { ChannelFundingEntry } from '../session/channelFundingStore';
import { buildDurableApplicationState } from '../session/sessionMachinePersist';
import { decodeDurableApplicationState } from '../session/persistence';
import { createSessionMachineState } from '../session/sessionMachine';
import { createSessionModel } from '../session/model';
import type { SessionController } from '../../hooks/SessionController';
import { activeSave } from './session_save_envelope.fixtures';
import './save.harness';

const entry: ChannelFundingEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: { provider: 'simulator', identity: 'player' },
  },
  purpose: { kind: 'funding', operationId: 'funding' },
  stage: 'awaiting-channel',
  providerReservationId: 'trade',
  request: {
    kind: 'funding',
    canonical: { amount: '100', fee: '0', conditions: [] },
  },
  reason: '',
};

function withWallet(state: ReturnType<typeof activeSave>): ReturnType<typeof activeSave> {
  return {
    ...state,
    walletContext: entry.owner.providerScope,
    channelFundingOperations: [entry],
  };
}

describe('aggregate checkpoints', () => {
  it('logs ordinary aggregate write failures with a stack', async () => {
    const failure = new Error('disk unavailable');
    const write = jest
      .spyOn(indexedDbStoragePort, 'writeApplicationState')
      .mockRejectedValueOnce(failure);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      storageRepository.write(storageRepository.patchApplicationState(() => activeSave())),
    ).rejects.toBe(failure);

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
    await storageRepository.write(storageRepository.patchApplicationState(() => state));
    const stored = await readApplicationState();
    expect(stored?.session).toEqual(state.session);
    expect(stored?.walletContext).toEqual(entry.owner.providerScope);
    expect(stored?.channelFundingOperations).toEqual([entry]);
  });

  it('signals an attached runtime without starting repository writes', async () => {
    const requestCommit = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    const detach = storageRepository.attachRuntime({ requestCommit, flush });
    const write = jest.spyOn(indexedDbStoragePort, 'writeApplicationState');

    await storageRepository.updatePreference({ key: 'alias', value: 'Runtime Alice' });
    await storageRepository.updateCommon({ history: { humanHistory: ['runtime history'] } });

    expect(requestCommit).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    await storageRepository.checkpointDomainMutations();
    expect(flush).toHaveBeenCalledTimes(1);

    write.mockRestore();
    detach();
  });

  it('a later whole-root checkpoint cannot retain stale wallet or session fields', async () => {
    await storageRepository.write(
      storageRepository.patchApplicationState(() =>
        withWallet(activeSave({ pairingToken: 'one' })),
      ),
    );
    const replacement = activeSave({ pairingToken: 'two' });
    await storageRepository.write(storageRepository.patchApplicationState(() => replacement));
    const stored = await readApplicationState();
    expect(stored?.session).toEqual(replacement.session);
    expect(stored?.channelFundingOperations).toEqual([]);
  });

  it('semantic clear keeps unresolved obligations in the same aggregate', async () => {
    const state = withWallet(activeSave());
    storageRepository._replaceApplicationStateForTests(state);
    await storageRepository.write(storageRepository.patchApplicationState(() => state));
    await storageRepository.clearSession();
    const stored = await readApplicationState();
    expect(stored?.session).toBeNull();
    expect(stored?.channelFundingOperations).toHaveLength(1);
    expect(stored?.channelFundingOperations[0]).toMatchObject({
      providerReservationId: entry.providerReservationId,
    });
  });

  it('preserves concurrent session, wallet, and rejection root transforms', async () => {
    const first = storageRepository.patchApplicationState(() =>
      activeSave({ pairingToken: 'captured-session' }),
    );
    const rejection = {
      kind: 'inbound-receipt' as const,
      peerId: 'peer',
      sessionId: 'cd'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 1n,
      unackedMessages: [],
      createdAt: 1,
    };
    const second = storageRepository.patchApplicationState((state) => ({
      ...state,
      walletContext: entry.owner.providerScope,
      channelFundingOperations: [entry],
      rejectionTransports: [rejection],
    }));

    await storageRepository.write(first);
    await storageRepository.write(second);

    const stored = await readApplicationState();
    expect(stored?.session?.phase === 'live' && stored.session.pairing.token).toBe(
      'captured-session',
    );
    expect(stored?.channelFundingOperations).toEqual([entry]);
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
    const snapshot = buildDurableApplicationState({
      kind: 'live',
      controller,
      state: machine,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
    });
    if (!snapshot) throw new Error('expected live snapshot');

    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    storageRepository.holdNextCheckpointAfterCommitForTests(barrier, committed);

    const liveWrite = storageRepository.write(snapshot);
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
    storageRepository.replaceChannelFunding([entry]);
    release();
    await liveWrite;
    await Promise.all([preferenceWrite, storageRepository.checkpointDomainMutations()]);

    const final = await readApplicationState();
    expect(final).not.toBeNull();
    expect(() => decodeDurableApplicationState(final!)).not.toThrow();
    expect(final?.session).toEqual(duringLiveWrite.session);
    expect(final?.preferences.alias).toBe('Latest Alice');
    expect(final?.walletContext).toEqual(entry.owner.providerScope);
    expect(final?.channelFundingOperations).toEqual([entry]);
  });
});
