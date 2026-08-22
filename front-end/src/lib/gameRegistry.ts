import { GENERATED_GAME_PACKAGES, GENERATED_GAME_PACKAGES_BY_KEY } from '../generated/gamePackages';
import type { CatalogGameType } from '../generated/gamePresets';
import type {
  ComposeDraftValue,
  GameInput,
  HandProposalDecodeContext,
  HandProposal as HostHandProposal,
  RegisteredGamePackage,
  SavedHandProposalExtras,
} from '@games/host';
import type { GameStateCodec, PersistedGameState } from './session/gameStateCodec';
import type { HandProposalBase, HandProposal } from './session/types';
import type { PendingGameCandidate } from './session/types';
import { formatMojos } from '../util';

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

function handProposalWithCatalogType(
  registration: RegisteredGamePackage,
  handProposal: HostHandProposal | null,
): HandProposal | null {
  if (handProposal === null) return null;
  if (handProposal.gameType !== registration.gameType) {
    throw new Error(
      `Package ${registration.gameType} decoded hand proposal as ${handProposal.gameType}`,
    );
  }
  if (!isCatalogGameType(handProposal.gameType)) {
    throw new Error(`Package ${registration.gameType} decoded a non-catalog gameType`);
  }
  return { ...handProposal, gameType: handProposal.gameType };
}

export function decodeHandProposal(
  gameType: RegisteredGameType,
  base: HandProposalBase,
  parameterState: unknown,
  context: Pick<HandProposalDecodeContext, 'iStarted' | 'origin'>,
): HandProposal | null {
  const registration = packageFor(gameType);
  const proposerStarted = context.origin === 'local' ? context.iStarted : !context.iStarted;
  const decodeContext: HandProposalDecodeContext = {
    ...context,
    expectedSenderGoesFirst: registration.lifecycle.proposalSenderGoesFirst(proposerStarted),
  };
  return handProposalWithCatalogType(
    registration,
    registration.decodeHandProposal(base, parameterState, decodeContext),
  );
}

export function validateHandProposal(handProposal: HandProposal): boolean {
  return packageFor(handProposal.gameType).validateHandProposal(handProposal);
}

export function handProposalsEqual(a: HandProposal | null, b: HandProposal | null): boolean {
  if (!a || !b || a.gameType !== b.gameType) return false;
  return packageFor(a.gameType).handProposalsEqual(a, b);
}

export function describeReceivedProposal(handProposal: HandProposal): string {
  return packageFor(handProposal.gameType).describeHandProposal(handProposal, { formatMojos });
}

export function reduceRegisteredGameState(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  input: GameInput,
): PersistedGameState | null {
  const registration = packageFor(gameType);
  const decoded =
    current !== null && current.gameType === gameType
      ? registration.stateCodec.decode(current)
      : null;
  let next: unknown;
  if (input.type === 'hand-started') {
    next = registration.durableState.initialize(decoded, input);
  } else {
    if (decoded === null) {
      throw new Error(`Internal ${gameType} ${input.type} input requires valid hand state`);
    }
    next = registration.durableState.reduceInput(decoded, input);
  }
  if (!registration.stateCodec.isState(next)) {
    throw new Error(`Internal ${gameType} reducer produced invalid feature state`);
  }
  return registration.stateCodec.encode(next);
}

export function applyRegisteredFeatureState(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  gameId: string,
  value: unknown,
): PersistedGameState {
  const registration = packageFor(gameType);
  const decoded = current?.gameType === gameType ? registration.stateCodec.decode(current) : null;
  if (decoded === null) {
    throw new Error(`Feature-state current ${gameType} payload is invalid`);
  }
  const featureState = registration.decodeFeatureState(value);
  if (featureState === null) {
    throw new Error(`Invalid ${gameType} feature-state payload`);
  }
  const next = registration.durableState.applyFeatureState(decoded, gameId, featureState);
  if (!registration.stateCodec.isState(next)) {
    throw new Error(`Internal ${gameType} reducer produced invalid feature state`);
  }
  return registration.stateCodec.encode(next);
}

export function projectRegisteredPendingCandidates(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  currentHandIds: readonly string[],
  pendingCandidates: Readonly<Record<string, PendingGameCandidate>>,
): PersistedGameState | null {
  let projected = current;
  for (const id of currentHandIds) {
    const pending = pendingCandidates[id];
    if (!pending) continue;
    if (pending.gameType !== gameType || pending.id !== id) {
      throw new Error(`Internal pending candidate identity mismatch for game ${id}`);
    }
    projected = applyRegisteredFeatureState(gameType, projected, id, pending.featureState);
  }
  return projected;
}

export function selectRegisteredGameOutcome(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  gameId: string,
): 'win' | 'lose' | 'tie' | null {
  const registration = packageFor(gameType);
  const decoded = current?.gameType === gameType ? registration.stateCodec.decode(current) : null;
  return decoded === null
    ? null
    : (registration.selectOutcome(decoded, gameId)?.my_win_outcome ?? null);
}

export function defaultGameComposeDraft(
  gameType: RegisteredGameType,
  perGameAmount: bigint,
): ComposeDraftValue {
  return packageFor(gameType).draft.default(perGameAmount);
}

export function gameComposeDraftFromHandProposal(handProposal: HandProposal): ComposeDraftValue {
  return packageFor(handProposal.gameType).draft.fromHandProposal(handProposal);
}

export function updateGameComposeDraft(
  gameType: RegisteredGameType,
  current: ComposeDraftValue,
  update: Partial<ComposeDraftValue>,
): ComposeDraftValue {
  return packageFor(gameType).draft.update(current, update);
}

export function handProposalFromComposeDraft(
  gameType: RegisteredGameType,
  draft: ComposeDraftValue,
  gameTimeout: bigint,
): HandProposal | null {
  const registration = packageFor(gameType);
  return handProposalWithCatalogType(
    registration,
    registration.draft.toHandProposal(draft, gameTimeout),
  );
}

export function encodeHandProposalExtras(handProposal: HandProposal): SavedHandProposalExtras {
  return packageFor(handProposal.gameType).persistence.encodeExtras(handProposal);
}

export function decodePersistedHandProposal(
  gameType: RegisteredGameType,
  base: HandProposalBase,
  extras: SavedHandProposalExtras,
): HandProposal | null {
  const registration = packageFor(gameType);
  return handProposalWithCatalogType(
    registration,
    registration.persistence.decodeExtras(base, extras),
  );
}
