import { CoinRecord } from './rpc/CoinRecord';
import type { ProposalParameterValue } from '@games/host';
import { jsonStringify } from '../util/jsonSafe';
import type * as WasmContract from '../../../wasm/contract';

declare const protocolGameIdBrand: unique symbol;
/** First generated member's initial validation puzzle hash. */
export type ProtocolGameId = string & { readonly [protocolGameIdBrand]: void };

export type HubLiveness = 'connected' | 'reconnecting' | 'inactive' | 'disconnected';

export type PeerLiveness = 'connected' | 'degraded' | 'dead' | null;

export type SessionPhase = 'none' | 'off-chain' | 'on-chain' | 'resolved';

export type Spend = WasmContract.Spend;
export type CoinSpend = WasmContract.CoinSpend;
export type SpendBundle = WasmContract.SpendBundle;

/** Raw per-coin chain state fed to the transaction manager's `report_coin_states`. */
export interface CoinStateRecord {
  /** Full coin string, hex-encoded. */
  coin: string;
  created_height: bigint | null;
  spent_height: bigint | null;
}

/** Wallet funding request emitted by the WASM game-session boundary. */
export type NeedCoinSpendRequest = WasmContract.NeedCoinSpendRequest;
export type GameSessionEvent = WasmContract.GameSessionEvent;
export type WasmResult = WasmContract.WasmResult;
export type WasmDisposition = WasmContract.WasmDisposition;

const WASM_NOTIFICATION_TAGS = new Set([
  'ChannelStatus',
  'GameStatus',
  'GameSettled',
  'ProposalMade',
  'ProposalAcceptedGroup',
  'ProposalCancelled',
  'InsufficientBalance',
  'MoveRejected',
  'ActionFailed',
  'LocalActionApplied',
]);

function requireClosedNotification(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error('cradle returned a non-object notification');
  }
  const tags = Object.keys(value);
  if (tags.length !== 1 || !WASM_NOTIFICATION_TAGS.has(tags[0])) {
    throw new Error(`cradle returned an unknown notification: ${tags.join(',') || '(empty)'}`);
  }
}

function requireGameSessionEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) {
    throw new Error('cradle returned a non-object GameSessionEvent');
  }
  const keys = Object.keys(event);
  if (keys.length !== 1) {
    throw new Error('cradle returned a malformed GameSessionEvent');
  }
  const key = keys[0];
  const payload = (event as Record<string, unknown>)[key];
  switch (key) {
    case 'OutboundMessage':
      if (!(payload instanceof Uint8Array)) {
        throw new Error('cradle returned a non-byte OutboundMessage');
      }
      return;
    case 'Notification':
      requireClosedNotification(payload);
      return;
    case 'Log':
    case 'CoinSolutionRequest':
    case 'ReceiveError':
      if (typeof payload !== 'string') {
        throw new Error(`cradle returned an invalid ${key} event`);
      }
      return;
    case 'NeedCoinSpend':
      if (typeof payload !== 'object' || payload === null) {
        throw new Error('cradle returned an invalid NeedCoinSpend event');
      }
      return;
    default:
      throw new Error(`cradle returned an unknown GameSessionEvent: ${key}`);
  }
}

export function requireWasmResult(value: WasmResult | undefined): WasmResult {
  if (value === undefined || typeof value !== 'object' || value === null) {
    throw new Error('cradle returned no WasmResult');
  }
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.watchCoins) ||
    !Array.isArray(value.unwatchCoins) ||
    typeof value.actionSucceeded !== 'boolean'
  ) {
    throw new Error('cradle returned an incomplete WasmResult');
  }
  value.events.forEach(requireGameSessionEvent);
  const disposition = value.disposition;
  if (
    typeof disposition !== 'object' ||
    disposition === null ||
    !['active', 'await-outbound-terminal', 'terminal'].includes(disposition.kind)
  ) {
    throw new Error('cradle returned an invalid WasmResult disposition');
  }
  if (
    disposition.kind === 'await-outbound-terminal' &&
    (typeof disposition.command !== 'object' ||
      disposition.command === null ||
      typeof disposition.command.id !== 'string' ||
      !(disposition.command.message instanceof Uint8Array))
  ) {
    throw new Error('cradle returned an invalid terminal handoff command');
  }
  return value;
}

