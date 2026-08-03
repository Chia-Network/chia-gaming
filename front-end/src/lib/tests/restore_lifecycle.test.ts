import {
  isAvailableForNewSessionPrompt,
  isAwaitingFullNodePeer,
  isRestoreBlocked,
  shouldAdvertiseAvailable,
  shouldAwaitShutdownOnPeerUnreachable,
  shouldCancelOnPeerUnreachable,
  shouldMountGameSession,
  shouldReportHubBusy,
  shouldReportPresenceBusy,
  shouldReportRestoreObligationBusy,
  shouldReportSessionPhase,
  shouldSwitchToHubOnResolved,
} from '../restoreLifecycle';

describe('restore lifecycle gates', () => {
  it('blocks restored-session behavior until wasm restore and hub reconciliation both finish', () => {
    expect(isRestoreBlocked(true, 'idle', false)).toBe(true);
    expect(isRestoreBlocked(true, 'restoring', false)).toBe(true);
    expect(isRestoreBlocked(true, 'restored', false)).toBe(true);
    expect(isRestoreBlocked(true, 'failed', true)).toBe(true);
    expect(isRestoreBlocked(true, 'restored', true)).toBe(false);
    expect(isRestoreBlocked(false, 'idle', false)).toBe(false);
  });

  it('keeps the hub unavailable while restore is blocked', () => {
    expect(shouldAdvertiseAvailable('none', true)).toBe(false);
    expect(shouldAdvertiseAvailable('resolved', true)).toBe(false);
    expect(shouldAdvertiseAvailable('none', false)).toBe(true);
    expect(shouldAdvertiseAvailable('resolved', false)).toBe(true);
    expect(shouldAdvertiseAvailable('off-chain', false)).toBe(false);
  });

  it('defers a persisted resolved phase until restoration is authoritative', () => {
    // The first resolved projection comes from the save and must not tear down
    // the live controller before both restore and hub reconciliation complete.
    expect(shouldReportSessionPhase('resolved', true, false)).toBe(false);

    // Once the restore gate opens, report the current authoritative phase once.
    expect(shouldReportSessionPhase('resolved', false, false)).toBe(true);
    expect(shouldReportSessionPhase('resolved', false, true)).toBe(false);
  });

  it('keeps hub presence busy until the session is resolved', () => {
    expect(shouldReportHubBusy('none')).toBe(false);
    expect(shouldReportHubBusy('resolved')).toBe(false);
    expect(shouldReportHubBusy('off-chain')).toBe(true);
    expect(shouldReportHubBusy('on-chain')).toBe(true);
  });

  it('keeps presence busy while WalletConnect awaits a full node peer', () => {
    // Session alone would advertise available — the peer wait must still hold busy.
    expect(shouldReportPresenceBusy('none', true)).toBe(true);
    expect(shouldReportPresenceBusy('resolved', true)).toBe(true);
    // Peer verified (not awaiting) → session phase decides.
    expect(shouldReportPresenceBusy('none', false)).toBe(false);
    expect(shouldReportPresenceBusy('resolved', false)).toBe(false);
    expect(shouldReportPresenceBusy('off-chain', false)).toBe(true);
    expect(shouldReportPresenceBusy('on-chain', false)).toBe(true);
  });

  it('keeps presence busy for non-terminal restore while phase is still none', () => {
    // Mid-resume: phase alone would clear busy once a full-node peer is verified.
    expect(shouldReportRestoreObligationBusy(true, false, true, false)).toBe(true);
    expect(shouldReportRestoreObligationBusy(true, false, false, true)).toBe(true);
    // Terminal save / not restoring / no cradle → no restore obligation.
    expect(shouldReportRestoreObligationBusy(true, true, true, false)).toBe(false);
    expect(shouldReportRestoreObligationBusy(false, false, true, false)).toBe(false);
    expect(shouldReportRestoreObligationBusy(true, false, false, false)).toBe(false);
    // Combined with peer-ready (not awaiting): restore must still hold busy.
    expect(
      shouldReportPresenceBusy('none', false) ||
        shouldReportRestoreObligationBusy(true, false, true, false),
    ).toBe(true);
  });

  it('awaits a full node peer only on WalletConnect without a verified peer', () => {
    expect(isAwaitingFullNodePeer('walletconnect', false)).toBe(true);
    expect(isAwaitingFullNodePeer('walletconnect', true)).toBe(false);
    expect(isAwaitingFullNodePeer('simulator', false)).toBe(false);
    expect(isAwaitingFullNodePeer('simulator', true)).toBe(false);
    expect(isAwaitingFullNodePeer(undefined, false)).toBe(false);
  });

  it('rejects inbound matchmaking while awaiting a full node peer', () => {
    // Idle session + no pending prompts, but awaiting a peer → unavailable.
    expect(isAvailableForNewSessionPrompt('none', false, false, false, false, true)).toBe(false);
    expect(isAvailableForNewSessionPrompt('resolved', false, false, false, false, true)).toBe(
      false,
    );
    // Peer verified → available when otherwise idle.
    expect(isAvailableForNewSessionPrompt('none', false, false, false, false, false)).toBe(true);
    expect(isAvailableForNewSessionPrompt('resolved', false, false, false, false, false)).toBe(
      true,
    );
    // Session obligation or pending matchmaking still blocks.
    expect(isAvailableForNewSessionPrompt('off-chain', false, false, false, false, false)).toBe(
      false,
    );
    expect(isAvailableForNewSessionPrompt('none', true, false, false, false, false)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, true, false, false, false)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, false, true, false, false)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, false, false, true, false)).toBe(false);
  });

  it('cancels only pre-Active peer hard-disconnects; later sessions stay for on-chain', () => {
    expect(shouldCancelOnPeerUnreachable('none', null)).toBe(true);
    expect(shouldCancelOnPeerUnreachable('none', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'OurWalletMakingOffer')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('on-chain', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'OfferSent', true)).toBe(false);
  });

  it('awaits a pending clean-shutdown transaction instead of escalating on-chain', () => {
    // Live Active and ShutdownTransactionPending both degrade on delivery_failure
    // (Shell); this helper is for callers that need the shutdown-specific case.
    expect(shouldCancelOnPeerUnreachable('off-chain', 'ShutdownTransactionPending')).toBe(false);
    expect(shouldAwaitShutdownOnPeerUnreachable('ShutdownTransactionPending')).toBe(true);
    expect(shouldAwaitShutdownOnPeerUnreachable('ShuttingDown')).toBe(false);
    expect(shouldAwaitShutdownOnPeerUnreachable('Active')).toBe(false);
  });

  it('mounts a saved session without requiring a live blockchain connection', () => {
    expect(shouldMountGameSession(true, false, true, false)).toEqual({
      startSession: true,
      keepSession: true,
    });
    expect(shouldMountGameSession(true, false, false, false)).toEqual({
      startSession: false,
      keepSession: false,
    });
    expect(shouldMountGameSession(true, false, false, true)).toEqual({
      startSession: false,
      keepSession: true,
    });
  });

  it('only switches to hub for a live clean-resolution transition', () => {
    expect(shouldSwitchToHubOnResolved('none', false)).toBe(false);
    expect(shouldSwitchToHubOnResolved('on-chain', false)).toBe(false);
    expect(shouldSwitchToHubOnResolved('off-chain', true)).toBe(false);
    expect(shouldSwitchToHubOnResolved('off-chain', false)).toBe(true);
  });
});
