export type Amount = {
  "amt": number,
};

export type Spend = {
  "puzzle": string,
  "solution": string,
  "signature": string
};

export type CoinSpend = {
  "coin": string,
  "bundle": Spend
};

export type SpendBundle = {
  "spends": Array<CoinSpend>
};

export type IChiaIdentity = {
  "private_key": string,
  "synthetic_private_key": string,
  "public_key": string,
  "synthetic_public_key": string,
  "puzzle": string,
  "puzzle_hash": string,
};

export type GameConnectionState = {
  stateIdentifier: string,
  stateDetail: string[]
};

export type OpponentMove = [string, string];
export type GameFinished = [string, number];

export type IdleResult = {
  "continue_on": boolean,
  "outbound_transactions": Array<SpendBundle>,
  "outbound_messages": Array<string>,
  "opponent_move": OpponentMove | undefined,
  "game_finished": GameFinished | undefined,
  "handshake_done": boolean,
  "receive_error": string | undefined,
  "action_queue": Array<string>,
  "incoming_messages": Array<string>
};

export type GameCradleConfig = {
  "seed": string | undefined,
  "game_types": Map<string, string>,
  "identity": string | undefined,
  "have_potato": boolean,
  "my_contribution": Amount,
  "their_contribution": Amount,
  "channel_timeout": number,
  "reward_puzzle_hash": string,
  "receive_error": string | undefined
};

export type IChiaIdentityFun = (seed: string) => IChiaIdentity;

export type IdleCallbacks = {
  self_move?: ((game_id: string, move_hex: string) => void) | undefined,
  opponent_moved?: ((game_id: string, readable_move_hex: string) => void) | undefined,
  game_message?: ((game_id: string, readable_move_hex: string) => void) | undefined,
  game_finished?: ((game_id: string) => void) | undefined,
  shutdown_complete?: ((coin: string) => void) | undefined,
  going_on_chain?: (() => void) | undefined
};

export interface WasmConnection {
  // System
  init: (print: any) => any;
  create_game_cradle: (config: any) => number;
  deposit_file: (name: string, data: string) => any;

  // Blockchain
  opening_coin: (cid: number, coinstring: string) => any;
  new_block: (cid: number, height: number, additions: string[], removals: string[], timed_out: string[]) => any;

  // Game
  start_games: (cid: number, initiator: boolean, game: any) => any;
  make_move_entropy: (cid: number, id: string, readable: string, new_entropy: string) => any;
  make_move: (cid: number, id: string, readable: string) => any;
  accept: (cid: number, id: string) => any;
  shut_down: (cid: number) => any;
  deliver_message: (cid: number, inbound_message: string) => any;
  idle: (cid: number, callbacks: any) => any;

  // Misc
  chia_identity: (seed: string) => any;
  sha256bytes: (hex: string) => string;
};

export class ChiaGame {
  wasm: WasmConnection;
  waiting_messages: Array<string>;
  private_key: string;
  cradle: number;
  have_potato: boolean;

  constructor(wasm: WasmConnection, env: any, seed: string, identity: IChiaIdentity, have_potato: boolean, my_contribution: number, their_contribution: number) {
    this.wasm = wasm;
    this.waiting_messages = [];
    this.private_key = identity.private_key;
    this.have_potato = have_potato;
    this.cradle = wasm.create_game_cradle({
      seed: seed,
      game_types: env.game_types,
      identity: identity.private_key,
      have_potato: have_potato,
      my_contribution: {amt: my_contribution},
      their_contribution: {amt: their_contribution},
      channel_timeout: env.timeout,
      unroll_timeout: env.unroll_timeout,
      reward_puzzle_hash: identity.puzzle_hash,
    });
    console.log(`constructed ${have_potato} cradle ${this.cradle}`);
  }

  start_games(initiator: boolean, game: any): string[] {
    return this.wasm.start_games(this.cradle, initiator, game);
  }

  make_move_entropy(id: string, readable: string, new_entropy: string): any {
    return this.wasm.make_move_entropy(this.cradle, id, readable, new_entropy);
  }

  deliver_message(msg: string) {
    this.wasm.deliver_message(this.cradle, msg);
  }

  opening_coin(coin_string: string) {
    this.wasm.opening_coin(this.cradle, coin_string);
  }

  quiet(): boolean {
    return this.waiting_messages.length === 0;
  }

  outbound_messages(): Array<string> {
    let w = this.waiting_messages;
    this.waiting_messages = [];
    return w;
  }

  idle(callbacks: IdleCallbacks) : IdleResult {
    let result = this.wasm.idle(this.cradle, callbacks);
    this.waiting_messages = this.waiting_messages.concat(result.outbound_messages);
    return result;
  }

  block_data(block_number: number, block_data: any) {
    this.wasm.new_block(this.cradle, block_number, block_data.created, block_data.deleted, block_data.timed_out);
  }
}

export interface WatchReport {
  created: string[];
  deleted: string[];
  timed_out: string[];
}

export interface BlockchainConnection {
  getToken: () => string;

  // Blockchain
  get_peak: () => Promise<number>;
  get_block_data: (block: number) => Promise<WatchReport | null>;
  wait_block: () => Promise<number>;
  get_puzzle_and_solution: (coin: string) => Promise<string[] | null>;
  spend: (clvm_hex_spend_blob: string) => Promise<(number | null)[]>;
  create_spendable: (target_ph: string, amount: number) => Promise<string | null>;
};

export class ExternalBlockchainInterface {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  getToken(): string {
    return this.token;
  }

  getPeak(): Promise<number> {
    return fetch(`${this.baseUrl}/get_peak`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }

  getBlockData(block: number): Promise<WatchReport | null> {
    return fetch(`${this.baseUrl}/get_block_data?block=${block}`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }

  waitBlock(): Promise<number> {
    return fetch(`${this.baseUrl}/wait_block`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }

  getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return fetch(`${this.baseUrl}/get_puzzle_and_solution?coin=${coin}`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }

  spend(spend_data_clvm_hex: string): Promise<(number | null)[]> {
    return fetch(`${this.baseUrl}/spend?blob=${spend_data_clvm_hex}`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }

  createSpendable(target_ph: string, amt: number): Promise<string | null> {
    return fetch(`${this.baseUrl}/create_spendable?who=${this.token}&target=${target_ph}&amount=${amt}`, {
      body: '', method: 'POST'
    }).then(f => f.json());
  }
}
