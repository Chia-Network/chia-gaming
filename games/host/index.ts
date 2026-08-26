import type { ReactElement, Ref } from 'react';
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
  playerAContribution: bigint;
  playerBContribution: bigint;
  senderIsPlayerA: boolean;
  gameTimeout: bigint;
  parameters: ProposalParameterValue;
}

export type RegisteredGameType = string;

export type HandProposal = HandProposalBase & {
  gameType: RegisteredGameType;
};

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
  | { type: 'make-move'; memberIndex: number; readable: Program | null }
  | { type: 'accept-settlement'; memberIndex: number }
  | { type: 'cheat'; memberIndex: number; moverShare: bigint };

export interface GameHandInitialization {
  handProposal: HandProposal;
  members: readonly { amount: bigint; ourTurn: boolean }[];
}

export type GameUpdate =
  | {
      type: 'move-readable';
      memberIndex: number;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'message-readable'; memberIndex: number; readable: Uint8Array }
  | { type: 'hand-ended'; memberIndex: number; outcome: SettlementOutcome | null };

export interface GameHandState<TState> {
  getState(): TState;
}

export interface GameHand<TState> extends GameHandState<TState> {
  receive(update: GameUpdate): void;
}

export type GameProposalFormResult<TParams> =
  | {
      ok: true;
      senderContribution: bigint;
      receiverContribution: bigint;
      parameters: TParams;
    }
  | { ok: false; error: string };

export interface GameProposalFormHandle<TParams> {
  getProposal(): GameProposalFormResult<TParams>;
}

export interface HandProposalFormProps<TParams> {
  ref?: Ref<GameProposalFormHandle<TParams>>;
  disabled: boolean;
  maxPerHandMojos: bigint | null;
  defaultContribution: bigint;
  initialProposal: HandProposal | null;
  onSubmit: () => void;
}

export function equalHandProposalBase(a: HandProposalBase, b: HandProposalBase): boolean {
  return (
    a.playerAContribution === b.playerAContribution &&
    a.playerBContribution === b.playerBContribution &&
    a.senderIsPlayerA === b.senderIsPlayerA &&
    a.gameTimeout === b.gameTimeout &&
    equalProposalParameterValue(a.parameters, b.parameters)
  );
}

export function equalProposalParameterValue(
  a: ProposalParameterValue,
  b: ProposalParameterValue,
): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equalProposalParameterValue(value, b[index]))
    );
  }
  return a === b;
}

export interface LiveGamePort {
  isChannelReady(): boolean;
  dispatch(intent: GameIntent): void;
}

export type GameHandOrigin = 'fresh' | 'restored' | 'terminal';

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

export function requireLiveGameMount<THand extends GameHandState<unknown>>(
  view: GameMountView<THand>,
): Extract<GameMountView<THand>, { frozen: false }> {
  if (view.frozen) {
    throw new Error('Protocol commands require a live game mount');
  }
  return view;
}

export interface GameMountRegistration<THand extends GameHandState<unknown>> {
  render(view: GameMountView<THand>): ReactElement;
}

export interface GamePackageRegistration<
  TState,
  THand extends GameHand<TState>,
  TParams = unknown,
> {
  gameType: string;
  readonly displayName: string;
  createHand(init: GameHandInitialization): THand;
  restoreHand(savedState: unknown): THand;
  readonly proposalParameters: ProposalParameterCodec<TParams>;
  describeHandProposal(handProposal: HandProposal): string;
  handProposalsEqual(a: HandProposal, b: HandProposal): boolean;
}