export type WasmInitFn = (opts?: {
  module_or_path?: string | URL | Request | Response | Promise<Response>;
}) => Promise<any>;

export interface CoinsetOrgBlockSpend {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: bigint };
  puzzle_reveal: string;
  solution: string;
}

export interface ProposeGameParams {
  /** First generated member's initial validation puzzle hash (32-byte hex). */
  game_type: ProtocolGameId;
  timeout: bigint;
  sender_is_player_a: boolean;
  parameters: ProposalParameterValue;
}

type IChiaIdentity = WasmContract.IChiaIdentity;

export interface GameConnectionState {
  stateIdentifier: StateIdentifier;
  stateDetail: string[];
}

type StateIdentifier = 'starting' | 'running';

export interface GameSessionParams {
  iStarted: boolean;
  myContribution: bigint; // my share of the channel
  theirContribution: bigint; // opponent's share of the channel
  perGameAmount: bigint; // mojos per hand
  restoring?: boolean;
  pairingToken?: string;
  myAlias?: string;
  opponentAlias?: string;
  channelTimeout?: bigint; // blocks, for channel coin
  unrollTimeout?: bigint; // blocks, for unroll coin
}

export type GameStatusState = WasmContract.GameStatusState;
export type GameStatusPayload = WasmContract.GameStatusPayload;
export type GameSettledPayload = WasmContract.GameSettledPayload;
export type ChannelStatus = WasmContract.ChannelStatus;
export type SessionDisposition = WasmContract.SessionDisposition;
export type ChannelStatusPayload = WasmContract.ChannelStatusPayload;

export const CHANNEL_SEMANTIC_PHASES = [
  'submitting_channel_spend',
  'unrolling',
  'finding_state',
  'preempting',
  'finishing_waiting_timeout',
  'finishing_spending',
  'resolving',
] as const;

export type ChannelSemanticPhase = WasmContract.ChannelSemanticPhase;
export type ProposalAcceptedGroupPayload = WasmContract.ProposalAcceptedGroupPayload;
export type ProposalMadePayload = WasmContract.ProposalMadePayload;
export type MoveRejectedPayload = WasmContract.MoveRejectedPayload;
export type ActionFailedPayload = WasmContract.ActionFailedPayload;
export type WasmNotification = WasmContract.WasmNotification;

export type WasmEvent =
  | { type: 'notification'; data: WasmNotification }
  | { type: 'error'; error: string }
  | {
      type: 'game-action-error';
      gameId: string;
      action: 'make-move' | 'accept-settlement';
      error: string;
    }
  | { type: 'durability-error'; error: string }
  | {
      type: 'recoverable-internal-error';
      error: string;
      failure: SubmissionDrainFailure;
    }
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'log'; message: string };

type GameSessionCreateConfig = WasmContract.GameSessionConfig;

/// A labeled coin id (hex) surfaced in the dashboard for explorer lookup.
export interface CoinOfInterestEntry {
  label: string;
  id: string;
  game_id?: string;
  game_coin_kind?: 'current' | 'reward';
}

export type TransactionSubmission = WasmContract.TransactionSubmission;
export type SubmissionDrainFailureStage = WasmContract.SubmissionDrainFailureStage;
export type SubmissionDrainFailure = WasmContract.SubmissionDrainFailure;
export type SubmissionDrain = WasmContract.SubmissionDrain;

export interface FinalizedSubmission {
  protocol_bundle: SpendBundle;
  bundle: unknown;
  applied_fee: string;
  warning?: string | null;
  fee_source_disposition: 'attached' | 'unused' | 'not-requested';
  variant_fingerprint: string;
  should_broadcast: boolean;
}

export type SubmissionAttemptStatus = 'applied' | 'stale';
export type SubmissionFinalizationResult = FinalizedSubmission | { status: 'stale' };

