import type { RegisteredGameType } from './session/types';

export const GAME_MOUNT_TYPES = [
  'calpoker',
  'spacepoker',
  'krunk',
] as const satisfies readonly RegisteredGameType[];

export function hasGameMount(gameType: string): gameType is RegisteredGameType {
  return (GAME_MOUNT_TYPES as readonly string[]).includes(gameType);
}
