import {
  isRestoreBlocked,
  restoreGateAfterTerminalFinalization,
  shouldAdvertiseAvailable,
  shouldAwaitShutdownOnPeerUnreachable,
  shouldCancelAttemptOnDisconnect,
  shouldCancelOnPeerUnreachable,
  shouldMountGameSession,
  shouldReportHubBusy,
  shouldReportHubBusyPresence,
  shouldReportSessionPhase,
  shouldSuppressPhaseReporting,
  shouldSwitchToHubOnResolved,
  shouldWarnOnSessionUnload,
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

  it('does not re-arm Restoring session after terminal finalization of a resumed mount', () => {
    // Resumed live sessions keep params.restoring=true after WASM+hub succeed.
    expect(isRestoreBlocked(true, 'restored', true)).toBe(false);

    // The old finishResolvedSessionDisplay reset (idle + hubReconciled=false)
    // while leaving restoring=true re-blocked GameSession via suppressPhaseReporting.
    expect(isRestoreBlocked(true, 'idle', false)).toBe(true);
    expect(shouldSuppressPhaseReporting(true, false)).toBe(true);

    const after = restoreGateAfterTerminalFinalization();
    expect(after.restoring).toBe(false);
    expect(isRestoreBlocked(after.restoring, after.restoreStatus, after.hubReconciled)).toBe(false);

    // Even if restoreBlocked were still true, a terminal presentation must win:
    // slash stays on the game tab (hasError) and must show the finished freeze.
    expect(shouldSuppressPhaseReporting(true, true)).toBe(false);
    expect(shouldSwitchToHubOnResolved('on-chain', true)).toBe(false);
    expect(shouldSwitchToHubOnResolved('off-chain', true)).toBe(false);
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

  it('warns before unload only while a session is off-chain or on-chain', () => {
    expect(shouldWarnOnSessionUnload('none')).toBe(false);
    expect(shouldWarnOnSessionUnload('resolved')).toBe(false);
    expect(shouldWarnOnSessionUnload('off-chain')).toBe(true);
    expect(shouldWarnOnSessionUnload('on-chain')).toBe(true);
  });

  it('keeps hub presence busy until the session is resolved', () => {
    expect(shouldReportHubBusy('none')).toBe(false);
    expect(shouldReportHubBusy('resolved')).toBe(false);
    expect(shouldReportHubBusy('off-chain')).toBe(true);
    expect(shouldReportHubBusy('on-chain')).toBe(true);
  });

  it('reports busy whenever the wallet is disconnected, even with no session', () => {
    expect(shouldReportHubBusy('none', false)).toBe(true);
    expect(shouldReportHubBusy('resolved', false)).toBe(true);
    expect(shouldReportHubBusy('off-chain', false)).toBe(true);
    expect(shouldReportHubBusy('on-chain', false)).toBe(true);
    // Explicit walletConnected=true matches the default behavior.
    expect(shouldReportHubBusy('none', true)).toBe(false);
    expect(shouldReportHubBusy('off-chain', true)).toBe(true);
  });

  it('keeps hub presence busy for a non-terminal restore cradle even when phase is still none', () => {
    // Wallet reconnect mid-resume: phase has not advanced yet, but the cradle
    // means we must not advertise available.
    expect(
      shouldReportHubBusyPresence('none', true, {
        restoring: true,
        terminalSave: false,
        hasCradle: true,
      }),
    ).toBe(true);
    // Terminal Failed/Resolved* cradle must not keep us busy once wallet is back.
    expect(
      shouldReportHubBusyPresence('none', true, {
        restoring: true,
        terminalSave: true,
        hasCradle: true,
      }),
    ).toBe(false);
    expect(
      shouldReportHubBusyPresence('resolved', true, {
        restoring: true,
        terminalSave: true,
        hasCradle: true,
      }),
    ).toBe(false);
    // No cradle / not restoring: phase alone decides (with wallet).
    expect(
      shouldReportHubBusyPresence('none', true, {
        restoring: false,
        terminalSave: false,
        hasCradle: false,
      }),
    ).toBe(false);
    expect(
      shouldReportHubBusyPresence('off-chain', true, {
        restoring: false,
        terminalSave: false,
        hasCradle: false,
      }),
    ).toBe(true);
    // Walletless still forces busy even with no cradle.
    expect(
      shouldReportHubBusyPresence('none', false, {
        restoring: false,
        terminalSave: false,
        hasCradle: false,
      }),
    ).toBe(true);
  });

  it('cancels only pre-Active peer hard-disconnects; later sessions stay for on-chain', () => {
    expect(shouldCancelOnPeerUnreachable('none', null)).toBe(true);
    expect(shouldCancelOnPeerUnreachable('none', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'OurWalletMakingOffer')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('on-chain', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'OfferSent', true)).toBe(false);
    // Phase 'none' with a known Active/post-active channel is a blocked restore,
    // not a pre-active matchmaking attempt; delivery failures should degrade.
    expect(shouldCancelOnPeerUnreachable('none', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('none', 'ShuttingDown')).toBe(false);
    // Finished sessions keep freeze/terminal save even if channelState is null
    // (null is otherwise treated as pre-active).
    expect(shouldCancelOnPeerUnreachable('resolved', 'ResolvedClean')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('resolved', null)).toBe(false);
  });

  it('wallet/hub disconnect cancels only pre-active attempts, not pending invites on a resolved freeze', () => {
    // Pending advisory alone (no PeerSession / pairingToken yet).
    expect(shouldCancelAttemptOnDisconnect(false, 'resolved', 'ResolvedClean')).toBe(false);
    expect(shouldCancelAttemptOnDisconnect(false, 'none', null)).toBe(false);
    // Pending proposal creates PeerSession before accept — still must not wipe
    // a finished session when phase is resolved.
    expect(shouldCancelAttemptOnDisconnect(true, 'resolved', 'ResolvedClean')).toBe(false);
    expect(shouldCancelAttemptOnDisconnect(true, 'resolved', null)).toBe(false);
    // Real pre-active matchmaking still cancels.
    expect(shouldCancelAttemptOnDisconnect(true, 'none', null)).toBe(true);
    expect(shouldCancelAttemptOnDisconnect(true, 'off-chain', 'Handshaking')).toBe(true);
    expect(shouldCancelAttemptOnDisconnect(true, 'off-chain', 'Active')).toBe(false);
    // Mid-resume: phase is still 'none' while WASM restore is blocked, but the
    // persisted channel is already Active. Wallet/hub disconnect must not cancel.
    expect(shouldCancelAttemptOnDisconnect(true, 'none', 'Active')).toBe(false);
    expect(shouldCancelAttemptOnDisconnect(true, 'none', 'ShuttingDown')).toBe(false);
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
