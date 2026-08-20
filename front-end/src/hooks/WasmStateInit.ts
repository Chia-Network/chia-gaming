import { WasmConnection, WasmInitFn, ChiaGame, RngId } from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { recoverFromMissingDeployAsset, resolveDeployAssetUrl } from '../lib/deployFreshness';
import { _resetGameIdentityWarmupForTests, warmRegisteredGames } from '../lib/gameIdentities';
import { PRESET_FILES } from '../generated/gamePresets';

let chia_gaming_init: WasmInitFn | undefined = undefined;
let cg: WasmConnection | undefined = undefined;
let logInitialized = false;

export { PRESET_FILES };

const WASM_URL = 'chia_gaming_wasm_bg.wasm';

export async function fetchDeployPreset(fetchUrl: string): Promise<Uint8Array> {
  const url = resolveDeployAssetUrl(fetchUrl);
  const resp = await fetch(url);
  if (!resp.ok) {
    await recoverFromMissingDeployAsset('fetchPreset', url, resp.status, resp.statusText);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

let presetFetcher: (key: string) => Promise<Uint8Array> = fetchDeployPreset;
let loadPromise: Promise<WasmConnection> | null = null;

type WasmLoaderTarget = {
  loadWasm?: (init: WasmInitFn, wasmConn: WasmConnection) => void;
  dispatchEvent(event: Event): boolean;
};

export function registerWasmLoader(target: WasmLoaderTarget): void {
  target.loadWasm = (init: WasmInitFn, wasmConn: WasmConnection) => {
    storeInitArgs(init, wasmConn);
  };
  target.dispatchEvent(new Event('chia-gaming-wasm-loader-ready'));
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

if (typeof window !== 'undefined') {
  registerWasmLoader(window);
}

export function storeInitArgs(chia_gaming_init_ready: WasmInitFn, cg_ready: WasmConnection) {
  chia_gaming_init = chia_gaming_init_ready;
  cg = cg_ready;
  readyToInit.next(true);
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

  const [, presets] = await Promise.all([initFn({ module_or_path: WASM_URL }), presetFetches]);

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
 * Start WASM + preset fetch on page load, then probe factories in the
 * background. Handshake only needs the loaded module; protocol identities
 * are bound later when the channel is live.
 */
export function startWasmBootstrap(): void {
  void ensureWasmLoaded()
    .then((wasm) => warmRegisteredGames(wasm))
    .catch((err) => {
      console.warn('wasm bootstrap failed', err);
    });
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
  _resetGameIdentityWarmupForTests();
}

export class WasmStateInit {
  wasmConnection: WasmConnection | undefined;
  fetchPreset: (key: string) => Promise<Uint8Array>;

  constructor(fetchPreset: (key: string) => Promise<Uint8Array>) {
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
    const rng_handle = this.wasmConnection?.create_rng(seed);
    if (rng_handle) {
      return new RngId(rng_handle);
    }
    return undefined;
  }

  createGame(
    rngId: number,
    wasm: WasmConnection,
    have_potato: boolean,
    my_contribution: bigint,
    their_contribution: bigint,
    rewardPuzzleHash: string,
    genesisChallenge: string,
    channelTimeout = 15,
    unrollTimeout = 15,
  ): { game: ChiaGame; puzzleHash: string } {
    const result = wasm.create_game_session({
      rng_id: rngId,
      have_potato: have_potato,
      my_contribution: { amt: my_contribution },
      their_contribution: { amt: their_contribution },
      channel_timeout: channelTimeout,
      unroll_timeout: unrollTimeout,
      reward_puzzle_hash: rewardPuzzleHash,
      genesis_challenge: genesisChallenge,
    });

    return {
      game: new ChiaGame(wasm, result.id),
      puzzleHash: result.puzzle_hash,
    };
  }

  deserializeGame(wasm: WasmConnection, serializedGame: Uint8Array): ChiaGame {
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const seedHex = Array.from(entropy, (b) => b.toString(16).padStart(2, '0')).join('');
    const chiaGameId = wasm.restore_session(serializedGame, seedHex);
    return new ChiaGame(wasm, chiaGameId);
  }
}
