import {
  isAvailableForNewSessionPrompt,
  isRestoreBlocked,
  peerGateAfterSessionClear,
  shouldActivatePeerGate,
  shouldAdvertiseAvailable,
  shouldAwaitShutdownOnPeerUnreachable,
  shouldCancelOnPeerUnreachable,
  shouldMountGameSession,
  shouldReportHubBusy,
  shouldReportPresenceBusy,
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

  it('keeps presence busy after session end/cancel while the peer gate is unverified', () => {
    // Session alone would advertise available — peer gate must still hold busy.
    expect(shouldReportPresenceBusy('none', true, false)).toBe(true);
    expect(shouldReportPresenceBusy('resolved', true, false)).toBe(true);
    // Gate inactive or peer verified → session phase decides.
    expect(shouldReportPresenceBusy('none', false, false)).toBe(false);
    expect(shouldReportPresenceBusy('resolved', true, true)).toBe(false);
    expect(shouldReportPresenceBusy('off-chain', false, true)).toBe(true);
    expect(shouldReportPresenceBusy('on-chain', true, false)).toBe(true);
  });

  it('activates the WalletConnect peer gate only when not resuming a live session', () => {
    // Callers pass true for cradle OR pairingToken — both skip the pre-match gate.
    expect(shouldActivatePeerGate('walletconnect', false)).toBe(true);
    expect(shouldActivatePeerGate('walletconnect', true)).toBe(false);
    expect(shouldActivatePeerGate('simulator', false)).toBe(false);
    expect(shouldActivatePeerGate('simulator', true)).toBe(false);
    expect(shouldActivatePeerGate(undefined, false)).toBe(false);
  });

  it('re-arms the peer gate on idle/terminal clear after a skipped-gate session', () => {
    // Resume skipped the gate (active=false, peer "ready" from !gate). Clear must
    // activate + unverify before presenceBusy can advertise available.
    const rearmed = peerGateAfterSessionClear('walletconnect', false, true);
    expect(rearmed).toEqual({ peerGateActive: true, hasFullNodePeer: false });
    expect(shouldReportPresenceBusy('none', rearmed.peerGateActive, rearmed.hasFullNodePeer)).toBe(true);
    expect(shouldReportPresenceBusy('resolved', rearmed.peerGateActive, rearmed.hasFullNodePeer)).toBe(true);
    // Already active: preserve peer-ready (verified or not).
    expect(peerGateAfterSessionClear('walletconnect', true, true)).toEqual({
      peerGateActive: true,
      hasFullNodePeer: true,
    });
    expect(peerGateAfterSessionClear('walletconnect', true, false)).toEqual({
      peerGateActive: true,
      hasFullNodePeer: false,
    });
    // Simulator never gates.
    expect(peerGateAfterSessionClear('simulator', false, true)).toEqual({
      peerGateActive: false,
      hasFullNodePeer: true,
    });
  });

  it('rejects inbound matchmaking while the peer gate holds presence busy', () => {
    // Idle session + no pending prompts, but peers unverified → unavailable.
    expect(isAvailableForNewSessionPrompt('none', false, false, false, false, true, false)).toBe(false);
    expect(isAvailableForNewSessionPrompt('resolved', false, false, false, false, true, false)).toBe(false);
    // Gate open / peer verified → available when otherwise idle.
    expect(isAvailableForNewSessionPrompt('none', false, false, false, false, true, true)).toBe(true);
    expect(isAvailableForNewSessionPrompt('none', false, false, false, false, false, false)).toBe(true);
    // Session obligation or pending matchmaking still blocks.
    expect(isAvailableForNewSessionPrompt('off-chain', false, false, false, false, false, true)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', true, false, false, false, false, true)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, true, false, false, false, true)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, false, true, false, false, true)).toBe(false);
    expect(isAvailableForNewSessionPrompt('none', false, false, false, true, false, true)).toBe(false);
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
