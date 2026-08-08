import type { Program } from 'clvm-lib';
import { calpokerRegistration } from '../features/calPoker/adapter';
import { krunkRegistration } from '../features/krunk/adapter';
import { spacepokerRegistration } from '../features/spacePoker/adapter';
import type {
  ComposeDraftFor,
  DurableGameStateEvent,
  RegisteredGameType,
  SavedTermsExtras,
} from './gameAdapter';
import type { GameStateCodec, PersistedGameState } from './session/gameStateCodec';
import type { GameTurnState, HandTermsBaseModel, HandTermsModel } from './session/types';

/**
 * The pure registration source of truth. `satisfies` makes adding a
 * RegisteredGameType fail until its complete feature registration is present.
 */
type GameRegistrationIndex = {
  [T in RegisteredGameType]: { readonly gameType: T; readonly displayName: string };
};

export const GAME_REGISTRATIONS = {
  calpoker: calpokerRegistration,
  spacepoker: spacepokerRegistration,
  krunk: krunkRegistration,
} satisfies GameRegistrationIndex;

export const REGISTERED_GAMES = Object.values(GAME_REGISTRATIONS).map(
  ({ gameType, displayName }) => ({ gameType, displayName }),
);

interface ErasedGameRegistration {
  readonly gameType: RegisteredGameType;
  readonly displayName: string;
  readonly stateCodec: GameStateCodec<unknown>;
  readonly handMembershipDescription: string;
  validateHandMembership(gameIds: readonly string[], state: unknown | null): boolean;
  decodeFeatureState(value: unknown): unknown | null;
  readonly lifecycle: {
    proposalSenderGoesFirst(iStarted: boolean): boolean;
    initialTurn(iStarted: boolean): GameTurnState;
  };
  readonly compose: {
    defaultDraft(perGameAmount: bigint): ComposeDraftFor<RegisteredGameType>;
    draftFromTerms(terms: HandTermsModel): ComposeDraftFor<RegisteredGameType>;
    updateDraft(
      current: ComposeDraftFor<RegisteredGameType>,
      update: Partial<ComposeDraftFor<RegisteredGameType>>,
    ): ComposeDraftFor<RegisteredGameType>;
    toTerms(draft: ComposeDraftFor<RegisteredGameType>, gameTimeout: bigint): HandTermsModel | null;
  };
  decodeProposalTerms(base: HandTermsBaseModel, parameterState: unknown): HandTermsModel | null;
  encodeProposalParameters(terms: HandTermsModel, iStarted: boolean): Program;
  validateTerms(terms: HandTermsModel): boolean;
  termsEqual(a: HandTermsModel, b: HandTermsModel): boolean;
  readonly persistence: {
    encodeExtras(terms: HandTermsModel): SavedTermsExtras;
    decodeExtras(base: HandTermsBaseModel, extras: SavedTermsExtras): HandTermsModel | null;
  };
  readonly durableState: {
    reduceEvent(current: unknown | null, event: DurableGameStateEvent): unknown | null;
  };
}

/**
 * TypeScript cannot retain the correlation between a dynamically selected key
 * and that registration's state/terms types. Erasure is confined to this
 * boundary; callers validate the discriminant before dispatch.
 */
function registrationFor(gameType: RegisteredGameType): ErasedGameRegistration {
  return GAME_REGISTRATIONS[gameType] as unknown as ErasedGameRegistration;
}

export function gameDisplayName(gameType: string): string {
  return isRegisteredGameType(gameType) ? GAME_REGISTRATIONS[gameType].displayName : gameType;
}

export function isRegisteredGameType(value: unknown): value is RegisteredGameType {
  return typeof value === 'string' && Object.hasOwn(GAME_REGISTRATIONS, value);
}

export function gameStateCodecFor(gameType: string): GameStateCodec<unknown> | null {
  return isRegisteredGameType(gameType) ? registrationFor(gameType).stateCodec : null;
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
  const registration = registrationFor(gameType);
  if (persisted === null) return registration.validateHandMembership(gameIds, null);
  if (persisted.gameType !== gameType) return false;
  const state = registration.stateCodec.decode(persisted);
  return state !== null && registration.validateHandMembership(gameIds, state);
}

