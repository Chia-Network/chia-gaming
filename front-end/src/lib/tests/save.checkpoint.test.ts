import { readApplicationState } from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import type { WalletOperationEntry } from '../session/walletOperationStore';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';
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
});
