import timeoutBounds from 'chia-gaming-protocol-constants';

export const MIN_GAME_TIMEOUT_BLOCKS = BigInt(timeoutBounds.gameTimeoutBlocks.min);
export const MAX_GAME_TIMEOUT_BLOCKS = BigInt(timeoutBounds.gameTimeoutBlocks.max);

export function isValidGameTimeoutBlocks(timeout: bigint): boolean {
  return timeout >= MIN_GAME_TIMEOUT_BLOCKS && timeout <= MAX_GAME_TIMEOUT_BLOCKS;
}
