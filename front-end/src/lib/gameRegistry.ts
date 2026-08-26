import { GENERATED_GAME_PACKAGES, GENERATED_GAME_PACKAGES_BY_KEY } from '../generated/gamePackages';
import type { CatalogGameType } from '../generated/gamePresets';
import type {
  GameHandInitialization,
  PersistedGameState,
  ProposalParameterValue,
} from '@games/host';
import type { RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
export type { RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
import type { HandProposal } from './session/types';
import type { SessionModel } from './session/types';

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

export const REGISTERED_GAMES = GAME_PACKAGES.map((pkg) => {
  if (!isCatalogGameType(pkg.gameType)) {
    throw new Error(`Generated package has non-catalog gameType ${pkg.gameType}`);
  }
  return { gameType: pkg.gameType, displayName: pkg.displayName };
});

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

export function handProposalsEqual(a: HandProposal | null, b: HandProposal | null): boolean {
  if (!a || !b || a.gameType !== b.gameType) return false;
  return packageFor(a.gameType).handProposalsEqual(a, b);
}

export function describeReceivedProposal(handProposal: HandProposal): string {
  return packageFor(handProposal.gameType).describeHandProposal(handProposal);
}
