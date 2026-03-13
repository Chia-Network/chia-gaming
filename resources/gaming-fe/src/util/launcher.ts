import { toUint8, toHexString } from '../util';

export const SINGLETON_LAUNCHER_PUZZLE_HASH =
  'eff07522495060c066f66f32acc2a77e3a3e737aca8baea4d1a64ea4cdc13da9';

/**
 * Compute the hex coin string for the 0-value launcher coin that will be
 * created as a child of `parentCoinHex`.
 *
 * A Chia coin string is the concatenation of:
 *   parent_coin_id (32 bytes) + puzzle_hash (32 bytes) + amount (CLVM int encoding)
 *
 * For a 0-value launcher the amount encodes to the empty byte string (0x80 in CLVM atom form),
 * but here the "coin string" is just the raw triple without CLVM wrapping, so 0 encodes to
 * zero bytes.  The parent_coin_id is the SHA-256 of the parent coin string.
 */
export async function computeLauncherCoin(
  parentCoinHex: string,
): Promise<{ launcherCoinHex: string; launcherCoinId: string }> {
  const parentBytes = toUint8(parentCoinHex);
  const parentIdBuf = await crypto.subtle.digest('SHA-256', parentBytes);
  const parentId = new Uint8Array(parentIdBuf);

  const launcherPh = toUint8(SINGLETON_LAUNCHER_PUZZLE_HASH);

  // 0-value coin: parent_id (32) + puzzle_hash (32) + amount (0 bytes for value 0)
  const launcherCoinBytes = new Uint8Array(32 + 32);
  launcherCoinBytes.set(parentId, 0);
  launcherCoinBytes.set(launcherPh, 32);

  const launcherCoinHex = toHexString(Array.from(launcherCoinBytes));

  const launcherIdBuf = await crypto.subtle.digest('SHA-256', launcherCoinBytes);
  const launcherCoinId = toHexString(Array.from(new Uint8Array(launcherIdBuf)));

  return { launcherCoinHex, launcherCoinId };
}
