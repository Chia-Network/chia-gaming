import { CoinRecord } from './rpc/CoinRecord';
import { Program } from 'clvm-lib';

export type TrackerLiveness = 'connected' | 'reconnecting' | 'inactive' | 'disconnected';

interface Amount {
  amt: bigint;
}

export interface Spend {
  puzzle: string;
  solution: string;
  signature: string;
}

export interface CoinSpend {
  coin: string;
  bundle: Spend;
}

export interface SpendBundle {
  spends: CoinSpend[];
}

export type CradleEvent =
  | { OutboundMessage: string }
  | { OutboundTransaction: SpendBundle }
  | { Notification: WasmNotification }
  | { DebugLog: string }
  | { CoinSolutionRequest: string }
  | { ReceiveError: string }
  | { NeedCoinSpend: unknown }
  | { NeedLauncherCoin: boolean }
  | { WatchCoin: { coin_name: string; coin_string: string } };

export interface WasmResult {
  events?: CradleEvent[];
  ids?: string[];
}

export type WasmInitFn = (opts?: { module_or_path?: string | URL | Request | Response | Promise<Response> }) => Promise<any>;

export interface CoinsetOrgBlockSpend {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: bigint };
  puzzle_reveal: string;
  solution: string;
}

export interface ProposeGameParams {
  game_type: string;
  timeout: number;
  amount: bigint;
  my_contribution: bigint;
  my_turn: boolean;
  parameters: Program | null;
}

interface IChiaIdentity {
  private_key: string;
  synthetic_private_key: string;
  public_key: string;
  synthetic_public_key: string;
  puzzle: string;
  puzzle_hash: string;
}

export interface GameConnectionState {
  stateIdentifier: StateIdentifier;
  stateDetail: string[];
}

type StateIdentifier = 'starting' | 'running' | 'clean_shutdown' | 'end';

export interface GameSessionParams {
  iStarted: boolean;
  amount: bigint;          // mojos, total channel buy-in
  perGameAmount: bigint;   // mojos per hand
  restoring?: boolean;
  pairingToken?: string;
  myAlias?: string;
  opponentAlias?: string;
}

export interface ChatMessage {
  text: string;
  fromAlias: string;
  timestamp: number;
  isMine: boolean;
}

type WasmNotificationTag =
  | 'ChannelStatus'
  | 'GameStatus'
  | 'ProposalMade' | 'ProposalAccepted' | 'ProposalCancelled'
  | 'InsufficientBalance'
  | 'ActionFailed';

export type GameStatusState =
  | 'my-turn'
  | 'their-turn'
  | 'on-chain-my-turn'
  | 'on-chain-their-turn'
  | 'replaying'
  | 'illegal-move-detected'
  | 'ended-we-timed-out'
  | 'ended-opponent-timed-out'
  | 'ended-we-slashed-opponent'
  | 'ended-opponent-slashed-us'
  | 'ended-opponent-successfully-cheated'
  | 'ended-cancelled'
  | 'ended-error';

interface GameStatusOtherParams {
  readable?: unknown;
  mover_share?: unknown;
  illegal_move_detected?: boolean;
  moved_by_us?: boolean;
  game_finished?: boolean;
}

export interface GameStatusPayload {
  id: unknown;
  status: GameStatusState;
  my_reward?: unknown;
  coin_id?: unknown;
  reason?: string | null;
  other_params?: GameStatusOtherParams | null;
}

export type ChannelState =
  | 'Handshaking' | 'WaitingForHeightToOffer' | 'WaitingForHeightToAccept'
  | 'WaitingForOffer' | 'OfferSent' | 'TransactionPending'
  | 'Active' | 'ShuttingDown' | 'ShutdownTransactionPending'
  | 'GoingOnChain' | 'Unrolling'
  | 'ResolvedClean' | 'ResolvedUnrolled' | 'ResolvedStale'
  | 'Failed';

export interface ChannelStatusPayload {
  state: ChannelState;
  advisory: string | null;
  coin: unknown;
  our_balance: unknown;
  their_balance: unknown;
  game_allocated: unknown;
}

export type WasmNotification = {
  [K in WasmNotificationTag]?: Record<string, unknown>;
};

