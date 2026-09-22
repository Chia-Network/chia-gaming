import { getCurrencyLabels, isTestnet } from '../../constants/currency';
import { formatAmount, formatMojos } from '../../util';
import { storageRepository } from '../session/storageRepository';

function selectNetwork(network: 'mainnet' | 'testnet' | undefined) {
  if (network !== undefined)
    void storageRepository.updatePreference({ key: 'network', value: network });
}

describe('currency labels follow the network preference', () => {
  afterEach(() => {
    storageRepository._resetForTests();
  });

  it('defaults to mainnet nomenclature when no preference is stored', () => {
    selectNetwork(undefined);
    expect(isTestnet()).toBe(false);
    expect(getCurrencyLabels()).toEqual({
      xch: 'XCH',
      chia: 'chia',
      mojo: 'mojo',
      mojos: 'mojos',
      MOJO: 'MOJO',
    });
  });

  it('uses T-prefixed nomenclature on testnet', () => {
    selectNetwork('testnet');
    expect(isTestnet()).toBe(true);
    expect(getCurrencyLabels()).toEqual({
      xch: 'TXCH',
      chia: 'TXCH',
      mojo: 'TMojo',
      mojos: 'TMojos',
      MOJO: 'TMOJO',
    });
  });
});

describe('formatAmount / formatMojos honor the network labels', () => {
  afterEach(() => {
    storageRepository._resetForTests();
  });

  it('formats mainnet amounts with XCH / MOJO / mojos', () => {
    selectNetwork('mainnet');
    expect(formatAmount(999_999n)).toBe('999999 MOJO');
    expect(formatAmount(1_000_000_000_000n)).toBe('1 XCH');
    expect(formatMojos(100_000_000n)).toBe('0.0001 XCH');
    expect(formatMojos(10_000_000_000n)).toBe('0.01 XCH');
    expect(formatMojos(1_000_000_000_000n)).toBe('1 XCH');
    expect(formatMojos(999n)).toBe('999 mojos');
  });

  it('formats testnet amounts with TXCH / TMOJO / TMojos', () => {
    selectNetwork('testnet');
    expect(formatAmount(999_999n)).toBe('999999 TMOJO');
    expect(formatAmount(1_000_000_000_000n)).toBe('1 TXCH');
    expect(formatMojos(100_000_000n)).toBe('0.0001 TXCH');
    expect(formatMojos(10_000_000_000n)).toBe('0.01 TXCH');
    expect(formatMojos(1_000_000_000_000n)).toBe('1 TXCH');
    expect(formatMojos(999n)).toBe('999 TMojos');
  });
});
