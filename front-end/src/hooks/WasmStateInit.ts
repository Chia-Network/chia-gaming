import {
  WasmConnection,
  WasmInitFn,
  ChiaGame,
  RngId,
} from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { WasmBlobWrapper } from './WasmBlobWrapper';

var chia_gaming_init: WasmInitFn | undefined = undefined;
var cg: WasmConnection | undefined = undefined;
var logInitialized = false;

if (typeof window !== 'undefined') {
  window.loadWasm = (init: WasmInitFn, wasmConn: WasmConnection) => {
    storeInitArgs(init, wasmConn);
  };
}

export const readyToInit = new Subject<boolean>();
export const waitForReadyToInit = new Observable<boolean>((subscriber) => {
  if (chia_gaming_init && cg) {
    subscriber.next(true);
    subscriber.complete();
    return;
  }
  readyToInit.subscribe(subscriber);
});

export const doInternalLoadWasm = async () => {
  const fetchUrl = '/chia_gaming_wasm_bg.wasm';
  return fetch(fetchUrl)
    .then((wasm) => wasm.blob())
    .then((blob) => {
      return blob.arrayBuffer();
    });
};

export async function fetchHex(fetchUrl: string): Promise<string> {
  // TODO: check
  return fetch(fetchUrl).then((wasm) => wasm.text());
}

//    gameStateInit.foo().then()
export async function storeInitArgs(
  chia_gaming_init_ready: WasmInitFn,
  cg_ready: WasmConnection,
) {
  // Store information we can't get until the window initializes us with valid data
  chia_gaming_init = chia_gaming_init_ready;
  cg = cg_ready;
  readyToInit.next(true);
}

export class WasmStateInit {
  // Make a wasm connection, and make a fully initialized Wasm blob
  doInternalLoadWasm: () => Promise<ArrayBuffer>;
  wasmConnection: WasmConnection | undefined;
  fetchHex: (key: string) => Promise<string>;
  deferredWasmConnection: Subject<WasmConnection>;

  constructor(
    doInternalLoadWasm: () => Promise<ArrayBuffer>,
    fetchHex: (key: string) => Promise<string>,
  ) {
    this.doInternalLoadWasm = doInternalLoadWasm;
    this.fetchHex = fetchHex;
    this.deferredWasmConnection = new Subject<WasmConnection>();
  }

  async internalLoadWasm(
    chia_gaming_init: WasmInitFn,
    cg: WasmConnection,
  ): Promise<WasmConnection> {
    // Fill out WasmConnection object
    const modData = await this.doInternalLoadWasm();
    chia_gaming_init({ module: modData });
    if (!logInitialized) {
      logInitialized = true;
      cg.init((msg: string) => console.warn('wasm', msg));
    }
    const presetFiles = [
      //'resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex', -- now loaded by crates.io::chia_puzzles
      'clsp/unroll/unroll_meta_puzzle.hex',
      'clsp/unroll/unroll_puzzle_state_channel_unrolling.hex',
      'clsp/referee/onchain/referee.hex',
      'clsp/games/calpoker/calpoker_include_calpoker_make_proposal.hex',
      'clsp/games/calpoker/calpoker_include_calpoker_parser.hex',
    ];
    this.wasmConnection = cg;
    await this.loadPresets(presetFiles);

    this.deferredWasmConnection.next(cg);
    this.deferredWasmConnection.complete();
    return cg;
  }

  getWasmConnection(): Promise<WasmConnection> {
    waitForReadyToInit.subscribe({
      next: () => {
        if (!chia_gaming_init || !cg) throw new Error('wasm init args not set');
        this.internalLoadWasm(chia_gaming_init, cg);
      },
    });

    return new Promise<WasmConnection>((resolve, reject) => {
      let wcSub = this.deferredWasmConnection.subscribe({
        next: (wasmConnection) => {
          resolve(wasmConnection);
          wcSub.unsubscribe();
        },
      });
    });
  }

  loadPresets(presetFiles: string[]) {
    const presetFetches = presetFiles.map((partialUrl) => {
      return this.fetchHex(partialUrl).then((text) => {
        return {
          name: partialUrl,
          content: text,
        };
      });
    });
    return Promise.all(presetFetches).then((presets) => {
      presets.forEach((nameAndContent) => {
        if (!this.wasmConnection) {
          throw new Error('this.wasmConnection undefined in loadPresets');
        }
        this.wasmConnection?.deposit_file(
          nameAndContent.name,
          nameAndContent.content,
        );
      });

      return {
        setGameConnectionState: {
          stateIdentifier: 'starting',
          stateDetail: ['loaded preset files'],
        },
      };
    });
  }

  createRng(seed: string): RngId | undefined {
    let rng_handle = this.wasmConnection?.create_rng(seed);
    if (rng_handle) {
      return new RngId(rng_handle);
    }
    return undefined;
  }

  // deserializeRng(serializedGame: any) {
  //   return this.wasmConnection?.deserialize_rng(serializedGame);
  // }

  getChiaIdentity(rngSeed: string) {
    // return this.wasmConnection?.chia_identity(rngSeed);
  }

  async loadCalpoker(): Promise<{proposalHex: string, parserHex: string}> {
    const [proposalHex, parserHex] = await Promise.all([
      this.fetchHex('clsp/games/calpoker/calpoker_include_calpoker_make_proposal.hex'),
      this.fetchHex('clsp/games/calpoker/calpoker_include_calpoker_parser.hex'),
    ]);
    return { proposalHex, parserHex };
  }

  createGame(
    calpokerHex: string,
    calpokerParserHex: string,
    rngId: number,
    wasm: WasmConnection,
    have_potato: boolean,
    my_contribution: bigint,
    their_contribution: bigint,
    rewardPuzzleHash: string,
  ): { game: ChiaGame, puzzleHash: string } {
    const result = wasm.create_game_cradle({
      rng_id: rngId,
      game_types: {
        calpoker: {
          version: 1,
          hex: calpokerHex,
          parser_hex: calpokerParserHex,
        },
      },
      have_potato: have_potato,
      my_contribution: { amt: my_contribution },
      their_contribution: { amt: their_contribution },
      channel_timeout: 15,
      unroll_timeout: 15,
      reward_puzzle_hash: rewardPuzzleHash,
    });

    return {
      game: new ChiaGame(wasm, result.id),
      puzzleHash: result.puzzle_hash,
    };
  }

  deserializeGame(
    wasm: WasmConnection,
    serializedGame: string,
  ): ChiaGame {
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const seedHex = Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
    let chiaGameId = wasm.create_serialized_game(serializedGame, seedHex);
    return new ChiaGame(wasm, chiaGameId);
  }
}

export async function loadCalpoker(fetchHex: (filename: string) => Promise<string> ): Promise<{proposalHex: string, parserHex: string}> {
  const [proposalHex, parserHex] = await Promise.all([
    fetchHex('clsp/games/calpoker/calpoker_include_calpoker_make_proposal.hex'),
    fetchHex('clsp/games/calpoker/calpoker_include_calpoker_parser.hex'),
  ]);
  return { proposalHex, parserHex };
}
