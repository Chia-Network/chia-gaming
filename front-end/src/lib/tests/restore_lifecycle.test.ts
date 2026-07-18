import {
  isRestoreBlocked,
  isTerminalChannelStatus,
  shouldAdvertiseAvailable,
  shouldAwaitShutdownOnPeerUnreachable,
  shouldCancelOnPeerUnreachable,
  shouldMountGameSession,
  shouldReportTrackerBusy,
  shouldSwitchToTrackerOnResolved,
} from '../restoreLifecycle';

describe('restore lifecycle gates', () => {
  it('blocks restored-session behavior until wasm restore and tracker reconciliation both finish', () => {
    expect(isRestoreBlocked(true, 'idle', false)).toBe(true);
    expect(isRestoreBlocked(true, 'restoring', false)).toBe(true);
    expect(isRestoreBlocked(true, 'restored', false)).toBe(true);
    expect(isRestoreBlocked(true, 'failed', true)).toBe(true);
    expect(isRestoreBlocked(true, 'restored', true)).toBe(false);
    expect(isRestoreBlocked(false, 'idle', false)).toBe(false);
  });

  it('keeps the lobby unavailable while restore is blocked', () => {
    expect(shouldAdvertiseAvailable('none', true)).toBe(false);
    expect(shouldAdvertiseAvailable('resolved', true)).toBe(false);
    expect(shouldAdvertiseAvailable('none', false)).toBe(true);
    expect(shouldAdvertiseAvailable('resolved', false)).toBe(true);
    expect(shouldAdvertiseAvailable('off-chain', false)).toBe(false);
  });

  it('keeps tracker presence busy until the session is resolved', () => {
    expect(shouldReportTrackerBusy('none')).toBe(false);
    expect(shouldReportTrackerBusy('resolved')).toBe(false);
    expect(shouldReportTrackerBusy('off-chain')).toBe(true);
    expect(shouldReportTrackerBusy('on-chain')).toBe(true);
  });

  it('recognizes terminal channel states that must not keep the lobby busy', () => {
    expect(isTerminalChannelStatus('Failed')).toBe(true);
    expect(isTerminalChannelStatus('ResolvedClean')).toBe(true);
    expect(isTerminalChannelStatus('ResolvedUnrolled')).toBe(true);
    expect(isTerminalChannelStatus('ResolvedStale')).toBe(true);
    expect(isTerminalChannelStatus('Active')).toBe(false);
    expect(isTerminalChannelStatus('Handshaking')).toBe(false);
    expect(isTerminalChannelStatus(null)).toBe(false);
  });

  it('cancels only pre-Active peer hard-disconnects; later sessions stay for on-chain', () => {
    expect(shouldCancelOnPeerUnreachable('none', null)).toBe(true);
    expect(shouldCancelOnPeerUnreachable('none', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Handshaking')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'OurWalletMakingOffer')).toBe(true);
    expect(shouldCancelOnPeerUnreachable('off-chain', 'Active')).toBe(false);
    expect(shouldCancelOnPeerUnreachable('on-chain', 'Active')).toBe(false);
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

  it('only switches to tracker for a live clean-resolution transition', () => {
    expect(shouldSwitchToTrackerOnResolved('none', false)).toBe(false);
    expect(shouldSwitchToTrackerOnResolved('on-chain', false)).toBe(false);
    expect(shouldSwitchToTrackerOnResolved('off-chain', true)).toBe(false);
    expect(shouldSwitchToTrackerOnResolved('off-chain', false)).toBe(true);
  });
});
