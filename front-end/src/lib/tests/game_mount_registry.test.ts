import { GAME_REGISTRY } from '../gameRegistry';
import { GAME_MOUNT_TYPES, hasGameMount } from '../gameMountRegistryCore';

describe('game mount registry', () => {
  it('has one live/frozen mount for every pure adapter', () => {
    expect(GAME_MOUNT_TYPES).toEqual(GAME_REGISTRY.map((entry) => entry.gameType));
    for (const entry of GAME_REGISTRY) expect(hasGameMount(entry.gameType)).toBe(true);
  });

  it('rejects unknown game mounts', () => {
    expect(hasGameMount('debug')).toBe(false);
    expect(hasGameMount('')).toBe(false);
  });
});
