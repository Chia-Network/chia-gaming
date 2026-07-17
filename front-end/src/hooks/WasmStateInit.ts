import {
  WasmConnection,
  WasmInitFn,
  ChiaGame,
  RngId,
} from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { SessionController } from './SessionController';

export type GameHexes = Record<string, string>;

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

const WASM_URL = 'chia_gaming_wasm_bg.wasm';

export class WasmStateInit {
  wasmConnection: WasmConnection | undefined;
  fetchPreset: (key: string) => Promise<Uint8Array>;
  deferredWasmConnection: Subject<WasmConnection>;

  constructor(
    fetchPreset: (key: string) => Promise<Uint8Array>,
  ) {
    this.fetchPreset = fetchPreset;
    this.deferredWasmConnection = new Subject<WasmConnection>();
  }

  async internalLoadWasm(
    chia_gaming_init: WasmInitFn,
    cg: WasmConnection,
  ): Promise<WasmConnection> {
    await chia_gaming_init({ module_or_path: WASM_URL });
    if (!logInitialized) {
      logInitialized = true;
      cg.init((msg: string) => console.warn('wasm', msg));
    }
    const presetFiles = [
      //'resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex', -- now loaded by crates.io::chia_puzzles
      'clsp/unroll/unroll_puzzle_state_channel_unrolling.hex',
      'clsp/referee/onchain/referee.hex',
      'clsp/games/calpoker/calpoker_include_calpoker_factory.hex',
      'clsp/games/spacepoker/spacepoker_include_spacepoker_factory.hex',
      'clsp/games/krunk/krunk_include_krunk_factory.hex',
      'clsp/games/krunk/krunk_signed_dict_tree.dat',
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
      return this.fetchPreset(partialUrl).then((bytes) => {
        return {
          name: partialUrl,
          content: bytes,
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

  async loadGameHexes(): Promise<GameHexes> {
    const dec = new TextDecoder();
    const fetchText = (url: string) => this.fetchPreset(url).then(b => dec.decode(b));
    const [calpoker, spacepoker, krunk] = await Promise.all([
      fetchText('clsp/games/calpoker/calpoker_include_calpoker_factory.hex'),
      fetchText('clsp/games/spacepoker/spacepoker_include_spacepoker_factory.hex'),
      fetchText('clsp/games/krunk/krunk_include_krunk_factory.hex'),
    ]);
    return { calpoker, spacepoker, krunk };
  }

  createGame(
    gameHexes: GameHexes,
    rngId: number,
    wasm: WasmConnection,
    have_potato: boolean,
    my_contribution: bigint,
    their_contribution: bigint,
    rewardPuzzleHash: string,
    channelTimeout = 15,
    unrollTimeout = 15,
  ): { game: ChiaGame, puzzleHash: string } {
    const game_types: Record<string, { version: number; hex: string }> = {};
    for (const [name, hex] of Object.entries(gameHexes)) {
      game_types[name] = { version: 1, hex };
    }
    const result = wasm.create_game_session({
      rng_id: rngId,
      game_types,
      have_potato: have_potato,
      my_contribution: { amt: my_contribution },
      their_contribution: { amt: their_contribution },
      channel_timeout: channelTimeout,
      unroll_timeout: unrollTimeout,
      reward_puzzle_hash: rewardPuzzleHash,
    });

    return {
      game: new ChiaGame(wasm, result.id),
      puzzleHash: result.puzzle_hash,
    };
  }

  deserializeGame(
    wasm: WasmConnection,
    serializedGame: Uint8Array,
  ): ChiaGame {
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const seedHex = Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
    let chiaGameId = wasm.create_serialized_game(serializedGame, seedHex);
    return new ChiaGame(wasm, chiaGameId);
  }
}

export async function loadGameHexes(fetchHex: (filename: string) => Promise<string>): Promise<GameHexes> {
  const [calpoker, spacepoker, krunk] = await Promise.all([
    fetchHex('clsp/games/calpoker/calpoker_include_calpoker_factory.hex'),
    fetchHex('clsp/games/spacepoker/spacepoker_include_spacepoker_factory.hex'),
    fetchHex('clsp/games/krunk/krunk_include_krunk_factory.hex'),
  ]);
  return { calpoker, spacepoker, krunk };
}
