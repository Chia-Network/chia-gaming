import { hasGameMount } from '../gameMountRegistry';

describe('game mount registry', () => {
  it('recognizes registered keys and rejects unknown mounts', () => {
    expect(hasGameMount('calpoker')).toBe(true);
    expect(hasGameMount('spacepoker')).toBe(true);
    expect(hasGameMount('krunk')).toBe(true);
    expect(hasGameMount('debug')).toBe(false);
    expect(hasGameMount('')).toBe(false);
  });
});
