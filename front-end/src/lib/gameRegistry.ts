import { GENERATED_GAME_PACKAGES, GENERATED_GAME_PACKAGES_BY_KEY } from '../generated/gamePackages';
import { PRODUCTION_PACKAGE_KEYS, type CatalogGameType } from '../generated/gamePresets';
import type {
  GameHandInitialization,
  PersistedGameState,
  ProposalParameterValue,
} from '@games/host';
import type { RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
export type { RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
import type { HandProposal } from './session/types';
import type { SessionModel } from './session/types';
import type { ProposalGroupOrigin } from './session/proposalOrigin';

export type { CatalogGameType } from '../generated/gamePresets';
export type RegisteredGameType = CatalogGameType;

export const GAME_PACKAGES: readonly RegisteredGamePackage[] = GENERATED_GAME_PACKAGES;

export function packageFor(gameType: CatalogGameType): RegisteredGamePackage {
  return GENERATED_GAME_PACKAGES_BY_KEY[gameType];
}

export function gameDisplayName(gameType: CatalogGameType): string {
  return packageFor(gameType).displayName;
}

/** Catalog names only (`calpoker`, …). Saves and mounts use this — hashes are garbled. */
export function isCatalogGameType(value: unknown): value is CatalogGameType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(GENERATED_GAME_PACKAGES_BY_KEY, value)
  );
}

export const DEFAULT_CATALOG_GAME_TYPE = PRODUCTION_PACKAGE_KEYS[0];

export const REGISTERED_GAMES = PRODUCTION_PACKAGE_KEYS.map((gameType) => ({
  gameType,
  displayName: packageFor(gameType).displayName,
}));

export interface DecodedPersistedGameState {
  persisted: PersistedGameState;
}

/** Decode only the generic host envelope; the game-owned state remains opaque. */
export function decodePersistedGameState(value: unknown): DecodedPersistedGameState | null {
  if (typeof value !== 'object' || value === null) return null;
  const persisted = value as Partial<PersistedGameState>;
  if (!isCatalogGameType(persisted.gameType) || !Object.hasOwn(persisted, 'state')) return null;
  return {
    persisted: { gameType: persisted.gameType, state: persisted.state },
  };
}

export function createRegisteredGameHand(
  gameType: RegisteredGameType,
  init: GameHandInitialization,
): RegisteredGameHand {
  return packageFor(gameType).createHand(init);
}

export function restoreRegisteredGameHandState(
  gameType: RegisteredGameType,
  persisted: PersistedGameState,
): RegisteredGameHand {
  if (persisted.gameType !== gameType) {
    throw new Error(`Saved ${persisted.gameType} state cannot restore ${gameType}`);
  }
  return packageFor(gameType).restoreHand(persisted.state);
}

export function snapshotRegisteredGameHand(
  gameType: RegisteredGameType,
  hand: RegisteredGameHand,
): PersistedGameState {
  return { gameType, state: hand.getState() };
}

export function restoreRegisteredGameHand(model: SessionModel): RegisteredGameHand | null {
  const { game } = model;
  if (game.handState === null) return null;
  return restoreRegisteredGameHandState(game.activeGameType, game.handState);
}

export function isProposalParameterValue(value: unknown): value is ProposalParameterValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array ||
    (Array.isArray(value) && value.every(isProposalParameterValue))
  );
}

export function validateHandProposal(handProposal: HandProposal): boolean {
  return (
    isCatalogGameType(handProposal.gameType) &&
    typeof handProposal.playerAContribution === 'bigint' &&
    handProposal.playerAContribution > 0n &&
    typeof handProposal.playerBContribution === 'bigint' &&
    handProposal.playerBContribution > 0n &&
    typeof handProposal.senderIsPlayerA === 'boolean' &&
    typeof handProposal.gameTimeout === 'bigint' &&
    handProposal.gameTimeout > 0n &&
    isProposalParameterValue(handProposal.parameters)
  );
}

function proposalParameterValuesEqual(
  a: ProposalParameterValue,
  b: ProposalParameterValue,
): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => proposalParameterValuesEqual(value, b[index]))
    );
  }
  return a === b;
}

export function handProposalsEqual(
  a: HandProposal | null,
  aOrigin: ProposalGroupOrigin | null,
  b: HandProposal | null,
  bOrigin: ProposalGroupOrigin | null,
): boolean {
  if (!a || !b || !aOrigin || !bOrigin || a.gameType !== b.gameType) return false;
  const localIsPlayerAForA = (aOrigin === 'local') === a.senderIsPlayerA;
  const localIsPlayerAForB = (bOrigin === 'local') === b.senderIsPlayerA;
  return (
    a.playerAContribution === b.playerAContribution &&
    a.playerBContribution === b.playerBContribution &&
    localIsPlayerAForA === localIsPlayerAForB &&
    a.gameTimeout === b.gameTimeout &&
    proposalParameterValuesEqual(a.parameters, b.parameters)
  );
}

export function describeReceivedProposal(handProposal: HandProposal): string {
  return packageFor(handProposal.gameType).describeHandProposal(handProposal);
}
