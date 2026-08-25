import { createElement, type ComponentType, type ReactElement } from 'react';
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

export const SETTLEMENT_OUTCOME_LABELS: Record<SettlementOutcome, string> = {
  accept_settlement: 'Accepted',
  settled_cleanly: 'Settled cleanly',
  opponent_timed_out: 'Opponent timed out',
  forfeited_skipped_reveal: 'Forfeited',
  lost: 'Lost',
  forfeited_we_accepted: 'Forfeited',
  we_accepted: 'Accepted',
  attempt_to_move_failed: 'Attempt to move failed',
  timed_out_waiting_for_our_move: 'Timed out waiting for our move',
  slashed_opponent: 'Slashed opponent',
  opponent_slashed_us: 'Opponent slashed us',
  opponent_cheated: 'Opponent cheated',
};

export function isSettlementOutcome(value: unknown): value is SettlementOutcome {
  return typeof value === 'string' && ALL_OUTCOMES.has(value);
}

export function settlementLabel(outcome: SettlementOutcome): string {
  return SETTLEMENT_OUTCOME_LABELS[outcome];
}

export function isForfeitOutcome(outcome: SettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal' || outcome === 'forfeited_we_accepted';
}

export function isErrorSettlementOutcome(outcome: SettlementOutcome): boolean {
  return (
    isForfeitOutcome(outcome) ||
    outcome === 'timed_out_waiting_for_our_move' ||
    outcome === 'attempt_to_move_failed' ||
    outcome === 'opponent_slashed_us' ||
    outcome === 'opponent_cheated'
  );
}

export function settlementByUs(outcome: SettlementOutcome): boolean | null {
  switch (outcome) {
    case 'accept_settlement':
    case 'we_accepted':
    case 'forfeited_skipped_reveal':
    case 'forfeited_we_accepted':
    case 'lost':
    case 'timed_out_waiting_for_our_move':
    case 'attempt_to_move_failed':
    case 'slashed_opponent':
      return true;
    case 'opponent_timed_out':
    case 'opponent_slashed_us':
    case 'opponent_cheated':
      return false;
    case 'settled_cleanly':
      return null;
  }
}

export function parseSettlementShare(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value === 'object' &&
    value !== null &&
    'Amount' in (value as Record<string, unknown>)
  ) {
    return String((value as Record<string, unknown>).Amount);
  }
  if (typeof value === 'object' && value !== null && 'amt' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).amt);
  }
  return String(value);
}

export type GameTerminalType =
  | 'none'
  | 'settled'
  | 'insufficient-balance'
  | 'ended-cancelled'
  | 'game-error';

export interface GameTerminalModel {
  type: GameTerminalType;
  outcome: SettlementOutcome | null;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
}