export type WasmEvent =
  | { type: 'notification'; data: WasmNotification }
  | { type: 'error'; error: string }
  | { type: 'address'; data: BlockchainInboundAddressResult }
  | { type: 'debug_log'; message: string };

interface GameCradleCreateConfig {
  rng_id: number;
  game_types: Record<string, { version: number; hex: string; parser_hex: string }>;
  have_potato: boolean;
  my_contribution: Amount;
  their_contribution: Amount;
  channel_timeout: number;
  unroll_timeout: number;
  reward_puzzle_hash: string;
}

export interface WasmConnection {
  // System
  init: (print: (msg: string) => void) => void;
  create_rng: (seed: string) => number;
  create_game_cradle: (config: GameCradleCreateConfig) => { id: number; puzzle_hash: string };
  create_serialized_game: (serialized: string, new_seed: string) => number;
  deposit_file: (name: string, data: string) => void;

  // Blockchain
  opening_coin: (cid: number, coinstring: string) => WasmResult | undefined;
  start_handshake: (cid: number) => WasmResult | undefined;
  provide_launcher_coin: (cid: number, hex_launcher_coin: string) => WasmResult | undefined;
  provide_coin_spend_bundle: (cid: number, bundle_json: string) => WasmResult | undefined;
  provide_offer_bech32: (cid: number, offer_bech32: string) => WasmResult | undefined;
  get_channel_puzzle_hash: (cid: number) => string | null;
  new_block: (
    cid: number,
    height: number,
    additions: string[],
    removals: string[],
    timed_out: string[],
  ) => WasmResult | undefined;
  convert_coinset_org_block_spend_to_watch_report: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
    puzzle_reveal: string,
    solution: string,
  ) => WatchReport | undefined;
  convert_spend_to_coinset_org: (spend: string) => unknown;
  convert_coinset_to_coin_string: (
    parent_coin_info: string,
    puzzle_hash: string,
    amount: string,
  ) => string;
  convert_chia_public_key_to_puzzle_hash: (public_key: string) => string;
  coin_string_to_name: (hex_coinstring: string) => string;

  // Game
  propose_game: (cid: number, game: Omit<ProposeGameParams, 'parameters'>, parameters: Uint8Array) => WasmResult | undefined;
  accept_proposal: (cid: number, game_id: string) => WasmResult | undefined;
  accept_proposal_and_move: (cid: number, id: string, readable: Uint8Array) => WasmResult | undefined;
  cancel_proposal: (cid: number, game_id: string) => WasmResult | undefined;
  make_move_with_entropy_for_testing: (
    cid: number,
    id: string,
    readable: Uint8Array,
    new_entropy: string,
  ) => WasmResult | undefined;
  make_move: (cid: number, id: string, readable: Uint8Array) => WasmResult | undefined;
  cheat: (cid: number, id: string, mover_share: string) => WasmResult | undefined;
  accept_timeout: (cid: number, id: string) => WasmResult | undefined;
  shut_down: (cid: number) => WasmResult | undefined;
  go_on_chain: (cid: number) => WasmResult | undefined;
  report_puzzle_and_solution: (
    cid: number,
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ) => WasmResult | undefined;
  deliver_message: (cid: number, inbound_message: string) => WasmResult | undefined;
  cradle_amount: (cid: number) => number;
  cradle_our_share: (cid: number) => number;
  cradle_their_share: (cid: number) => number;
  get_identity: (cid: number) => IChiaIdentity;
  get_game_state_id: (cid: number) => string | undefined;
  serialize_cradle: (cid: number) => string;

  // Misc
  sha256bytes: (hex: string) => string;
}

export class ChiaGame {
  wasm: WasmConnection;
  waiting_messages: string[];
  cradle: number;

  constructor(
    wasm: WasmConnection,
    cradleId: number,
  ) {
    this.wasm = wasm;
    this.waiting_messages = [];
    this.cradle = cradleId;
  }

  propose_game(game: Omit<ProposeGameParams, 'parameters'>, parameters: Uint8Array): WasmResult | undefined {
    return this.wasm.propose_game(this.cradle, game, parameters);
  }

