import type { Program } from 'clvm-lib';
import { calpokerAdapter } from '../features/calPoker/adapter';
import { krunkAdapter } from '../features/krunk/adapter';
import { spacepokerAdapter } from '../features/spacePoker/adapter';
import type { RegisteredGameType, SavedTermsExtras } from './gameAdapter';
import type { GameStateCodec, PersistedGameState } from './session/gameStateCodec';
import type { GameTurnState, HandTermsBaseModel, HandTermsModel } from './session/types';

export interface GameRegistryEntry {
  gameType: RegisteredGameType;
  displayName: string;
  stateCodec: GameStateCodec<unknown>;
}

function registryEntry<T>(
  adapter: Readonly<{
    gameType: RegisteredGameType;
    displayName: string;
    stateCodec: GameStateCodec<T>;
  }>,
): GameRegistryEntry {
  return {
    gameType: adapter.gameType,
    displayName: adapter.displayName,
    stateCodec: adapter.stateCodec as GameStateCodec<unknown>,
  };
}

export const GAME_ADAPTERS = [calpokerAdapter, spacepokerAdapter, krunkAdapter] as const;
export const GAME_REGISTRY: readonly GameRegistryEntry[] = [
  registryEntry(calpokerAdapter),
  registryEntry(spacepokerAdapter),
  registryEntry(krunkAdapter),
];

const REGISTRY_BY_TYPE: ReadonlyMap<string, GameRegistryEntry> = new Map(
  GAME_REGISTRY.map((entry) => [entry.gameType, entry]),
);
export const GAME_TYPE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  GAME_REGISTRY.map(({ gameType, displayName }) => [gameType, displayName]),
);

export function gameDisplayName(gameType: string): string {
  return REGISTRY_BY_TYPE.get(gameType)?.displayName ?? gameType;
}

export function isRegisteredGameType(value: unknown): value is RegisteredGameType {
  return typeof value === 'string' && REGISTRY_BY_TYPE.has(value);
}

export function gameStateCodecFor(gameType: string): GameStateCodec<unknown> | null {
  return REGISTRY_BY_TYPE.get(gameType)?.stateCodec ?? null;
}

export function decodePersistedGameState(value: unknown): PersistedGameState | null {
  if (typeof value !== 'object' || value === null) return null;
  const gameType = (value as Partial<PersistedGameState>).gameType;
  if (typeof gameType !== 'string') return null;
  const codec = gameStateCodecFor(gameType);
  const state = codec?.decode(value);
  return codec && state !== null ? codec.encode(state) : null;
}

export function persistedGameStateIds(value: unknown): readonly string[] | null {
  const persisted = decodePersistedGameState(value);
  if (!persisted) return null;
  const codec = gameStateCodecFor(persisted.gameType);
  const state = codec?.decode(persisted);
  return codec && state !== null ? codec.gameIds(state) : null;
}

export function canRemountFinishedGameState(value: unknown): boolean {
  const persisted = decodePersistedGameState(value);
  return persisted !== null && gameStateCodecFor(persisted.gameType)?.canRemountFinished === true;
}

export function decodeGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  parameterState: unknown,
): HandTermsModel | null {
  switch (gameType) {
    case 'calpoker':
      return calpokerAdapter.decodeProposalTerms(base, parameterState);
    case 'spacepoker':
      return spacepokerAdapter.decodeProposalTerms(base, parameterState);
    case 'krunk':
      return krunkAdapter.decodeProposalTerms(base, parameterState);
  }
}

export function encodeGameProposalParameters(terms: HandTermsModel, iStarted: boolean): Program {
  switch (terms.gameType) {
    case 'calpoker':
      return calpokerAdapter.encodeProposalParameters(terms, iStarted);
    case 'spacepoker':
      return spacepokerAdapter.encodeProposalParameters(terms, iStarted);
    case 'krunk':
      return krunkAdapter.encodeProposalParameters(terms, iStarted);
  }
}

export function validateGameTerms(terms: HandTermsModel): boolean {
  switch (terms.gameType) {
    case 'calpoker':
      return calpokerAdapter.validateTerms(terms);
    case 'spacepoker':
      return spacepokerAdapter.validateTerms(terms);
    case 'krunk':
      return krunkAdapter.validateTerms(terms);
  }
}

export function gameTermsEqual(a: HandTermsModel | null, b: HandTermsModel | null): boolean {
  if (!a || !b || a.gameType !== b.gameType) return false;
  switch (a.gameType) {
    case 'calpoker':
      return b.gameType === 'calpoker' && calpokerAdapter.termsEqual(a, b);
    case 'spacepoker':
      return b.gameType === 'spacepoker' && spacepokerAdapter.termsEqual(a, b);
    case 'krunk':
      return b.gameType === 'krunk' && krunkAdapter.termsEqual(a, b);
  }
}

export function gameInitialTurn(gameType: RegisteredGameType, iStarted: boolean): GameTurnState {
  switch (gameType) {
    case 'calpoker':
      return calpokerAdapter.lifecycle.initialTurn(iStarted);
    case 'spacepoker':
      return spacepokerAdapter.lifecycle.initialTurn(iStarted);
    case 'krunk':
      return krunkAdapter.lifecycle.initialTurn(iStarted);
  }
}

export function gameComposeDefaultAmount(
  gameType: RegisteredGameType,
  currentGameType: RegisteredGameType,
  currentAmount: bigint,
): bigint {
  switch (gameType) {
    case 'calpoker':
      return calpokerAdapter.compose.defaultAmount(currentGameType, currentAmount);
    case 'spacepoker':
      return spacepokerAdapter.compose.defaultAmount(currentGameType, currentAmount);
    case 'krunk':
      return krunkAdapter.compose.defaultAmount(currentGameType, currentAmount);
  }
}

export function encodeGameTermsExtras(terms: HandTermsModel): SavedTermsExtras {
  switch (terms.gameType) {
    case 'calpoker':
      return calpokerAdapter.persistence.encodeExtras(terms);
    case 'spacepoker':
      return spacepokerAdapter.persistence.encodeExtras(terms);
    case 'krunk':
      return krunkAdapter.persistence.encodeExtras(terms);
  }
}

export function decodePersistedGameTerms(
  gameType: RegisteredGameType,
  base: HandTermsBaseModel,
  extras: SavedTermsExtras,
): HandTermsModel | null {
  switch (gameType) {
    case 'calpoker':
      return calpokerAdapter.persistence.decodeExtras(base, extras);
    case 'spacepoker':
      return spacepokerAdapter.persistence.decodeExtras(base, extras);
    case 'krunk':
      return krunkAdapter.persistence.decodeExtras(base, extras);
  }
}
