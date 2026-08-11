import type { Program } from 'clvm-lib';
import type { GameStateCodec } from './session/gameStateCodec';
import type {
  GameTerminalModel,
  GameTurnState,
  HandTermsBaseModel,
  HandTermsModel,
  ProposalGroupOrigin,
  RegisteredGameType,
} from './session/types';

export type { RegisteredGameType } from './session/types';
export type TermsFor<T extends RegisteredGameType> = Extract<HandTermsModel, { gameType: T }>;
export type SavedTermsExtras = Readonly<Record<string, string | undefined>>;
export type StateUpdate<T> = T | ((current: T) => T);

export type DurableGameStateEvent =
  | {
      type: 'accepted-group';
      id: string;
      groupIds: readonly string[];
      iStarted: boolean;
      origin: ProposalGroupOrigin;
      terms: HandTermsModel;
    }
  | {
      type: 'game-status';
      id: string;
      status: GameTurnState;
      readable: Uint8Array | null;
      moverShare: string | null;
      iStarted: boolean;
    }
  | { type: 'local-turn'; id: string; isMyTurn: boolean }
  | { type: 'settled'; id: string; terminal: GameTerminalModel }
  | { type: 'remove-group'; groupIds: readonly string[] }
  | { type: 'abandoned' }
  | {
      type: 'feature-state';
      gameType: RegisteredGameType;
      id: string;
      state: unknown;
    };

export type ComposeDraftFor<T extends RegisteredGameType> = T extends 'spacepoker'
  ? { unitSize: bigint; stackSize: bigint }
  : { amount: bigint };

export type GameComposeDrafts = {
  [T in RegisteredGameType]: ComposeDraftFor<T>;
};

export interface GameFeatureRegistration<
  T extends RegisteredGameType,
  TState,
  TFeatureState = TState,
> {
  readonly gameType: T;
  readonly displayName: string;
  readonly stateCodec: GameStateCodec<TState>;
  readonly handMembershipDescription: string;
  validateHandMembership(gameIds: readonly string[], state: TState | null): boolean;
  decodeFeatureState(value: unknown): TFeatureState | null;
  readonly lifecycle: {
    proposalSenderGoesFirst(iStarted: boolean): boolean;
    initialTurn(iStarted: boolean): GameTurnState;
  };
  readonly compose: {
    defaultDraft(perGameAmount: bigint): ComposeDraftFor<T>;
    draftFromTerms(terms: TermsFor<T>): ComposeDraftFor<T>;
    updateDraft(
      current: ComposeDraftFor<T>,
      update: Partial<ComposeDraftFor<T>>,
    ): ComposeDraftFor<T>;
    toTerms(draft: ComposeDraftFor<T>, gameTimeout: bigint): TermsFor<T> | null;
  };
  decodeProposalTerms(base: HandTermsBaseModel, parameterState: unknown): TermsFor<T> | null;
  encodeProposalParameters(terms: TermsFor<T>, iStarted: boolean): Program;
  validateTerms(terms: TermsFor<T>): boolean;
  termsEqual(a: TermsFor<T>, b: TermsFor<T>): boolean;
  persistence: {
    encodeExtras(terms: TermsFor<T>): SavedTermsExtras;
    decodeExtras(base: HandTermsBaseModel, extras: SavedTermsExtras): TermsFor<T> | null;
  };
  readonly durableState: {
    reduce(current: TState, update: StateUpdate<TState>): TState;
    reduceEvent(current: TState | null, event: DurableGameStateEvent): TState | null;
  };
}

/** Default durable-state policy for games whose updates replace one snapshot. */
export function reduceGameStateSnapshot<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (value: T) => T)(current) : update;
}

export function equalBaseTerms(a: HandTermsBaseModel, b: HandTermsBaseModel): boolean {
  return (
    a.myContribution === b.myContribution &&
    a.theirContribution === b.theirContribution &&
    a.gameTimeout === b.gameTimeout
  );
}
