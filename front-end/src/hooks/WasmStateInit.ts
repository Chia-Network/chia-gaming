import type { PeerProtocolApi } from '../../../wasm/contract';
import { WasmConnection, WasmInitFn, ChiaGame } from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { recoverFromMissingDeployAsset, resolveDeployAssetUrl } from '../lib/deployFreshness';
import { _resetGameIdentityWarmupForTests, completeRegisteredGames } from '../lib/gameIdentities';
import { PRESET_FILES } from '../generated/gamePresets';
import {
  installPeerProtocol,
  isPeerProtocolInstalled,
  resetPeerProtocolForTests,
} from '../services/peerProtocol';

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
let moduleLoadPromise: Promise<WasmConnection> | null = null;

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

async function waitForInitArgs(): Promise<void> {
  if (chia_gaming_init && cg) return;
  await new Promise<void>((resolve, reject) => {
    const sub = waitForReadyToInit.subscribe({
      next: () => {
        sub.unsubscribe();
        resolve();
      },
      error: reject,
    });
  });
}

function ensureWasmModuleLoaded(): Promise<WasmConnection> {
  if (!moduleLoadPromise) {
    moduleLoadPromise = (async () => {
      try {
        await waitForInitArgs();
        const initFn = chia_gaming_init!;
        const wasmConn = cg!;
        await initFn({ module_or_path: WASM_URL });
        if (!logInitialized) {
          logInitialized = true;
          wasmConn.init();
        }
        installPeerProtocol(wasmConn.create_peer_protocol);
        return wasmConn;
      } catch (error) {
        moduleLoadPromise = null;
        throw error;
      }
    })();
  }
  return moduleLoadPromise;
}

/** Hub delivery needs the Rust peer engine, independently of game assets. */
export async function ensurePeerProtocolLoaded(): Promise<void> {
  if (isPeerProtocolInstalled()) return;
  await ensureWasmModuleLoaded();
}

async function runWasmLoad(): Promise<WasmConnection> {
  const presetFetches = Promise.all(
    PRESET_FILES.map(async (name) => ({ name, content: await presetFetcher(name) })),
  );
  const [wasmConn, presets] = await Promise.all([ensureWasmModuleLoaded(), presetFetches]);
  for (const { name, content } of presets) wasmConn.cache_file(name, content);
  return wasmConn;
}

/**
 * Start WASM + preset fetch on page load, then bind build-generated protocol
 * identities without executing factories.
 */
export function startWasmBootstrap(): void {
  void ensureWasmLoaded()
    .then((wasm) => completeRegisteredGames(wasm))
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
        await waitForInitArgs();
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
  resetPeerProtocolForTests();
  loadPromise = null;
  moduleLoadPromise = null;
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

  deserializeGame(serializedGame: Uint8Array, peer: PeerProtocolApi): ChiaGame {
    peer.restore_channel(serializedGame);
    return peer;
  }
}