  accept_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.accept_proposal(this.cradle, game_id);
  }

  accept_proposal_and_move(game_id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.accept_proposal_and_move(this.cradle, game_id, readable);
  }

  cancel_proposal(game_id: string): WasmResult | undefined {
    return this.wasm.cancel_proposal(this.cradle, game_id);
  }

  amount(): number {
    return this.wasm.cradle_amount(this.cradle);
  }

  our_share(): number {
    return this.wasm.cradle_our_share(this.cradle);
  }

  their_share(): number {
    return this.wasm.cradle_their_share(this.cradle);
  }

  get_game_state_id(): string | undefined {
    return this.wasm.get_game_state_id(this.cradle);
  }

  serialize(): string {
    return this.wasm.serialize_cradle(this.cradle);
  }

  accept(id: string): WasmResult | undefined {
    return this.wasm.accept_timeout(this.cradle, id);
  }

  shut_down(): WasmResult | undefined {
    return this.wasm.shut_down(this.cradle);
  }

  go_on_chain(): WasmResult | undefined {
    return this.wasm.go_on_chain(this.cradle);
  }

  report_puzzle_and_solution(
    coin_hex: string,
    puzzle_hex: string | undefined,
    solution_hex: string | undefined,
  ): WasmResult | undefined {
    return this.wasm.report_puzzle_and_solution(this.cradle, coin_hex, puzzle_hex, solution_hex);
  }

  make_move(id: string, readable: Uint8Array): WasmResult | undefined {
    return this.wasm.make_move(this.cradle, id, readable);
  }

  make_move_with_entropy_for_testing(id: string, readable: Uint8Array, new_entropy: string): WasmResult | undefined {
    return this.wasm.make_move_with_entropy_for_testing(this.cradle, id, readable, new_entropy);
  }

  cheat(game_id: string, mover_share: number): WasmResult | undefined {
    return this.wasm.cheat(this.cradle, game_id, String(mover_share));
  }

  deliver_message(msg: string): WasmResult | undefined {
    return this.wasm.deliver_message(this.cradle, msg);
  }

  opening_coin(coin_string: string): WasmResult | undefined {
    return this.wasm.opening_coin(this.cradle, coin_string);
  }

  start_handshake(): WasmResult | undefined {
    const maybeStart = (
      this.wasm as unknown as { start_handshake?: (cid: number) => WasmResult | undefined }
    ).start_handshake;
    if (typeof maybeStart !== 'function') return undefined;
    return maybeStart(this.cradle);
  }

  provide_launcher_coin(hex_launcher_coin: string): WasmResult | undefined {
    const maybeProvide = (
      this.wasm as unknown as { provide_launcher_coin?: (cid: number, coin: string) => WasmResult | undefined }
    ).provide_launcher_coin;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.cradle, hex_launcher_coin);
  }

  provide_coin_spend_bundle(bundle_json: string): WasmResult | undefined {
    const maybeProvide = (
      this.wasm as unknown as { provide_coin_spend_bundle?: (cid: number, bundle: string) => WasmResult | undefined }
    ).provide_coin_spend_bundle;
    if (typeof maybeProvide !== 'function') return undefined;
    return maybeProvide(this.cradle, bundle_json);
  }

  provide_offer_bech32(offer_bech32: string): any {
    return this.wasm.provide_offer_bech32(this.cradle, offer_bech32);
  }

  get_channel_puzzle_hash(): string | null {
    const maybeGet = (
      this.wasm as unknown as { get_channel_puzzle_hash?: (cid: number) => string | null }
    ).get_channel_puzzle_hash;
    if (typeof maybeGet !== 'function') return null;
    return maybeGet(this.cradle);
  }

  block_data(block_number: number, block_data: WatchReport): WasmResult | undefined {
    const arrays = [block_data.created_watched, block_data.deleted_watched, block_data.timed_out];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) {
        console.error('[wasm] block_data: non-array field in WatchReport:', block_data);
        return undefined;
      }
      for (const s of arr) {
        if (typeof s !== 'string' || s.length % 2 !== 0) {
          console.error('[wasm] block_data: bad hex element:', JSON.stringify(s),
            'type:', typeof s, 'in report:', JSON.stringify(block_data));
          return undefined;
        }
      }
    }
    return this.wasm.new_block(
      this.cradle,
      block_number,
      block_data.created_watched,
      block_data.deleted_watched,
      block_data.timed_out,
    );
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
  timed_out: string[];
}

