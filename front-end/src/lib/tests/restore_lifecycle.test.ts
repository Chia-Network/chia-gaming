import {
  isRestoreBlocked,
  shouldAdvertiseAvailable,
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
});
