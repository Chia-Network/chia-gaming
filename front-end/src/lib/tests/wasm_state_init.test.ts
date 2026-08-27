import {
  WasmStateInit,
  ensureWasmLoaded,
  startWasmBootstrap,
  storeInitArgs,
  registerWasmLoader,
  _resetWasmLoadForTests,
  PRESET_FILES,
} from '../../hooks/WasmStateInit';
import { PRODUCTION_PACKAGE_KEYS } from '../../generated/gamePackages';
import {
  completeRegisteredGames,
  protocolIdentitiesReady,
  warmRegisteredGames,
} from '../../lib/gameIdentities';
import type { WasmConnection } from '../../types/ChiaGaming';
import { mockGamePackageIdentity, TEST_PROTOCOL_IDS } from './protocolIdentities';

describe('WasmStateInit lazy load', () => {
  beforeEach(() => {
    _resetWasmLoadForTests();
  });

  afterEach(() => {
    _resetWasmLoadForTests();
  });

  function mockWasm(): WasmConnection {
    return {
      init: jest.fn(),
      cache_file: jest.fn(),
      registered_game_packages: jest.fn(() => [...TEST_PROTOCOL_IDS]),
      warm_game_package: jest.fn((key: string) => mockGamePackageIdentity(key)),
    } as unknown as WasmConnection;
  }

  it('does not fetch WASM or presets until bootstrap or a session starts', () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    const fetchPreset = jest.fn(async () => new Uint8Array([1, 2, 3]));

    new WasmStateInit(fetchPreset);
    storeInitArgs(initFn, wasm);

    expect(initFn).not.toHaveBeenCalled();
    expect(fetchPreset).not.toHaveBeenCalled();
    expect(wasm.warm_game_package).not.toHaveBeenCalled();
  });

  it('notifies glue after registering window.loadWasm', () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    const target = {
      dispatchEvent: jest.fn(() => true),
    };

    registerWasmLoader(target);

    expect(target.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chia-gaming-wasm-loader-ready' }),
    );
    expect(target.loadWasm).toBeDefined();
    target.loadWasm!(initFn, wasm);

    expect(initFn).not.toHaveBeenCalled();
  });

  it('ensureWasmLoaded is idempotent and loads presets in parallel with init', async () => {
    const wasm = mockWasm();
    let initCalls = 0;
    const initFn = jest.fn(async () => {
      initCalls += 1;
    });

    const fetchPreset = jest.fn(async (_key: string) => new Uint8Array([1, 2, 3]));

    new WasmStateInit(fetchPreset);
    storeInitArgs(initFn, wasm);

    const p1 = ensureWasmLoaded();
    const p2 = ensureWasmLoaded();
    expect(p1).toBe(p2);

    const conn = await p1;
    expect(conn).toBe(wasm);
    expect(initCalls).toBe(1);
    expect(initFn).toHaveBeenCalledWith({ module_or_path: 'chia_gaming_wasm_bg.wasm' });
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
    for (const name of PRESET_FILES) {
      expect(fetchPreset).toHaveBeenCalledWith(name);
      expect(wasm.cache_file).toHaveBeenCalledWith(name, expect.any(Uint8Array));
    }

    const again = await new WasmStateInit(fetchPreset).getWasmConnection();
    expect(again).toBe(wasm);
    expect(initCalls).toBe(1);
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
  });

  it('getWasmConnection waits for storeInitArgs when called first', async () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    const fetchPreset = jest.fn(async () => new Uint8Array([9]));

    const wsi = new WasmStateInit(fetchPreset);
    const pending = wsi.getWasmConnection();

    // Allow the wait subscription to attach before wiring init args.
    await Promise.resolve();
    storeInitArgs(initFn, wasm);

    await expect(pending).resolves.toBe(wasm);
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
  });

  it('retries after a failed load instead of pinning the rejection', async () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    let failOnce = true;
    const fetchPreset = jest.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient preset fetch');
      }
      return new Uint8Array([1]);
    });

    new WasmStateInit(fetchPreset);
    storeInitArgs(initFn, wasm);

    await expect(ensureWasmLoaded()).rejects.toThrow('transient preset fetch');
    await expect(ensureWasmLoaded()).resolves.toBe(wasm);
    expect(initFn).toHaveBeenCalledTimes(2);
    expect(fetchPreset.mock.calls.length).toBeGreaterThan(PRESET_FILES.length);
  });

  it('startWasmBootstrap loads and warms factories until the protocol id table is complete', async () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    const fetchPreset = jest.fn(async () => new Uint8Array([1, 2, 3]));

    new WasmStateInit(fetchPreset);
    storeInitArgs(initFn, wasm);
    startWasmBootstrap();

    await warmRegisteredGames(wasm);

    expect(initFn).toHaveBeenCalledTimes(1);
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
    expect(wasm.warm_game_package).toHaveBeenCalledTimes(PRODUCTION_PACKAGE_KEYS.length);
    for (const key of PRODUCTION_PACKAGE_KEYS) {
      expect(wasm.warm_game_package).toHaveBeenCalledWith(key);
    }
    expect(protocolIdentitiesReady()).toBe(true);
    completeRegisteredGames(wasm);
    expect(protocolIdentitiesReady()).toBe(true);
  });
});
