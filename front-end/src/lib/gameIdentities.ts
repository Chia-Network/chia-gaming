import { PRODUCTION_PACKAGE_KEYS, type CatalogGameType } from '../generated/gamePresets';
import type { ProtocolGameId } from '../types/ChiaGaming';

export type GamePackageIdentity = { key: string; id: string };

type GameIdentityWasm = {
  registered_game_packages: () => GamePackageIdentity[];
};

const protocolIdByCatalog = new Map<CatalogGameType, ProtocolGameId>();
const catalogByProtocolId = new Map<string, CatalogGameType>();

function isProductionKey(key: string): key is CatalogGameType {
  return (PRODUCTION_PACKAGE_KEYS as readonly string[]).includes(key);
}

function asProtocolGameId(id: string): ProtocolGameId {
  return id as ProtocolGameId;
}

function writeIdentity(key: string, id: string): void {
  if (!isProductionKey(key)) throw new Error(`Unknown game package ${key}`);
  const previous = protocolIdByCatalog.get(key);
  if (previous !== undefined) catalogByProtocolId.delete(previous);
  const protocolId = asProtocolGameId(id);
  protocolIdByCatalog.set(key, protocolId);
  catalogByProtocolId.set(protocolId, key);
}

export function setProtocolIds(ids: readonly GamePackageIdentity[]): void {
  protocolIdByCatalog.clear();
  catalogByProtocolId.clear();
  for (const { key, id } of ids) {
    writeIdentity(key, id);
  }
}

export function resetProtocolIds(): void {
  protocolIdByCatalog.clear();
  catalogByProtocolId.clear();
}

export function protocolIdentitiesReady(): boolean {
  return PRODUCTION_PACKAGE_KEYS.every((key) => protocolIdByCatalog.has(key));
}

export function protocolIdForCatalog(gameType: CatalogGameType): ProtocolGameId {
  const id = protocolIdByCatalog.get(gameType);
  if (id === undefined) {
    throw new Error(`No protocol identity for ${gameType}`);
  }
  return id;
}

/** Notify seam: first-member validation puzzle hash → local catalog key. */
export function catalogGameTypeFromWire(value: string): CatalogGameType | null {
  const catalog = catalogByProtocolId.get(value);
  return catalog === undefined ? null : catalog;
}

export function _resetGameIdentityWarmupForTests(): void {
  resetProtocolIds();
}

function record(row: GamePackageIdentity): void {
  writeIdentity(row.key, row.id);
}

/** Bind the protocol identities calculated by the package build. */
export function completeRegisteredGames(wasm: GameIdentityWasm): GamePackageIdentity[] {
  if (protocolIdentitiesReady()) {
    return snapshotWarmed();
  }
  for (const row of wasm.registered_game_packages()) {
    record(row);
  }
  return snapshotWarmed();
}

function snapshotWarmed(): GamePackageIdentity[] {
  return PRODUCTION_PACKAGE_KEYS.map((key) => {
    const id = protocolIdByCatalog.get(key);
    if (id === undefined) {
      throw new Error(`Missing built identity for ${key}`);
    }
    return { key, id };
  });
}
