import type { ReactElement } from 'react';
import { Program } from 'clvm-lib';

/** Compact settlement outcome ids (snake_case; match Rust `SettlementOutcome`). */
export type SettlementOutcome =
  | 'accept_settlement'
  | 'settled_cleanly'
  | 'opponent_timed_out'
  | 'forfeited_skipped_reveal'
  | 'lost'
  | 'forfeited_we_accepted'
  | 'we_accepted'
  | 'attempt_to_move_failed'
  | 'timed_out_waiting_for_our_move'
  | 'slashed_opponent'
  | 'opponent_slashed_us'
  | 'opponent_cheated';

const ALL_OUTCOMES: ReadonlySet<string> = new Set<SettlementOutcome>([
  'accept_settlement',
  'settled_cleanly',
  'opponent_timed_out',
  'forfeited_skipped_reveal',
  'lost',
  'forfeited_we_accepted',
  'we_accepted',
  'attempt_to_move_failed',
  'timed_out_waiting_for_our_move',
  'slashed_opponent',
  'opponent_slashed_us',
  'opponent_cheated',
]);

export function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && ALL_OUTCOMES.has(value);
}
export interface HandProposalBase {
  myContribution: bigint;
  theirContribution: bigint;
  gameTimeout: bigint;
}

export type RegisteredGameType = string;

export type HandProposal = HandProposalBase & {
  gameType: RegisteredGameType;
};

export type ProposalGroupOrigin = 'local' | 'peer';

export interface PersistedGameState<T = unknown> {
  gameType: string;
  state: T;
}

export type ProposalParameterValue =
  | null
  | boolean
  | bigint
  | string
  | Uint8Array
  | readonly ProposalParameterValue[];

/** Untrusted Bencodex proposal parameters → game-owned parameter record. */
export interface ProposalParameterCodec<TParams> {
  decode(value: unknown): TParams | null;
  encode(params: TParams): ProposalParameterValue;
}

export type GameIntent =
  | { type: 'state-changed' }
  | { type: 'make-move'; gameId: string; readable: Program | null }
  | { type: 'accept-settlement'; gameId: string }
  | { type: 'cheat'; gameId: string; moverShare: bigint };

export interface GameHandInitialization {
  gameIds: readonly string[];
  iStarted: boolean;
  origin: ProposalGroupOrigin;
  handProposal: HandProposal;
}

export type GameUpdate =
  | {
      type: 'move-readable';
      gameId: string;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'message-readable'; gameId: string; readable: Uint8Array }
  | { type: 'hand-ended'; gameId: string; outcome: SettlementOutcome | null };

export interface GameHandState<TState> {
  getState(): TState;
}

export interface GameHand<TState> extends GameHandState<TState> {
  receive(update: GameUpdate): void;
}

export type ComposeDraftValue = Record<string, bigint>;

export interface HandProposalFormProps<TDraft> {
  draft: TDraft;
  disabled: boolean;
  maxPerHandMojos: bigint | null;
  onChange: (update: Partial<TDraft>) => void;
  onSubmit: () => void;
}

export interface HandProposalDecodeContext {
  readonly origin: ProposalGroupOrigin;
  readonly iStarted: boolean;
}

export function equalHandProposalBase(a: HandProposalBase, b: HandProposalBase): boolean {
  return (
    a.myContribution === b.myContribution &&
    a.theirContribution === b.theirContribution &&
    a.gameTimeout === b.gameTimeout
  );
}

export interface LiveGamePort {
  isChannelReady(): boolean;
  dispatch(intent: GameIntent): void;
}

export type GameInteractionMode = 'live' | 'terminal';
export type GameHandOrigin = 'fresh' | 'restored' | 'terminal';

export type GameHandSource<
  TState = unknown,
  THand extends GameHandState<TState> = GameHandState<TState>,
> =
  | {
      readonly interactionMode: 'live';
      readonly hand: THand | null;
      readonly port: LiveGamePort;
    }
  | {
      readonly interactionMode: 'terminal';
      readonly hand: THand | null;
    };

export function gameHandState<TState>(source: GameHandSource<TState>): TState {
  if (source.hand === null) {
    throw new Error('Game hand state is unavailable before a hand is accepted');
  }
  return source.hand.getState();
}

export function requireLiveGameHandSource(source: GameHandSource<unknown>): LiveGamePort {
  if (source.interactionMode !== 'live') {
    throw new Error('Protocol commands require a live game hand source');
  }
  return source.port;
}

export interface GameMountNames {
  myName?: string;
  opponentName?: string;
}

interface GameMountViewBase<THand extends GameHandState<unknown>> extends GameMountNames {
  hand: THand;
  handOrigin: GameHandOrigin;
}

export type GameMountView<THand extends GameHandState<unknown>> =
  | (GameMountViewBase<THand> & {
      frozen: false;
      port: LiveGamePort;
      appendGameLog: (line: string) => void;
    })
  | (GameMountViewBase<THand> & { frozen: true });

export interface GameMountRegistration<THand extends GameHandState<unknown>> {
  render(view: GameMountView<THand>): ReactElement;
}

export interface GamePackageRegistration<
  TState,
  THand extends GameHand<TState>,
  TDraft = ComposeDraftValue,
  TParams = unknown,
> {
  gameType: string;
  readonly displayName: string;
  createHand(init: GameHandInitialization): THand;
  restoreHand(savedState: TState): THand;
  readonly proposalParameters: ProposalParameterCodec<TParams>;
  describeHandProposal(handProposal: HandProposal): string;
  readonly draft: {
    default(perGameAmount: bigint): TDraft;
    fromHandProposal(handProposal: HandProposal): TDraft;
    update(current: TDraft, update: Partial<TDraft>): TDraft;
    toHandProposal(draft: TDraft, gameTimeout: bigint): HandProposal | null;
  };
  toProposalParameters(handProposal: HandProposal, iStarted: boolean): TParams;
  decodeHandProposal(
    base: HandProposalBase,
    params: TParams,
    context: HandProposalDecodeContext,
  ): HandProposal | null;
  validateHandProposal(handProposal: HandProposal): boolean;
  handProposalsEqual(a: HandProposal, b: HandProposal): boolean;
}