export type WalletSubmitOutcome =
  | { status: 'acknowledged'; detail?: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'rejected'; detail: string };

export type WalletOfferOperation = {
  owner: {
    installationPlayerId: string;
    peerSessionId: string;
    providerScope: WalletProviderScope;
  };
  purpose: { kind: 'funding'; operationId: string } | { kind: 'fee'; operationId: string };
};

export type WalletProviderScope =
  | { provider: 'cloud'; walletId: string }
  | { provider: 'walletconnect'; fingerprint: string; chainId: string }
  | { provider: 'simulator'; identity: string };

export type WalletOfferRequest =
  | {
      kind: 'funding';
      uniqueId: string;
      offer: { [walletId: string]: bigint };
      extraConditions?: Array<{ opcode: bigint; args: string[] }>;
      coinIds?: string[];
      maxHeight?: bigint;
      openingFee?: bigint;
    }
  | {
      kind: 'fee';
      uniqueId: string;
      fee: bigint;
      concurrentSpendCoinId: string;
    };

export type WalletOfferMaterial =
  | { kind: 'offer'; offer: string }
  | { kind: 'bundle'; bundle: unknown };

export type WalletOfferCompletion =
  | { kind: 'created'; material: WalletOfferMaterial; tradeId?: string; warning?: string }
  | { kind: 'failure'; reason: string }
  | { kind: 'unavailable'; reason: string };

export type WalletOfferBeginOutcome =
  | WalletOfferCompletion
  | { kind: 'pending'; recoveryId: string };

export interface WasmConnection {
  // System
  init: () => void;
  create_rng: (seed: string) => number;
  create_game_session: (config: GameSessionCreateConfig) => { id: number; puzzle_hash: string };
  restore_session: (serialized: Uint8Array, new_seed: string) => number;
  game_session_serialization_schema: () => number;
  cache_file: (name: string, data: Uint8Array) => void;
  registered_game_packages: () => Array<{ key: string; id: string }>;

  // Blockchain
  start_handshake: (cid: number, opening_fee: string) => WasmResult;
  provide_coin_spend_bundle: (cid: number, bundle_json: string) => WasmResult;
  provide_offer_bech32: (cid: number, offer_bech32: string) => WasmResult;
  wallet_callback_failed: (cid: number, reason: string) => WasmResult;
  get_channel_puzzle_hash: (cid: number) => string | null;
  report_coin_states: (cid: number, height: bigint, records_json: string) => WasmResult;
  report_height: (cid: number, height: bigint) => WasmResult;
  snapshot_watched_coins: (cid: number) => Array<{ coin_name: string; coin_string: string }>;
  snapshot_pending_coin_solution_requests: (cid: number) => string[];
  drain_submissions: (cid: number) => SubmissionDrain;
  configure_submission_fee: (cid: number, amount: string) => void;
  finalize_submission_attempt: (
    cid: number,
    attempt_token: string,
    fee_source_json?: string,
  ) => SubmissionFinalizationResult;
  acknowledge_submission_attempt: (cid: number, attempt_token: string) => SubmissionAttemptStatus;
  reject_submission_attempt: (cid: number, attempt_token: string) => SubmissionAttemptStatus;
  submission_attempt_unavailable: (cid: number, attempt_token: string) => SubmissionAttemptStatus;
  relinquish_submission_attempt: (cid: number, attempt_token: string) => SubmissionAttemptStatus;
  submission_successor_relationship: (
    cid: number,
    successor_attempt_token: string,
    completed_attempt_token: string,
  ) => WasmContract.SubmissionSuccessorRelationship;
  chain_snapshot_ready: (cid: number) => void;
  request_fee_upgrades: (cid: number) => void;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_offer_to_coinset_org: (offer: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;

  // Game
  propose: (cid: number, proposal: ProposeGameParams) => WasmResult;
  accept_proposal: (cid: number, game_id: string) => WasmResult;
  cancel_proposal: (cid: number, game_id: string) => WasmResult;
  make_move_with_entropy_for_testing: (
    cid: number,
    id: string,
    readable: Uint8Array,
    new_entropy: string,
  ) => WasmResult;
  make_move: (cid: number, id: string, readable: Uint8Array) => WasmResult;
  cheat: (cid: number, id: string, mover_share: string) => WasmResult;
  accept_settlement: (cid: number, id: string) => WasmResult;
  shut_down: (cid: number) => WasmResult;
  drop_game_session: (cid: number) => void;
  abandon: (cid: number) => WasmResult;
  complete_outbound_terminal_handoff: (cid: number) => WasmResult;
  pending_terminal_handoff: (cid: number) => { id: string; message: Uint8Array } | null;
  go_on_chain: (cid: number) => WasmResult;
  report_puzzle_and_solution: (
    cid: number,
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ) => WasmResult;
  deliver_message: (cid: number, inbound_message: Uint8Array) => WasmResult;
  get_identity: (cid: number) => IChiaIdentity;
  historical_unroll_count: (cid: number) => number | undefined;
  coins_of_interest: (cid: number) => CoinOfInterestEntry[];
  serialize_game_session: (cid: number) => Uint8Array;

  // Misc
  sha256bytes: (hex: string) => string;
}

export class ChiaGame {
  wasm: WasmConnection;
  waiting_messages: Uint8Array[];
  session: number;

