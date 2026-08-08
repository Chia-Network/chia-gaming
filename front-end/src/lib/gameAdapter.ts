import type { Program } from 'clvm-lib';
import type { GameStateCodec } from './session/gameStateCodec';
import type {
  GameTurnState,
  HandTermsBaseModel,
  HandTermsModel,
  RegisteredGameType,
} from './session/types';

export type { RegisteredGameType } from './session/types';
export type TermsFor<T extends RegisteredGameType> = Extract<HandTermsModel, { gameType: T }>;
export type SavedTermsExtras = Readonly<Record<string, string | undefined>>;

export interface GameAdapter<T extends RegisteredGameType, TState> {
  readonly gameType: T;
  readonly displayName: string;
  readonly stateCodec: GameStateCodec<TState>;
  readonly lifecycle: {
    proposalSenderGoesFirst(iStarted: boolean): boolean;
    initialTurn(iStarted: boolean): GameTurnState;
  };
  readonly compose: {
    defaultAmount(currentGameType: RegisteredGameType, currentAmount: bigint): bigint;
  };
  decodeProposalTerms(base: HandTermsBaseModel, parameterState: unknown): TermsFor<T> | null;
  encodeProposalParameters(terms: TermsFor<T>, iStarted: boolean): Program;
  validateTerms(terms: TermsFor<T>): boolean;
  termsEqual(a: TermsFor<T>, b: TermsFor<T>): boolean;
  persistence: {
    encodeExtras(terms: TermsFor<T>): SavedTermsExtras;
    decodeExtras(base: HandTermsBaseModel, extras: SavedTermsExtras): TermsFor<T> | null;
  };
}

export function equalBaseTerms(a: HandTermsBaseModel, b: HandTermsBaseModel): boolean {
  return (
    a.myContribution === b.myContribution &&
    a.theirContribution === b.theirContribution &&
    a.gameTimeout === b.gameTimeout
  );
}
