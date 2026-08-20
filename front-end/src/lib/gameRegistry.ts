import type { Program } from 'clvm-lib';
import { GENERATED_GAME_PACKAGES } from '../generated/gamePackages';
import type { CatalogGameType } from '../generated/gamePresets';
import type {
  ComposeDraftValue,
  DurableGameStateEvent,
  GamePackage,
  HandTermsModel as HostHandTermsModel,
  SavedTermsExtras,
} from '@games/host';
import type { GameStateCodec, PersistedGameState } from './session/gameStateCodec';
import type { HandTermsBaseModel, HandTermsModel } from './session/types';
import { formatMojos } from '../util';

export type { CatalogGameType } from '../generated/gamePresets';
export type RegisteredGameType = CatalogGameType;

const packagesByCatalog = new Map<string, GamePackage>();

for (const pkg of GENERATED_GAME_PACKAGES) {
  packagesByCatalog.set(pkg.gameType, pkg as unknown as GamePackage);
}

export const GAME_PACKAGES: readonly GamePackage[] =
  GENERATED_GAME_PACKAGES as unknown as GamePackage[];

export function packageFor(gameType: CatalogGameType): GamePackage {
  const pkg = packagesByCatalog.get(gameType);
  if (!pkg) throw new Error(`Unsupported game package: ${gameType}`);
  return pkg;
}

export function gameDisplayName(gameType: CatalogGameType): string {
  return packageFor(gameType).displayName;
}

/** Catalog names only (`calpoker`, …). Saves and mounts use this — hashes are garbled. */
export function isCatalogGameType(value: unknown): value is CatalogGameType {
  return typeof value === 'string' && packagesByCatalog.has(value);
}

export const REGISTERED_GAMES = GAME_PACKAGES.map((pkg) => {
  if (!isCatalogGameType(pkg.gameType)) {
    throw new Error(`Generated package has non-catalog gameType ${pkg.gameType}`);
  }
  return { gameType: pkg.gameType, displayName: pkg.displayName };
});

export function gameStateCodecFor(gameType: string): GameStateCodec<unknown> | null {
  return isCatalogGameType(gameType) ? packageFor(gameType).stateCodec : null;
}

export interface DecodedPersistedGameState {
  persisted: PersistedGameState;
  gameIds: readonly string[];
  canRemountFinished: boolean;
}

/** Validate and canonicalize a game-owned payload exactly once. */
export function decodePersistedGameState(value: unknown): DecodedPersistedGameState | null {
  if (typeof value !== 'object' || value === null) return null;
  const gameType = (value as Partial<PersistedGameState>).gameType;
  if (typeof gameType !== 'string') return null;
  const codec = gameStateCodecFor(gameType);
  const state = codec?.decode(value);
  return codec && state !== null
    ? {
        persisted: codec.encode(state),
        gameIds: codec.gameIds(state),
        canRemountFinished: codec.canRemountFinished,
      }
    : null;
}

export function validateGameHandMembership(
  gameType: RegisteredGameType,
  gameIds: readonly string[],
  persisted: PersistedGameState | null,
): boolean {
  const registration = packageFor(gameType);
  if (persisted === null) return registration.validateHandMembership(gameIds, null);
  if (persisted.gameType !== gameType) {
    return false;
  }
  const state = registration.stateCodec.decode(persisted);
  return state !== null && registration.validateHandMembership(gameIds, state);
}

export function gameHandMembershipDescription(gameType: RegisteredGameType): string {
  return packageFor(gameType).handMembershipDescription;
}

export function decodeGameFeatureState(
  gameType: RegisteredGameType,
  value: unknown,
): unknown | null {
  return packageFor(gameType).decodeFeatureState(value);
}

export function canRemountFinishedGameState(value: unknown): boolean {
  return decodePersistedGameState(value)?.canRemountFinished === true;
}