  constructor(wasm: WasmConnection, sessionId: number) {
    this.wasm = wasm;
    this.waiting_messages = [] as Uint8Array[];
    this.session = sessionId;
  }

  propose(proposal: ProposeGameParams): WasmResult {
    return this.wasm.propose(this.session, proposal);
  }

  accept_proposal(game_id: string): WasmResult {
    return this.wasm.accept_proposal(this.session, game_id);
  }

  cancel_proposal(game_id: string): WasmResult {
    return this.wasm.cancel_proposal(this.session, game_id);
  }

  historical_unroll_count(): bigint | undefined {
    const count = this.wasm.historical_unroll_count(this.session);
    return count === undefined ? undefined : BigInt(count);
  }

  coins_of_interest(): CoinOfInterestEntry[] {
    return this.wasm.coins_of_interest(this.session);
  }

  snapshot_pending_coin_solution_requests(): string[] {
    return this.wasm.snapshot_pending_coin_solution_requests(this.session);
  }

  serialize(): Uint8Array {
    return this.wasm.serialize_game_session(this.session);
  }

  acceptSettlement(id: string): WasmResult {
    return this.wasm.accept_settlement(this.session, id);
  }

  shut_down(): WasmResult {
    return this.wasm.shut_down(this.session);
  }

  dropGameSession(): void {
    this.wasm.drop_game_session?.(this.session);
  }

  abandon(): WasmResult {
    return this.wasm.abandon(this.session);
  }

  completeOutboundTerminalHandoff(): WasmResult {
    return this.wasm.complete_outbound_terminal_handoff(this.session);
  }

  pendingTerminalHandoff(): { id: string; message: Uint8Array } | null {
    return this.wasm.pending_terminal_handoff(this.session);
  }

  go_on_chain(): WasmResult {
    return this.wasm.go_on_chain(this.session);
  }

  report_puzzle_and_solution(
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ): WasmResult {
    return this.wasm.report_puzzle_and_solution(this.session, coin_hex, puzzle_hex, solution_hex);
  }

  make_move(id: string, readable: Uint8Array): WasmResult {
    return this.wasm.make_move(this.session, id, readable);
  }

  make_move_with_entropy_for_testing(
    id: string,
    readable: Uint8Array,
    new_entropy: string,
  ): WasmResult {
    return this.wasm.make_move_with_entropy_for_testing(this.session, id, readable, new_entropy);
  }

  cheat(game_id: string, mover_share: bigint): WasmResult {
    return this.wasm.cheat(this.session, game_id, String(mover_share));
  }

  deliver_message(msg: Uint8Array): WasmResult {
    return this.wasm.deliver_message(this.session, msg);
  }

  start_handshake(opening_fee: string): WasmResult {
    return this.wasm.start_handshake(this.session, opening_fee);
  }