export function gameHandMembershipDescription(gameType: RegisteredGameType): string {
  return registrationFor(gameType).handMembershipDescription;
}

export function decodeGameFeatureState(
  gameType: RegisteredGameType,
  value: unknown,
): unknown | null {
  return registrationFor(gameType).decodeFeatureState(value);
}

export function canRemountFinishedGameState(value: unknown): boolean {
  return decodePersistedGameState(value)?.canRemountFinished === true;
}

export function decodeGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  parameterState: unknown,
): HandTermsModel | null {
  return registrationFor(gameType).decodeProposalTerms(base, parameterState);
}

export function encodeGameProposalParameters(terms: HandTermsModel, iStarted: boolean): Program {
  return registrationFor(terms.gameType).encodeProposalParameters(terms, iStarted);
}

export function validateGameTerms(terms: HandTermsModel): boolean {
  return registrationFor(terms.gameType).validateTerms(terms);
}

export function gameTermsEqual(a: HandTermsModel | null, b: HandTermsModel | null): boolean {
  if (!a || !b || a.gameType !== b.gameType) return false;
  return registrationFor(a.gameType).termsEqual(a, b);
}

export function gameInitialTurn(gameType: RegisteredGameType, iStarted: boolean): GameTurnState {
  return registrationFor(gameType).lifecycle.initialTurn(iStarted);
}

export function reduceRegisteredGameState(
  gameType: RegisteredGameType,
  current: PersistedGameState | null,
  event: DurableGameStateEvent,
): PersistedGameState | null {
  const registration = registrationFor(gameType);
  if (event.type === 'feature-state' && event.gameType !== gameType) {
    throw new Error(
      `Feature-state registration mismatch: event ${event.gameType}, reducer ${gameType}`,
    );
  }
  if (event.type === 'feature-state' && current?.gameType !== gameType) {
    throw new Error(`Feature-state current state does not belong to ${gameType}`);
  }
  const decoded = current?.gameType === gameType ? registration.stateCodec.decode(current) : null;
  if (event.type === 'feature-state' && decoded === null) {
    throw new Error(`Feature-state current ${gameType} payload is invalid`);
  }
  const next = registration.durableState.reduceEvent(decoded, event);
  return next === null ? null : registration.stateCodec.encode(next);
}

export function defaultGameComposeDraft<T extends RegisteredGameType>(
  gameType: T,
  perGameAmount: bigint,
): ComposeDraftFor<T> {
  return registrationFor(gameType).compose.defaultDraft(perGameAmount) as ComposeDraftFor<T>;
}

export function gameComposeDraftFromTerms<T extends HandTermsModel>(
  terms: T,
): ComposeDraftFor<T['gameType']> {
  return registrationFor(terms.gameType).compose.draftFromTerms(terms) as ComposeDraftFor<
    T['gameType']
  >;
}

export function updateGameComposeDraft<T extends RegisteredGameType>(
  gameType: T,
  current: ComposeDraftFor<T>,
  update: Partial<ComposeDraftFor<T>>,
): ComposeDraftFor<T> {
  return registrationFor(gameType).compose.updateDraft(current, update) as ComposeDraftFor<T>;
}

export function gameTermsFromComposeDraft<T extends RegisteredGameType>(
  gameType: T,
  draft: ComposeDraftFor<T>,
  gameTimeout: bigint,
): Extract<HandTermsModel, { gameType: T }> | null {
  return registrationFor(gameType).compose.toTerms(draft, gameTimeout) as Extract<
    HandTermsModel,
    { gameType: T }
  > | null;
}

export function encodeGameTermsExtras(terms: HandTermsModel): SavedTermsExtras {
  return registrationFor(terms.gameType).persistence.encodeExtras(terms);
}

export function decodePersistedGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  extras: SavedTermsExtras,
): HandTermsModel | null {
  return registrationFor(gameType).persistence.decodeExtras(base, extras);
}