function termsWithCatalogType(
  registration: GamePackage,
  terms: HostHandTermsModel | null,
): HandTermsModel | null {
  if (terms === null) return null;
  if (terms.gameType !== registration.gameType) {
    throw new Error(`Package ${registration.gameType} decoded terms as ${terms.gameType}`);
  }
  if (!isCatalogGameType(terms.gameType)) {
    throw new Error(`Package ${registration.gameType} decoded a non-catalog gameType`);
  }
  return { ...terms, gameType: terms.gameType };
}

export function decodeGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  parameterState: unknown,
): HandTermsModel | null {
  const registration = packageFor(gameType);
  const params = registration.factoryParameters.decode(parameterState);
  return params === null
    ? null
    : termsWithCatalogType(registration, registration.decodeProposalTerms(base, params));
}

export function encodeGameProposalParameters(terms: HandTermsModel, iStarted: boolean): Program {
  const registration = packageFor(terms.gameType);
  return registration.factoryParameters.encode(registration.toFactoryParameters(terms, iStarted));
}

export function validateGameTerms(terms: HandTermsModel): boolean {
  return packageFor(terms.gameType).validateTerms(terms);
}

export function gameTermsEqual(a: HandTermsModel | null, b: HandTermsModel | null): boolean {
  if (!a || !b || a.gameType !== b.gameType) return false;
  return packageFor(a.gameType).termsEqual(a, b);
}

export function describeReceivedProposal(terms: HandTermsModel): string {
  return packageFor(terms.gameType).describeTerms(terms, { formatMojos });
}

export function reduceRegisteredGameState(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  event: DurableGameStateEvent,
): PersistedGameState | null {
  const registration = packageFor(gameType);
  if (event.type === 'feature-state' && event.gameType !== gameType) {
    throw new Error(
      `Feature-state registration mismatch: event ${event.gameType}, reducer ${gameType}`,
    );
  }
  if (event.type === 'feature-state' && current !== null && current.gameType !== gameType) {
    throw new Error(`Feature-state current state does not belong to ${gameType}`);
  }
  const decoded =
    current !== null && current.gameType === gameType
      ? registration.stateCodec.decode(current)
      : null;
  if (event.type === 'feature-state' && decoded === null) {
    throw new Error(`Feature-state current ${gameType} payload is invalid`);
  }
  const next = registration.durableState.reduceEvent(decoded, event);
  if (next === null) return null;
  if (!registration.stateCodec.isState(next)) {
    throw new Error(`Internal ${gameType} reducer produced invalid feature state`);
  }
  return registration.stateCodec.encode(next);
}

export function defaultGameComposeDraft(
  gameType: RegisteredGameType,
  perGameAmount: bigint,
): ComposeDraftValue {
  return packageFor(gameType).compose.defaultDraft(perGameAmount);
}

export function gameComposeDraftFromTerms(terms: HandTermsModel): ComposeDraftValue {
  return packageFor(terms.gameType).compose.draftFromTerms(terms);
}

export function updateGameComposeDraft(
  gameType: RegisteredGameType,
  current: ComposeDraftValue,
  update: Partial<ComposeDraftValue>,
): ComposeDraftValue {
  return packageFor(gameType).compose.updateDraft(current, update);
}

export function gameTermsFromComposeDraft(
  gameType: RegisteredGameType,
  draft: ComposeDraftValue,
  gameTimeout: bigint,
): HandTermsModel | null {
  const registration = packageFor(gameType);
  return termsWithCatalogType(registration, registration.compose.toTerms(draft, gameTimeout));
}

export function encodeGameTermsExtras(terms: HandTermsModel): SavedTermsExtras {
  return packageFor(terms.gameType).persistence.encodeExtras(terms);
}

export function decodePersistedGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  extras: SavedTermsExtras,
): HandTermsModel | null {
  const registration = packageFor(gameType);
  return termsWithCatalogType(registration, registration.persistence.decodeExtras(base, extras));
}
