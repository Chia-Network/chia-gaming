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
    case 'NeedLauncherCoin':
      if (payload !== true) {
        throw new Error('cradle returned an invalid NeedLauncherCoin event');
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
  player_a_contribution: bigint;
  player_b_contribution: bigint;
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
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'log'; message: string };

type GameSessionCreateConfig = WasmContract.GameSessionConfig;

/// A labeled coin id (hex) surfaced in the dashboard for explorer lookup.
export interface CoinOfInterestEntry {
  label: string;
  id: string;
}

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
  set_funding_coin: (cid: number, coinstring: string) => WasmResult;
  start_handshake: (cid: number) => WasmResult;
  provide_launcher_coin: (cid: number, hex_launcher_coin: string) => WasmResult;
  provide_coin_spend_bundle: (cid: number, bundle_json: string) => WasmResult;
  provide_offer_bech32: (cid: number, offer_bech32: string) => WasmResult;
  wallet_callback_failed: (cid: number, reason: string) => WasmResult;
  get_channel_puzzle_hash: (cid: number) => string | null;
  report_coin_states: (cid: number, height: bigint, records_json: string) => WasmResult;
  report_height: (cid: number, height: bigint) => WasmResult;
  snapshot_watched_coins: (cid: number) => Array<{ coin_name: string; coin_string: string }>;
  drain_submissions: (cid: number) => SpendBundle[];
  resubmit_submitted: (cid: number) => void;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_offer_to_coinset_org: (offer: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;

  // Game
  propose_games: (cid: number, games: ProposeGameParams[]) => WasmResult;
  accept_proposal: (cid: number, game_id: string) => WasmResult;
  accept_proposal_and_move: (cid: number, id: string, readable: Uint8Array) => WasmResult;
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
  protocol_state_pretty: (cid: number) => string;
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

  propose_games(games: ProposeGameParams[]): WasmResult {
    return this.wasm.propose_games(this.session, games);
  }

  accept_proposal(game_id: string): WasmResult {
    return this.wasm.accept_proposal(this.session, game_id);
  }

  accept_proposal_and_move(game_id: string, readable: Uint8Array): WasmResult {
    return this.wasm.accept_proposal_and_move(this.session, game_id, readable);
  }

  cancel_proposal(game_id: string): WasmResult {
    return this.wasm.cancel_proposal(this.session, game_id);
  }

  protocol_state_pretty(): string {
    return this.wasm.protocol_state_pretty(this.session);
  }

  historical_unroll_count(): bigint | undefined {
    const count = this.wasm.historical_unroll_count(this.session);
    return count === undefined ? undefined : BigInt(count);
  }

  coins_of_interest(): CoinOfInterestEntry[] {
    return this.wasm.coins_of_interest(this.session);
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

  set_funding_coin(coin_string: string): WasmResult {
    return this.wasm.set_funding_coin(this.session, coin_string);
  }

  start_handshake(): WasmResult {
    return this.wasm.start_handshake(this.session);
  }

  provide_launcher_coin(hex_launcher_coin: string): WasmResult {
    return this.wasm.provide_launcher_coin(this.session, hex_launcher_coin);
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

  /** Spend bundles the manager captured and the host should submit. */
  drain_submissions(): SpendBundle[] {
    return this.wasm.drain_submissions(this.session);
  }

  /** Re-queue all retained submissions for resubmission (call after reload). */
  resubmit_submitted(): void {
    this.wasm.resubmit_submitted(this.session);
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
}

export interface ConnectionField {
  label: string;
  default: bigint;
}

export interface ConnectionSetup {
  qrUri: string;
  skipQr?: boolean;
  fields?: { balance?: ConnectionField };
  finalize(values?: { balance?: bigint }): Promise<void>;
}

export interface InternalBlockchainInterface {
  requestGapMs?: number;
  getRegistrationScopeKey?(): string | undefined;
  spend(
    blob: string,
    spendBundle: unknown,
    changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<string>;
  rememberLocalRemovals?(spendBundle: unknown): void | Promise<void>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<bigint>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
  selectCoins(uniqueId: string, amount: bigint): Promise<string | null>;
  getHeightInfo(): Promise<bigint>;
  createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: bigint },
    extraConditions?: Array<{ opcode: bigint; args: string[] }>,
    coinIds?: string[],
    maxHeight?: bigint,
  ): Promise<any | null>;
  getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]>;
  registerCoins(names: string[]): Promise<void>;
  startMonitoring(): Promise<void>;

  beginConnect(uniqueId: string, fresh?: boolean): Promise<ConnectionSetup>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  // True when this backend can fund/resolve channels (hub may advertise
  // not-busy). Simulator: ready whenever connected. WalletConnect: ready once a
  // full-node peer is verified. Peer count is a private implementation detail.
  isReadyForPlay(): boolean;
  onPlayReadinessChange(cb: (ready: boolean) => void): () => void;
}
