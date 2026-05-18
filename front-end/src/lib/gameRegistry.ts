export interface GameRegistryEntry {
  gameType: string;
  displayName: string;
}

export const GAME_REGISTRY: GameRegistryEntry[] = [
  { gameType: 'calpoker', displayName: 'California Poker' },
  { gameType: 'spacepoker', displayName: 'Space Poker' },
];

export const GAME_TYPE_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  GAME_REGISTRY.map(({ gameType, displayName }) => [gameType, displayName]),
);

export function gameDisplayName(gameType: string): string {
  return GAME_TYPE_DISPLAY_NAMES[gameType] ?? gameType;
}