function select_cards_using_bits<T>(card: T[], mask: number): T[][] {
  const result0: T[] = [];
  const result1: T[] = [];
  card.forEach((c, i) => {
    if (mask & (1 << i)) {
      result1.push(c);
    } else {
      result0.push(c);
    }
  });
  return [result0, result1];
}

function compare_card(a: number, b: number): number {
  const aRankSuit = cardIdToRankSuit(a);
  const bRankSuit = cardIdToRankSuit(b);
  const rankdiff = aRankSuit.rank - bRankSuit.rank;
  if (rankdiff === 0) {
    return aRankSuit.suit - bRankSuit.suit;
  }
  return rankdiff;
}

export interface PeerConnectionResult {
  sendMessage: (msgno: number, input: string) => void;
  sendAck: (ackMsgno: number) => void;
  sendKeepalive: () => void;
  hostLog: (msg: string) => void;
  close: () => void;
}

export class CalpokerOutcome {
  alice_discards: number;
  bob_discards: number;

  alice_selects: number;
  bob_selects: number;

  alice_hand_value: number[];
  bob_hand_value: number[];

  win_direction: number;
  my_win_outcome: 'win' | 'lose' | 'tie';

  alice_cards: number[];
  bob_cards: number[];

  alice_final_hand: number[];
  bob_final_hand: number[];

  alice_used_cards: number[];
  bob_used_cards: number[];

  my_cards: number[];
  their_cards: number[];
  my_final_hand: number[];
  their_final_hand: number[];
  my_used_cards: number[];
  their_used_cards: number[];
  my_hand_value: number[];
  their_hand_value: number[];

  constructor(
    iStarted: boolean,
    myDiscards: number,
    alice_cards: number[],
    bob_cards: number[],
    readableBytes: number[],
  ) {
    const program = Program.deserialize(Uint8Array.from(readableBytes));
    const result_list = program.toList();
    this.alice_cards = alice_cards;
    this.bob_cards = bob_cards;

    this.alice_selects = result_list[1].toInt();
    this.bob_selects = result_list[2].toInt();
    this.alice_hand_value = result_list[3].toList().map(v => v.toInt());
    this.bob_hand_value = result_list[4].toList().map(v => v.toInt());
    let raw_win_direction = result_list[5].toInt();
    if (iStarted) {
      raw_win_direction *= -1;
      this.alice_discards = result_list[0].toInt();
      this.bob_discards = myDiscards;
    } else {
      this.alice_discards = myDiscards;
      this.bob_discards = result_list[0].toInt();
    }

    this.win_direction = raw_win_direction;
    const alice_win = this.win_direction < 0;

    if (this.win_direction === 0) {
      this.my_win_outcome = 'tie';
    } else if (alice_win) {
      this.my_win_outcome = iStarted ? 'win' : 'lose';
    } else {
      this.my_win_outcome = iStarted ? 'lose' : 'win';
    }

    const [alice_for_alice, alice_for_bob] = select_cards_using_bits(
      this.alice_cards,
      this.alice_discards,
    );
    const [bob_for_bob, bob_for_alice] = select_cards_using_bits(
      this.bob_cards,
      this.bob_discards,
    );

    this.alice_final_hand = [...bob_for_alice];
    alice_for_alice.forEach((c) => this.alice_final_hand.push(c));
    this.alice_final_hand.sort(compare_card);

    this.bob_final_hand = [...alice_for_bob];
    bob_for_bob.forEach((c) => this.bob_final_hand.push(c));
    this.bob_final_hand.sort(compare_card);

    this.alice_used_cards = select_cards_using_bits(
      this.alice_final_hand,
      this.alice_selects,
    )[1];
    this.bob_used_cards = select_cards_using_bits(
      this.bob_final_hand,
      this.bob_selects,
    )[1];

    const iAmAlice = !iStarted;
    this.my_cards = iAmAlice ? this.alice_cards : this.bob_cards;
    this.their_cards = iAmAlice ? this.bob_cards : this.alice_cards;
    this.my_final_hand = iAmAlice ? this.alice_final_hand : this.bob_final_hand;
    this.their_final_hand = iAmAlice ? this.bob_final_hand : this.alice_final_hand;
    this.my_used_cards = iAmAlice ? this.alice_used_cards : this.bob_used_cards;
    this.their_used_cards = iAmAlice ? this.bob_used_cards : this.alice_used_cards;
    this.my_hand_value = iAmAlice ? this.alice_hand_value : this.bob_hand_value;
    this.their_hand_value = iAmAlice ? this.bob_hand_value : this.alice_hand_value;
  }
}

