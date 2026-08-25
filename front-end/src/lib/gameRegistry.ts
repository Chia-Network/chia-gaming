import { GENERATED_GAME_PACKAGES, GENERATED_GAME_PACKAGES_BY_KEY } from '../generated/gamePackages';
import type { CatalogGameType } from '../generated/gamePresets';
import type {
  ComposeDraftValue,
  GameHandInitialization,
  HandProposalDecodeContext,
  HandProposal as HostHandProposal,
  PersistedGameState,
  RegisteredGameHand,
  RegisteredGamePackage,
  SavedHandProposalExtras,
} from '@games/host';
import type { HandProposalBase, HandProposal } from './session/types';
import type { SessionModel } from './session/types';
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

export interface DecodedPersistedGameState {
  persisted: PersistedGameState;
  canRemountFinished: boolean;
}

/** Decode only the generic host envelope; the game-owned state remains opaque. */
export function decodePersistedGameState(value: unknown): DecodedPersistedGameState | null {
  if (typeof value !== 'object' || value === null) return null;
  const persisted = value as Partial<PersistedGameState>;
  if (!isCatalogGameType(persisted.gameType) || !Object.hasOwn(persisted, 'state')) return null;
  return {
    persisted: { gameType: persisted.gameType, state: persisted.state },
    canRemountFinished: packageFor(persisted.gameType).canRemountFinished,
  };
}

export function createRegisteredGameHand(
  gameType: RegisteredGameType,
  init: GameHandInitialization,
  persisted: PersistedGameState | null = null,
): RegisteredGameHand {
  const hand = packageFor(gameType).createHand(init);
  if (persisted !== null) {
    if (persisted.gameType !== gameType) {
      throw new Error(`Saved ${persisted.gameType} state cannot initialize ${gameType}`);
    }
    hand.setInitialState(persisted.state);
  }
  return hand;
}

export function snapshotRegisteredGameHand(
  gameType: RegisteredGameType,
  hand: RegisteredGameHand,
): PersistedGameState {
  return { gameType, state: hand.getState() };
}

export function restoreRegisteredGameHand(
  model: SessionModel,
  iStarted: boolean,
): RegisteredGameHand | null {
  const { game } = model;
  const handProposal = model.betweenHand.lastHandProposal;
  const id = game.currentHandIds[0];
  if (game.handState === null || handProposal === null || id === undefined) return null;
  return createRegisteredGameHand(
    game.activeGameType,
    {
      gameIds: game.currentHandIds,
      iStarted,
      origin: game.currentHandOrigin ?? 'local',
      handProposal,
    },
    game.handState,
  );
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

export function selectRegisteredGameOutcome(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  gameId: string,
): 'win' | 'lose' | 'tie' | null {
  const registration = packageFor(gameType);
  return current?.gameType !== gameType
    ? null
    : (registration.selectOutcome(current.state, gameId)?.my_win_outcome ?? null);
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
