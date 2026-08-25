import { GENERATED_GAME_PACKAGES, GENERATED_GAME_PACKAGES_BY_KEY } from '../generated/gamePackages';
import type { CatalogGameType } from '../generated/gamePresets';
import type {
  ComposeDraftValue,
  GameHandInitialization,
  HandProposalDecodeContext,
  HandProposal as HostHandProposal,
  PersistedGameState,
  ProposalParameterValue,
} from '@games/host';
import type { RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
export type { GameComposeDrafts, RegisteredGameHand, RegisteredGamePackage } from './gamePackage';
import type { HandProposalBase, HandProposal } from './session/types';
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
  return handProposalWithCatalogType(
    registration,
    registration.decodeHandProposal(base, parameterState, context),
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
  return packageFor(handProposal.gameType).describeHandProposal(handProposal);
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

/**
 * Deterministic codec context for persisted normalized proposal terms.
 * It does not preserve or reconstruct the live proposal direction.
 */
const PERSISTED_HAND_PROPOSAL_CODEC_CONTEXT = {
  origin: 'local',
  iStarted: false,
} as const;

export function encodePersistedHandProposalParameters(
  handProposal: HandProposal,
): ProposalParameterValue {
  return packageFor(handProposal.gameType).encodeProposalParameters(
    handProposal,
    PERSISTED_HAND_PROPOSAL_CODEC_CONTEXT.iStarted,
  );
}

export function decodePersistedHandProposal(
  gameType: RegisteredGameType,
  base: HandProposalBase,
  parameterState: unknown,
): HandProposal | null {
  return decodeHandProposal(gameType, base, parameterState, PERSISTED_HAND_PROPOSAL_CODEC_CONTEXT);
}