export interface BlockchainReport {
  peak: number;
  block: CoinsetOrgBlockSpend[] | undefined;
  report: WatchReport | undefined;
}

export interface BlockchainInboundAddressResult {
  puzzleHash: string;
}

export interface ConnectionField {
  label: string;
  default: number;
}

export interface ConnectionSetup {
  qrUri: string;
  fields?: { balance?: ConnectionField };
  finalize(values?: { balance?: number }): Promise<void>;
}

export interface InternalBlockchainInterface {
  spend(blob: string, spendBundle: unknown, source?: string, fee?: number): Promise<string>;
  getAddress(): Promise<BlockchainInboundAddressResult>;
  getBalance(): Promise<number>;
  getPuzzleAndSolution(coin: string): Promise<string[] | null>;
  selectCoins(uniqueId: string, amount: number): Promise<string | null>;
  getHeightInfo(): Promise<number>;
  createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: number },
    extraConditions?: Array<{ opcode: number; args: string[] }>,
    coinIds?: string[],
    maxHeight?: number,
  ): Promise<any | null>;
  getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]>;
  registerCoins(names: string[]): Promise<void>;
  startMonitoring(): Promise<void>;

  beginConnect(uniqueId: string): Promise<ConnectionSetup>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
}

export interface OutcomeHandType {
  name: string;
  values: number[];
}

export function cardIdToRankSuit(cardId: number): { rank: number; suit: number } {
  const rank = Math.floor(cardId / 4) + 2;
  const suit = (cardId % 4) + 1;
  return { rank, suit };
}

function aget<T>(handValue: T[], choice: number, def: T): T {
  if (choice > handValue.length || choice < 0) {
    return def;
  }

  return handValue[choice];
}

function rget<T>(array: T[], start: number, end: number, def: T): T[] {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(aget(array, i, def));
  }

  return result;
}

export function handValueToDescription(
  handValue: number[],
  myCards: number[],
): OutcomeHandType {
  const handType = rget(handValue, 0, 3, 0);

  // Hand encoding from onehandcalc.clinc:
  //   straight flush: (5 high_card)
  //   4 of a kind:    (4 1 quad_rank kicker)
  //   full house:     (3 2 set_rank pair_rank)
  //   flush:          (3 1 3 high_card k1 k2 k3 k4)
  //   straight:       (3 1 2 high_card)
  //   set:            (3 1 1 set_rank k1 k2)
  //   two pair:       (2 2 1 high_pair low_pair kicker)
  //   pair:           (2 1 1 1 pair_rank k1 k2 k3)
  //   high card:      (1 1 1 1 1 high k1 k2 k3 k4)

  switch (handType.toString()) {
    case '3,1,3':
      return {
        name: 'Flush',
        values: rget(handValue, 3, 8, 0),
      };

    case '3,1,2':
      return {
        name: 'Straight',
        values: [aget(handValue, 3, 0)],
      };

    case '3,1,1':
      return {
        name: 'Three of a kind',
        values: rget(handValue, 3, 6, 0),
      };

    case '2,2,1':
      return {
        name: 'Two Pair',
        values: rget(handValue, 3, 6, 0),
      };

    case '2,1,1':
      return {
        name: 'Pair',
        values: rget(handValue, 4, 8, 0),
      };
  }

  handType.pop();

  switch (handType.toString()) {
    case '4,1':
      return {
        name: 'Four of a kind',
        values: rget(handValue, 2, 4, 0),
      };

    case '3,2':
      return {
        name: 'Full house',
        values: rget(handValue, 2, 4, 0),
      };
  }

  if (handType[0] == 5) {
    return {
      name: 'Straight flush',
      values: [aget(handValue, 1, 0)],
    };
  }

  return {
    name: 'High card',
    values: rget(handValue, 5, 10, 0),
  };
}
