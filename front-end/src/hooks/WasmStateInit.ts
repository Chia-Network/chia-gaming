import {
  WasmConnection,
  WasmInitFn,
  ChiaGame,
  RngId,
} from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { recoverFromMissingDeployAsset, resolveDeployAssetUrl } from '../lib/deployFreshness';

var chia_gaming_init: WasmInitFn | undefined = undefined;
var cg: WasmConnection | undefined = undefined;
var logInitialized = false;

/** Manual mirror of native startup loads (game_collection + channel/referee). Not auto-traced. */
export const PRESET_FILES = [
  'clsp/unroll/unroll_puzzle_state_channel_unrolling.hex',
  'clsp/referee/onchain/referee.hex',
  'clsp/games/calpoker/calpoker_include_calpoker_factory.hex',
  'clsp/games/spacepoker/spacepoker_include_spacepoker_factory.hex',
  'clsp/games/krunk/krunk_include_krunk_factory.hex',
  'clsp/games/krunk/krunk_signed_dict_tree.dat',
];

const WASM_URL = 'chia_gaming_wasm_bg.wasm';

export async function fetchDeployPreset(fetchUrl: string): Promise<Uint8Array> {
  const url = resolveDeployAssetUrl(fetchUrl);
  const resp = await fetch(url);
  if (!resp.ok) {
    await recoverFromMissingDeployAsset(
      'fetchPreset',
      url,
      resp.status,
      resp.statusText,
    );
  }
  return new Uint8Array(await resp.arrayBuffer());
}

let presetFetcher: (key: string) => Promise<Uint8Array> = fetchDeployPreset;
let loadPromise: Promise<WasmConnection> | null = null;

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

export function storeInitArgs(
  chia_gaming_init_ready: WasmInitFn,
  cg_ready: WasmConnection,
) {
  chia_gaming_init = chia_gaming_init_ready;
  cg = cg_ready;
  readyToInit.next(true);
  // Kick download/compile as soon as the glue is wired (page load), not on Accept.
  void ensureWasmLoaded();
}

async function runWasmLoad(): Promise<WasmConnection> {
  if (!chia_gaming_init || !cg) {
    throw new Error('wasm init args not set');
  }
  const initFn = chia_gaming_init;
  const wasmConn = cg;

  const presetFetches = Promise.all(
    PRESET_FILES.map(async (name) => ({
      name,
      content: await presetFetcher(name),
    })),
  );

  const [, presets] = await Promise.all([
    initFn({ module_or_path: WASM_URL }),
    presetFetches,
  ]);

  if (!logInitialized) {
    logInitialized = true;
    wasmConn.init((msg: string) => console.warn('wasm', msg));
  }

  for (const { name, content } of presets) {
    wasmConn.cache_file(name, content);
  }

  return wasmConn;
}

/**
 * Idempotent while in flight or after success: reuses the same promise.
 * On failure, clears so a later getWasmConnection / Accept can retry.
 * Requires storeInitArgs to have run (or waits for it).
 */
export function ensureWasmLoaded(): Promise<WasmConnection> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        if (!chia_gaming_init || !cg) {
          await new Promise<void>((resolve, reject) => {
            const sub = waitForReadyToInit.subscribe({
              next: () => {
                sub.unsubscribe();
                resolve();
              },
              error: (e) => {
                sub.unsubscribe();
                reject(e);
              },
            });
          });
        }
        return await runWasmLoad();
      } catch (err) {
        loadPromise = null;
        throw err;
      }
    })();
  }
  return loadPromise;
}

/** Test helper: clear module load state between cases. */
export function _resetWasmLoadForTests(): void {
  loadPromise = null;
  logInitialized = false;
  chia_gaming_init = undefined;
  cg = undefined;
  presetFetcher = fetchDeployPreset;
}

export class WasmStateInit {
  wasmConnection: WasmConnection | undefined;
  fetchPreset: (key: string) => Promise<Uint8Array>;

  constructor(
    fetchPreset: (key: string) => Promise<Uint8Array>,
  ) {
    this.fetchPreset = fetchPreset;
    presetFetcher = fetchPreset;
  }

  getWasmConnection(): Promise<WasmConnection> {
    return ensureWasmLoaded().then((wasmConn) => {
      this.wasmConnection = wasmConn;
      return wasmConn;
    });
  }

  createRng(seed: string): RngId | undefined {
    let rng_handle = this.wasmConnection?.create_rng(seed);
    if (rng_handle) {
      return new RngId(rng_handle);
    }
    return undefined;
  }

  getChiaIdentity(rngSeed: string) {
    // return this.wasmConnection?.chia_identity(rngSeed);
  }

  createGame(
    rngId: number,
    wasm: WasmConnection,
    have_potato: boolean,
    my_contribution: bigint,
    their_contribution: bigint,
    rewardPuzzleHash: string,
    channelTimeout = 15,
    unrollTimeout = 15,
  ): { game: ChiaGame, puzzleHash: string } {
    const result = wasm.create_game_session({
      rng_id: rngId,
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
    let chiaGameId = wasm.restore_session(serializedGame, seedHex);
    return new ChiaGame(wasm, chiaGameId);
  }
}