  provide_coin_spend_bundle(bundle_json: string): WasmResult {
    return this.wasm.provide_coin_spend_bundle(this.session, bundle_json);
  }

  provide_offer_bech32(offer_bech32: string): WasmResult {
    return this.wasm.provide_offer_bech32(this.session, offer_bech32);
  }

  wallet_callback_failed(reason: string): WasmResult {
    return this.wasm.wallet_callback_failed(this.session, reason);
  }

  get_channel_puzzle_hash(): string | null {
    return this.wasm.get_channel_puzzle_hash(this.session);
  }

  /** Report raw per-coin chain state; the manager computes the diff internally. */
  report_coin_states(height: bigint, records: CoinStateRecord[]): WasmResult {
    return this.wasm.report_coin_states(this.session, height, jsonStringify(records));
  }

  /** Advance protocol clocks without treating absent coin data as a snapshot. */
  report_height(height: bigint): WasmResult {
    return this.wasm.report_height(this.session, height);
  }

  /** Durable watched-coin snapshot used to seed host polling after attach/restore. */
  snapshot_watched_coins(): Array<{ coin_name: string; coin_string: string }> {
    return this.wasm.snapshot_watched_coins(this.session);
  }

  /** Typed submissions the manager captured and the host should submit. */
  drain_submissions(): SubmissionDrain {
    return this.wasm.drain_submissions(this.session);
  }

  configure_submission_fee(amount: string): void {
    this.wasm.configure_submission_fee(this.session, amount);
  }

  finalize_submission_attempt(
    attemptToken: string,
    feeSourceJson?: string,
  ): SubmissionFinalizationResult {
    return this.wasm.finalize_submission_attempt(this.session, attemptToken, feeSourceJson);
  }

  acknowledge_submission_attempt(attemptToken: string): SubmissionAttemptStatus {
    return this.wasm.acknowledge_submission_attempt(this.session, attemptToken);
  }

  reject_submission_attempt(attemptToken: string): SubmissionAttemptStatus {
    return this.wasm.reject_submission_attempt(this.session, attemptToken);
  }

  submission_attempt_unavailable(attemptToken: string): SubmissionAttemptStatus {
    return this.wasm.submission_attempt_unavailable(this.session, attemptToken);
  }

  relinquish_submission_attempt(attemptToken: string): SubmissionAttemptStatus {
    return this.wasm.relinquish_submission_attempt(this.session, attemptToken);
  }

  submission_successor_relationship(
    successorAttemptToken: string,
    completedAttemptToken: string,
  ): WasmContract.SubmissionSuccessorRelationship {
    return this.wasm.submission_successor_relationship(
      this.session,
      successorAttemptToken,
      completedAttemptToken,
    );
  }

  chain_snapshot_ready(): void {
    this.wasm.chain_snapshot_ready(this.session);
  }

