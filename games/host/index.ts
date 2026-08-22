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
  version: bigint;
  state: T;
}

export interface GameStateCodec<T> {
  gameType: string;
  readonly version: bigint;
  readonly canRemountFinished: boolean;
  isState(value: unknown): value is T;
  gameIds(state: T): readonly string[];
  encode(state: T): PersistedGameState<T>;
  decode(value: unknown): T | null;
}

/** Untrusted factory-parameter blob → game-owned parameter record. */
export interface FactoryParameterCodec<TParams> {
  decode(value: unknown): TParams | null;
  encode(params: TParams): Program;
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

export function defineGameStateCodec<T>(definition: {
  gameType: string;
  version: bigint;
  canRemountFinished: boolean;
  isState(value: unknown): value is T;
  gameIds?: (state: T) => readonly string[];
}): GameStateCodec<T> {
  const codec: GameStateCodec<T> = {
    gameType: definition.gameType,
    version: definition.version,
    canRemountFinished: definition.canRemountFinished,
    isState: definition.isState,
    gameIds: definition.gameIds ?? (() => []),
    encode: (state) => ({ gameType: codec.gameType, version: codec.version, state }),
    decode: (value) => {
      if (typeof value !== 'object' || value === null) return null;
      const persisted = value as Partial<PersistedGameState>;
      return persisted.gameType === codec.gameType &&
        persisted.version === codec.version &&
        codec.isState(persisted.state)
        ? persisted.state
        : null;
    },
  };
  return codec;
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

export type GameInput<TInit = GameHandInitialization> =
  | { type: 'hand-started'; init: TInit }
  | {
      type: 'opponent-moved';
      gameId: string;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'game-message'; gameId: string; readable: Uint8Array }
  | { type: 'move-rejected'; gameId: string; tag: string; message: string }
  | { type: 'hand-ended'; gameId: string; terminal: GameTerminalModel };

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

export type GameHandSource =
  | {
      readonly interactionMode: 'live';
      readonly handState: Readonly<PersistedGameState> | null;
      readonly port: LiveGamePort;
    }
  | {
      readonly interactionMode: 'terminal';
      readonly handState: Readonly<PersistedGameState> | null;
    };

export function terminalGameHandSource(
  handState: Readonly<PersistedGameState> | null,
): Extract<GameHandSource, { interactionMode: 'terminal' }> {
  const source = { interactionMode: 'terminal' } as Extract<
    GameHandSource,
    { interactionMode: 'terminal' }
  >;
  Object.defineProperty(source, 'handState', {
    value: handState,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(source);
}

export function gameHandState(source: GameHandSource): Readonly<PersistedGameState> | null {
  return source.handState;
}

export function requireLiveGameHandSource(source: GameHandSource): LiveGamePort {
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
  handState: Readonly<PersistedGameState> | null;
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

export function gameHandSourceFromMountView(view: GameMountView): GameHandSource {
  return view.frozen
    ? terminalGameHandSource(view.handState)
    : { interactionMode: 'live', handState: view.handState, port: view.port };
}

export interface GameMountRegistration {
  render(view: GameMountView): ReactElement;
}

export interface GameFeatureRegistration<
  TState,
  TFeatureState = TState,
  TDraft = ComposeDraftValue,
  TParams = unknown,
> {
  gameType: string;
  readonly displayName: string;
  readonly stateCodec: GameStateCodec<TState>;
  readonly factoryParameters: FactoryParameterCodec<TParams>;
  describeHandProposal(handProposal: HandProposal, text: GameHostText): string;
  readonly handMembershipDescription: string;
  validateHandMembership(gameIds: readonly string[], state: TState | null): boolean;
  decodeFeatureState(value: unknown): TFeatureState | null;
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
  toFactoryParameters(handProposal: HandProposal, iStarted: boolean): TParams;
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
  readonly durableState: {
    initialize(
      current: TState | null,
      input: Extract<GameInput, { type: 'hand-started' }>,
    ): TState;
    reduceInput(
      current: TState,
      input: Exclude<GameInput, { type: 'hand-started' }>,
    ): TState;
    applyFeatureState(current: TState, gameId: string, state: TFeatureState): TState;
  };
}

export interface RegisteredGamePackage {
  readonly gameType: string;
  readonly displayName: string;
  readonly stateCodec: GameStateCodec<unknown>;
  describeHandProposal(handProposal: HandProposal, text: GameHostText): string;
  readonly handMembershipDescription: string;
  validateHandMembership(gameIds: readonly string[], state: unknown | null): boolean;
  decodeFeatureState(value: unknown): unknown | null;
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
  encodeFactoryParameters(handProposal: HandProposal, iStarted: boolean): Program;
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
  readonly durableState: {
    initialize(
      current: unknown | null,
      input: Extract<GameInput, { type: 'hand-started' }>,
    ): unknown;
    reduceInput(
      current: unknown,
      input: Exclude<GameInput, { type: 'hand-started' }>,
    ): unknown;
    applyFeatureState(current: unknown, gameId: string, state: unknown): unknown;
  };
  render(view: GameMountView): ReactElement;
  renderHandProposalForm(props: HandProposalFormProps<ComposeDraftValue>): ReactElement;
}

export function defineGamePackage<
  TState,
  TFeatureState,
  TDraft extends ComposeDraftValue,
  TParams,
>(
  feature: GameFeatureRegistration<TState, TFeatureState, TDraft, TParams>,
  HandProposalForm: ComponentType<HandProposalFormProps<TDraft>>,
  mount: GameMountRegistration,
): RegisteredGamePackage {
  const requireState = (value: unknown): TState => {
    if (!feature.stateCodec.isState(value)) {
      throw new Error(`Invalid internal ${feature.gameType} state`);
    }
    return value;
  };
  const stateCodec: GameStateCodec<unknown> = {
    ...feature.stateCodec,
    gameIds: (state) => feature.stateCodec.gameIds(requireState(state)),
    encode: (state) => feature.stateCodec.encode(requireState(state)),
  };
  return {
    ...feature,
    stateCodec,
    validateHandMembership: (gameIds, state) =>
      state === null
        ? feature.validateHandMembership(gameIds, null)
        : feature.validateHandMembership(gameIds, requireState(state)),
    selectOutcome: (state, gameId) => feature.selectOutcome(requireState(state), gameId),
    draft: {
      default: feature.draft.default,
      fromHandProposal: feature.draft.fromHandProposal,
      update: (current, update) =>
        feature.draft.update(current as TDraft, update as Partial<TDraft>),
      toHandProposal: (draft, gameTimeout) =>
        feature.draft.toHandProposal(draft as TDraft, gameTimeout),
    },
    encodeFactoryParameters: (handProposal, iStarted) =>
      feature.factoryParameters.encode(feature.toFactoryParameters(handProposal, iStarted)),
    decodeHandProposal: (base, parameterState, context) => {
      const params = feature.factoryParameters.decode(parameterState);
      return params === null ? null : feature.decodeHandProposal(base, params, context);
    },
    persistence: feature.persistence,
    durableState: {
      initialize: (current, input) =>
        feature.durableState.initialize(current === null ? null : requireState(current), input),
      reduceInput: (current, input) =>
        feature.durableState.reduceInput(requireState(current), input),
      applyFeatureState: (current, gameId, state) => {
        const featureState = feature.decodeFeatureState(state);
        if (featureState === null) {
          throw new Error(`Invalid internal ${feature.gameType} feature state`);
        }
        return feature.durableState.applyFeatureState(
          requireState(current),
          gameId,
          featureState,
        );
      },
    },
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
