import { PRODUCTION_PACKAGE_KEYS, type CatalogGameType } from '../generated/gamePresets';
import type { ProtocolGameId } from '../types/ChiaGaming';

export type GamePackageIdentity = { key: string; id: string };

type GameWarmWasm = {
  warm_game_package?: (key: string) => GamePackageIdentity;
  registered_game_packages: () => GamePackageIdentity[];
};

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let warmPromise: Promise<GamePackageIdentity[]> | null = null;
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

/** Notify seam: factory hash → catalog key. Catalog strings on the wire are garbled. */
export function catalogGameTypeFromWire(value: string): CatalogGameType | null {
  const catalog = catalogByProtocolId.get(value);
  return catalog === undefined ? null : catalog;
}

export function _resetGameIdentityWarmupForTests(): void {
  warmPromise = null;
  resetProtocolIds();
}

function record(row: GamePackageIdentity): void {
  writeIdentity(row.key, row.id);
}

/** Finish any remaining factory probes on this turn. Cheap if page-load warmup already ran. */
export function completeRegisteredGames(wasm: GameWarmWasm): GamePackageIdentity[] {
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
      throw new Error(`Missing warmed identity for ${key}`);
    }
    return { key, id };
  });
}

/**
 * Probe factories one package at a time, yielding to the event loop between
 * them so the hub UI stays responsive during Krunk's large dictionary curry.
 */
export function warmRegisteredGames(wasm: GameWarmWasm): Promise<GamePackageIdentity[]> {
  const warmOne = wasm.warm_game_package;
  if (!warmOne) {
    return Promise.resolve(completeRegisteredGames(wasm));
  }
  if (!warmPromise) {
    warmPromise = (async () => {
      try {
        for (const key of PRODUCTION_PACKAGE_KEYS) {
          if (protocolIdByCatalog.has(key)) continue;
          await yieldToEventLoop();
          if (protocolIdByCatalog.has(key)) continue;
          record(warmOne(key));
        }
        return completeRegisteredGames(wasm);
      } catch (err) {
        warmPromise = null;
        throw err;
      }
    })();
  }
  return warmPromise;
}
