export const MIN_GAME_TIMEOUT_BLOCKS = 3n;
export const MAX_GAME_TIMEOUT_BLOCKS = 100n;

export function isValidGameTimeoutBlocks(timeout: bigint): boolean {
  return timeout >= MIN_GAME_TIMEOUT_BLOCKS && timeout <= MAX_GAME_TIMEOUT_BLOCKS;
}
