import {
  isRestoreBlocked,
  isTerminalChannelState,
  shouldAdvertiseAvailable,
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
    expect(isTerminalChannelState('Failed')).toBe(true);
    expect(isTerminalChannelState('ResolvedClean')).toBe(true);
    expect(isTerminalChannelState('ResolvedUnrolled')).toBe(true);
    expect(isTerminalChannelState('ResolvedStale')).toBe(true);
    expect(isTerminalChannelState('Active')).toBe(false);
    expect(isTerminalChannelState('Handshaking')).toBe(false);
    expect(isTerminalChannelState(null)).toBe(false);
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
