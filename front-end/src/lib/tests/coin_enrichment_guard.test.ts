import {
  createCoinEnrichmentRegistry,
  nextChannelCoinEnrichment,
  nextGameInstanceCoinEnrichment,
  nextLegacyGameCoinEnrichment,
  nextSessionTerminalCoinEnrichment,
} from '../../hooks/useGameSession';

describe('coin enrichment generations', () => {
  it('invalidates older channel and session-terminal enrichments', () => {
    const registry = createCoinEnrichmentRegistry();

    expect(nextChannelCoinEnrichment(registry)).toBe(1);
    expect(nextChannelCoinEnrichment(registry)).toBe(2);
    expect(registry.channel).toBe(2);

    expect(nextSessionTerminalCoinEnrichment(registry)).toBe(1);
    expect(nextSessionTerminalCoinEnrichment(registry)).toBe(2);
    expect(registry.sessionTerminal).toBe(2);
  });

  it('tracks independent games while invalidating stale legacy coin updates', () => {
    const registry = createCoinEnrichmentRegistry();

    expect(nextGameInstanceCoinEnrichment(registry, 'a')).toBe(1);
    expect(nextGameInstanceCoinEnrichment(registry, 'b')).toBe(1);
    expect(nextGameInstanceCoinEnrichment(registry, 'a')).toBe(2);
    expect(registry.gameInstances).toEqual({ a: 2, b: 1 });

    expect(nextLegacyGameCoinEnrichment(registry)).toBe(1);
    expect(nextLegacyGameCoinEnrichment(registry)).toBe(2);
    expect(registry.legacyGameCoin).toBe(2);
  });
});
