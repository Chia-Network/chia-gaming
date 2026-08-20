import type { ProtocolGameId } from '../../types/ChiaGaming';

export const TEST_PROTOCOL_IDS = [
  { key: 'calpoker', id: 'aa'.repeat(32) },
  { key: 'spacepoker', id: 'bb'.repeat(32) },
  { key: 'krunk', id: 'cc'.repeat(32) },
] as const;

export type TestCatalogGameType = (typeof TEST_PROTOCOL_IDS)[number]['key'];

export function testProtocolId(gameType: TestCatalogGameType): ProtocolGameId {
  const row = TEST_PROTOCOL_IDS.find((entry) => entry.key === gameType);
  if (row === undefined) {
    throw new Error(`No test protocol id for ${gameType}`);
  }
  return row.id as ProtocolGameId;
}

export function mockGamePackageIdentity(key: string): { key: string; id: string } {
  const row = TEST_PROTOCOL_IDS.find((entry) => entry.key === key);
  if (row === undefined) {
    throw new Error(`Unknown test package ${key}`);
  }
  return { key: row.key, id: row.id };
}
