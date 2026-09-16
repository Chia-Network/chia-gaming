import { coinIdFromBytes, toUint8 } from '../../util';
import {
  SETTLEMENT_PAYMENT_PUZZLE_HASH,
  SINGLETON_LAUNCHER_PUZZLE_HASH,
  computeOfferFundedLauncherCoin,
} from '../../util/launcher';

describe('offer-funded launcher derivation', () => {
  it('derives wallet -> settlement(contribution + fee) -> launcher(contribution)', async () => {
    const walletCoin = `${'11'.repeat(32)}${'22'.repeat(32)}03e8`;
    const walletCoinId = await coinIdFromBytes(toUint8(walletCoin));
    const result = await computeOfferFundedLauncherCoin(walletCoin, 100n, 10n);

    expect(result.settlementCoinHex).toBe(`${walletCoinId}${SETTLEMENT_PAYMENT_PUZZLE_HASH}6e`);
    const settlementCoinId = await coinIdFromBytes(toUint8(result.settlementCoinHex));
    expect(result.launcherCoinHex).toBe(`${settlementCoinId}${SINGLETON_LAUNCHER_PUZZLE_HASH}64`);
    await expect(coinIdFromBytes(toUint8(result.launcherCoinHex))).resolves.toBe(
      result.launcherCoinId,
    );
  });

  it('rejects contribution plus fee outside the u64 range', async () => {
    const walletCoin = `${'11'.repeat(32)}${'22'.repeat(32)}01`;
    await expect(
      computeOfferFundedLauncherCoin(walletCoin, 0xffff_ffff_ffff_ffffn, 1n),
    ).rejects.toThrow(/u64/);
  });
});