export const EMPTY_GAME_TERMINAL_MODEL: GameTerminalModel = {
  type: 'none',
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

export interface GameHostText {
  formatMojos(mojos: bigint): string;
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

export type HandWinOutcome = { my_win_outcome: 'win' | 'lose' | 'tie' };

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

export function readClvmProgram(value: unknown): Program | null {
  if (!(value instanceof Uint8Array)) return null;
  try {
    const program = Program.deserialize(value);
    const canonical = program.serialize();
    if (
      canonical.length !== value.length ||
      canonical.some((byte, index) => byte !== value[index])
    ) {
      return null;
    }
    return program;
  } catch {
    return null;
  }
}

export function readClvmAtom(program: Program): bigint | null {
  try {
    return program.toBigInt();
  } catch {
    return null;
  }
}

export function readClvmFlag(program: Program): boolean | null {
  const value = readClvmAtom(program);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

export function readClvmList(program: Program, length: number): readonly Program[] | null {
  if (!program.isCons) return null;
  try {
    const items = program.toList(true);
    return items.length === length ? items : null;
  } catch {
    return null;
  }
}

export type GameIntent<TState> =
  | { type: 'update-local-state'; state: TState }
  | { type: 'make-move'; gameId: string; readable: Program | null; state: TState }
  | { type: 'accept-settlement'; gameId: string; state: TState }
  | { type: 'cheat'; gameId: string; moverShare: bigint; state: TState };

export interface GameHandInitialization {
  id: string;
  gameIds: readonly string[];
  iStarted: boolean;
  canAct: boolean;
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
  | { type: 'hand-ended'; gameId: string; terminal: GameTerminalModel };

export interface GameHandState<TState> {
  getState(): TState;
}

export interface GameHand<TState> extends GameHandState<TState> {
  receive(update: GameUpdate): void;
  /** Host-only: install a complete accepted or optimistic hand state. */
  installState(state: TState): void;
  /** Host-only: set the saved state before delivering runtime updates. */
  setInitialState(state: TState): void;
}

export type RegisteredGameHand = GameHand<unknown>;

export function createGameHand<TState>(
  initialState: TState,
  reduce: (current: TState, update: GameUpdate) => TState,
): GameHand<TState> {
  let state = initialState;
  return {
    receive(update) {
      state = reduce(state, update);
    },
    getState: () => state,
    installState(next) {
      state = next;
    },
    setInitialState(next) {
      state = next;
    },
  };
}

export type ComposeDraftValue = Record<string, bigint>;
export type GameComposeDrafts = Record<string, ComposeDraftValue>;
export type SavedHandProposalExtras = Readonly<Record<string, string | undefined>>;
export type StateUpdate<T> = T | ((current: T) => T);
export type HandProposalFor<T extends RegisteredGameType> = HandProposal & { gameType: T };

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
  readonly expectedSenderGoesFirst: boolean;
}

export function reduceGameStateSnapshot<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (value: T) => T)(current) : update;
}

export function equalHandProposalBase(a: HandProposalBase, b: HandProposalBase): boolean {
  return (
    a.myContribution === b.myContribution &&
    a.theirContribution === b.theirContribution &&
    a.gameTimeout === b.gameTimeout
  );
}

export interface LiveGameProtocolPort {
  isChannelReady(): boolean;
}

export interface LiveGamePort extends LiveGameProtocolPort {
  dispatch<TState>(intent: GameIntent<TState>): void;
}

export type GameInteractionMode = 'live' | 'terminal';
export type GameHandOrigin = 'fresh' | 'restored' | 'terminal';

export type GameHandSource<TState = unknown> =
  | {
      readonly interactionMode: 'live';
      readonly hand: GameHandState<TState> | null;
      readonly port: LiveGamePort;
    }
  | {
      readonly interactionMode: 'terminal';
      readonly hand: GameHandState<TState> | null;
    };

export function terminalGameHandSource<TState>(
  hand: GameHandState<TState> | null,
): Extract<GameHandSource<TState>, { interactionMode: 'terminal' }> {
  return Object.freeze({ interactionMode: 'terminal', hand });
}

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

export function liveGameHandOrigin(
  restoredHandKey: number | null,
  currentHandKey: number,
): Exclude<GameHandOrigin, 'terminal'> {
  return restoredHandKey === currentHandKey ? 'restored' : 'fresh';
}

export interface GameMountNames {
  myName?: string;
  opponentName?: string;
}

export interface FrozenGameMountOptions extends GameMountNames {
  iStarted: boolean;
}

interface GameMountViewBase extends GameMountNames {
  hand: GameHandState<unknown>;
  handOrigin: GameHandOrigin;
  lastDisplayedId: string | null;
  activeIds: readonly string[];
  currentHandIds: readonly string[];
  canActById: Readonly<Record<string, boolean>>;
  iStarted: boolean;
  playerNumber: number;
  instances: Readonly<Record<string, { terminal: GameTerminalModel; amount: string }>>;
}

export type GameMountView =
  | (GameMountViewBase & {
      frozen: false;
      port: LiveGamePort;
      appendGameLog: (line: string) => void;
    })
  | (GameMountViewBase & { frozen: true });

export function gameHandSourceFromMountView<TState>(view: GameMountView): GameHandSource<TState> {
  const hand = view.hand as GameHandState<TState>;
  return view.frozen
    ? terminalGameHandSource(hand)
    : { interactionMode: 'live', hand, port: view.port };
}

export interface GameMountRegistration {
  render(view: GameMountView): ReactElement;
}

export interface GamePackageRegistration<TState, TDraft = ComposeDraftValue, TParams = unknown> {
  gameType: string;
  readonly displayName: string;
  readonly canRemountFinished: boolean;
  createHand(init: GameHandInitialization): GameHand<TState>;
  readonly proposalParameters: ProposalParameterCodec<TParams>;
  describeHandProposal(handProposal: HandProposal, text: GameHostText): string;
  validateHandIds(gameIds: readonly string[]): boolean;
  selectOutcome(state: TState, gameId: string): HandWinOutcome | null;
  readonly lifecycle: {
    proposalSenderGoesFirst(iStarted: boolean): boolean;
  };
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
  persistence: {
    encodeExtras(handProposal: HandProposal): SavedHandProposalExtras;
    decodeExtras(base: HandProposalBase, extras: SavedHandProposalExtras): HandProposal | null;
  };
}

export interface RegisteredGamePackage {
  readonly gameType: string;
  readonly displayName: string;
  readonly canRemountFinished: boolean;
  createHand(init: GameHandInitialization): RegisteredGameHand;
  describeHandProposal(handProposal: HandProposal, text: GameHostText): string;
  validateHandIds(gameIds: readonly string[]): boolean;
  selectOutcome(state: unknown, gameId: string): HandWinOutcome | null;
  readonly lifecycle: {
    proposalSenderGoesFirst(iStarted: boolean): boolean;
  };
  readonly draft: {
    default(perGameAmount: bigint): ComposeDraftValue;
    fromHandProposal(handProposal: HandProposal): ComposeDraftValue;
    update(current: ComposeDraftValue, update: Partial<ComposeDraftValue>): ComposeDraftValue;
    toHandProposal(draft: ComposeDraftValue, gameTimeout: bigint): HandProposal | null;
  };
  encodeProposalParameters(handProposal: HandProposal, iStarted: boolean): ProposalParameterValue;
  decodeHandProposal(
    base: HandProposalBase,
    parameterState: unknown,
    context: HandProposalDecodeContext,
  ): HandProposal | null;
  validateHandProposal(handProposal: HandProposal): boolean;
  handProposalsEqual(a: HandProposal, b: HandProposal): boolean;
  readonly persistence: {
    encodeExtras(handProposal: HandProposal): SavedHandProposalExtras;
    decodeExtras(base: HandProposalBase, extras: SavedHandProposalExtras): HandProposal | null;
  };
  render(view: GameMountView): ReactElement;
  renderHandProposalForm(props: HandProposalFormProps<ComposeDraftValue>): ReactElement;
}

export function defineGamePackage<TState, TDraft extends ComposeDraftValue, TParams>(
  feature: GamePackageRegistration<TState, TDraft, TParams>,
  HandProposalForm: ComponentType<HandProposalFormProps<TDraft>>,
  mount: GameMountRegistration,
): RegisteredGamePackage {
  const requireState = (value: unknown): TState => value as TState;
  return {
    ...feature,
    createHand: (init) => feature.createHand(init) as RegisteredGameHand,
    selectOutcome: (state, gameId) => feature.selectOutcome(requireState(state), gameId),
    draft: {
      default: feature.draft.default,
      fromHandProposal: feature.draft.fromHandProposal,
      update: (current, update) =>
        feature.draft.update(current as TDraft, update as Partial<TDraft>),
      toHandProposal: (draft, gameTimeout) =>
        feature.draft.toHandProposal(draft as TDraft, gameTimeout),
    },
    encodeProposalParameters: (handProposal, iStarted) =>
      feature.proposalParameters.encode(feature.toProposalParameters(handProposal, iStarted)),
    decodeHandProposal: (base, parameterState, context) => {
      const params = feature.proposalParameters.decode(parameterState);
      return params === null ? null : feature.decodeHandProposal(base, params, context);
    },
    persistence: feature.persistence,
    render: mount.render,
    renderHandProposalForm: (props) =>
      createElement(HandProposalForm, {
        ...props,
        draft: props.draft as unknown as TDraft,
      }),
  };
}

export interface CurrencyLabels {
  xch: string;
  chia: string;
  mojo: string;
  mojos: string;
  MOJO: string;
}

export const DEFAULT_CURRENCY_LABELS: CurrencyLabels = {
  xch: 'XCH',
  chia: 'chia',
  mojo: 'mojo',
  mojos: 'mojos',
  MOJO: 'MOJO',
};

export function formatAmountWithLabels(mojos: bigint, labels: CurrencyLabels): string {
  if (mojos < 1_000_000n) {
    return `${mojos} ${labels.MOJO}`;
  }
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} ${labels.xch}`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} ${labels.xch}`;
}

export function formatMojosWithLabels(mojos: bigint, labels: CurrencyLabels): string {
  const TRILLION = 1_000_000_000_000n;
  const absMojos = mojos < 0n ? -mojos : mojos;
  if (absMojos >= 100_000_000n) {
    const sign = mojos < 0n ? '-' : '';
    const whole = absMojos / TRILLION;
    const frac = absMojos % TRILLION;
    const fracStr = frac.toString().padStart(12, '0').slice(0, 4);
    return `${sign}${whole.toLocaleString()}.${fracStr} ${labels.xch}`;
  }
  return `${mojos.toLocaleString()} ${labels.mojos}`;
}

export function defaultFormatAmount(mojos: bigint): string {
  return formatAmountWithLabels(mojos, DEFAULT_CURRENCY_LABELS);
}

export function defaultFormatMojos(mojos: bigint): string {
  return formatMojosWithLabels(mojos, DEFAULT_CURRENCY_LABELS);
}