  request_fee_upgrades(): void {
    this.wasm.request_fee_upgrades(this.session);
  }
}

export class RngId {
  rngId: number;
  constructor(rngId: number) {
    this.rngId = rngId;
  }
  getId() {
    return this.rngId;
  }
}

export interface WatchReport {
  created_watched: string[];
  deleted_watched: string[];
}

export interface PeerConnectionResult {
  /**
   * Shared durable reliability state. Real browser peer sessions expose this
   * object before negotiation and SessionController continues using the same
   * object after acceptance.
   */
  reliableState?: {
    sessionId: string;
    messageNumber: bigint;
    remoteNumber: bigint;
    unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
    disposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
  };
  reliableTransport?: unknown;
  persistInboundSessionReject?: (sessionId: string, remoteNumber: bigint) => Promise<void>;
  onSessionReject?: (sessionId: string, remoteNumber: bigint) => void;
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendMessage: (msgno: number, input: Uint8Array) => boolean;
  /** Returns false when the hub WS is not OPEN (frame was not sent). */
  sendAck: (ackMsgno: number) => boolean;
  /** Returns false when the hub WS is not OPEN. */
  sendKeepalive: () => boolean;
  hostLog: (msg: string) => void;
  close: () => void;
  receivePolicy?: import('../lib/session/receivePolicy').ReadonlySessionReceivePolicy;
}

export interface BlockchainReport {
  peak: bigint;
  block: CoinsetOrgBlockSpend[] | undefined;
  report: WatchReport | undefined;
}

export interface BlockchainInboundAddressResult {
  puzzleHash: string;
  // The wallet-provided bech32m address string carrying the correct network HRP
  // (e.g. txch on testnet). Used verbatim as the fee-spend destination so the
  // wallet's send_transaction address validation matches its configured network.
  // Optional: backends that only surface a puzzle hash may omit it.
  address?: string;
}

export type ConnectionField =
  | { type: 'bigint'; label: string; default: bigint }
  | { type: 'string'; label: string; default: string };

export type ConnectionFieldValues = Record<string, string | bigint>;

export interface ConnectionSetup {
  qrUri: string;
  skipQr?: boolean;
  title?: string;
  description?: string;
  fields?: Record<string, ConnectionField>;
  finalize(values?: ConnectionFieldValues): Promise<void>;
}

export type WalletOfferCancellationOutcome =
  | { status: 'cancelled'; detail?: string }
  | { status: 'already-terminal'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'rejected'; detail: string };

export type WalletOfferCancellationBeginOutcome =
  | WalletOfferCancellationOutcome
  | { status: 'pending'; recoveryId: string };

interface WalletOfferProviderBase {
  readonly scope: WalletProviderScope;
}

export interface BestEffortWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'best-effort';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferCompletion>;
  cancel(tradeId: string): Promise<WalletOfferCancellationOutcome>;
}

export interface TerminalWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'terminal';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferCompletion>;
  cancel(tradeId: string): Promise<WalletOfferCancellationOutcome>;
}

export interface RecoverableWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'recoverable';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferBeginOutcome>;
  reconcileCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
    recoveryId: string,
  ): Promise<WalletOfferCompletion>;
  beginCancellation(tradeId: string): Promise<WalletOfferCancellationBeginOutcome>;
  reconcileCancellation(
    tradeId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome>;
}

/**
 * Provider whose mutation is exactly recoverable only after its begin response
 * supplies a provider recovery id. Transport loss before that response remains
 * best-effort uncertainty.
 */
export interface RecoverableAfterBeginWalletOfferProvider extends WalletOfferProviderBase {
  readonly capability: 'recoverable-after-begin';
  beginCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferBeginOutcome>;
  reconcileCreation(
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
    recoveryId: string,
  ): Promise<WalletOfferCompletion>;
  beginCancellation(tradeId: string): Promise<WalletOfferCancellationBeginOutcome>;
  reconcileCancellation(
    tradeId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome>;
}

export type WalletOfferProvider =
  | BestEffortWalletOfferProvider
  | TerminalWalletOfferProvider
  | RecoverableWalletOfferProvider
  | RecoverableAfterBeginWalletOfferProvider;

export interface InternalBlockchainInterface {
  requestGapMs?: number;
  fundingMode?: 'offer-settlement';
  getWalletOfferProvider(
    owner?: Pick<WalletOfferOperation['owner'], 'installationPlayerId' | 'peerSessionId'>,
  ): WalletOfferProvider | null;
  getRegistrationScopeKey?(): string | undefined;
  spend(
    blob: string,
    spendBundle: unknown,
    changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<WalletSubmitOutcome>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<bigint>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
  selectCoins(uniqueId: string, amount: bigint): Promise<string | null>;
  getHeightInfo(): Promise<bigint>;
  getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]>;
  registerCoins(names: string[]): Promise<void>;
  startMonitoring(): Promise<void>;

  beginConnect(uniqueId: string, fresh?: boolean): Promise<ConnectionSetup>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  // True when this backend can fund/resolve channels (hub may advertise
  // not-busy). Simulator and Cloud Wallet: ready whenever connected.
  // WalletConnect: ready once a full-node peer is verified when the wallet
  // supports that optional RPC, otherwise ready whenever connected.
  isReadyForPlay(): boolean;
  onPlayReadinessChange(cb: (ready: boolean) => void): () => void;
}
