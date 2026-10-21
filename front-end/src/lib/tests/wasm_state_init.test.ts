import {
  WasmStateInit,
  ensureWasmLoaded,
  startWasmBootstrap,
  storeInitArgs,
  registerWasmLoader,
  _resetWasmLoadForTests,
  _drainClvmDiagnosticsForTests,
  DEBUG_PRESET_FILES,
  PRESET_FILES,
} from '../../hooks/WasmStateInit';
import { completeRegisteredGames, protocolIdentitiesReady } from '../../lib/gameIdentities';
import type { WasmConnection } from '../../types/ChiaGaming';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import { subscribeLog } from '../../services/log';

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
      cache_debug_metadata: jest.fn(),
      diagnose_clvm: jest.fn((token: string) => `trace for ${token}`),
      registered_game_packages: jest.fn(() => [...TEST_PROTOCOL_IDS]),
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
  });

  it('keeps deterministic debug sidecar URLs out of eager presets', () => {
    expect(DEBUG_PRESET_FILES).toEqual(
      PRESET_FILES.map((file) => file.replace(/\.clvm\.bin$/, '.debug.clvm.bin')),
    );
    expect(PRESET_FILES.every((file) => !file.endsWith('.debug.clvm.bin'))).toBe(true);
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
    expect(conn).not.toBe(wasm);
    expect(initCalls).toBe(1);
    expect(initFn).toHaveBeenCalledWith({ module_or_path: 'chia_gaming_wasm_bg.wasm' });
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
    for (const name of PRESET_FILES) {
      expect(fetchPreset).toHaveBeenCalledWith(name);
      expect(wasm.cache_file).toHaveBeenCalledWith(name, expect.any(Uint8Array));
    }

    const again = await new WasmStateInit(fetchPreset).getWasmConnection();
    expect(again).toBe(conn);
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

    await expect(pending).resolves.not.toBe(wasm);
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
    await expect(ensureWasmLoaded()).resolves.not.toBe(wasm);
    expect(initFn).toHaveBeenCalledTimes(2);
    expect(fetchPreset.mock.calls.length).toBeGreaterThan(PRESET_FILES.length);
  });

  it('startWasmBootstrap loads artifacts and binds build-generated protocol ids', async () => {
    const wasm = mockWasm();
    const initFn = jest.fn(async () => {});
    const fetchPreset = jest.fn(async () => new Uint8Array([1, 2, 3]));

    new WasmStateInit(fetchPreset);
    storeInitArgs(initFn, wasm);
    startWasmBootstrap();

    await ensureWasmLoaded();
    completeRegisteredGames(wasm);

    expect(initFn).toHaveBeenCalledTimes(1);
    expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);
    expect(wasm.registered_game_packages).toHaveBeenCalled();
    expect(protocolIdentitiesReady()).toBe(true);
    completeRegisteredGames(wasm);
    expect(protocolIdentitiesReady()).toBe(true);
  });

  it('loads all debug sidecars once after structured-token failures and reuses them', async () => {
    const wasm = mockWasm();
    const originalErrors = ['clvm-one', 'clvm-two', 'clvm-three'].map((token) => {
      const error = new Error(`operation failed ${token}`) as Error & {
        clvmDiagnosticToken: string;
      };
      error.clvmDiagnosticToken = token;
      return error;
    });
    let nextError = 0;
    (wasm as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => {
      throw originalErrors[nextError++];
    });
    const fetchPreset = jest.fn(async (name: string) => new Uint8Array([name.length]));
    const lines: string[] = [];
    const unsubscribe = subscribeLog((line) => lines.push(line));
    lines.length = 0;

    try {
      new WasmStateInit(fetchPreset);
      storeInitArgs(
        jest.fn(async () => {}),
        wasm,
      );
      const connection = await ensureWasmLoaded();
      expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length);

      for (const expected of originalErrors.slice(0, 2)) {
        try {
          connection.make_move(1, '1', new Uint8Array());
          throw new Error('expected operation failure');
        } catch (error) {
          expect(error).toBe(expected);
        }
      }
      await _drainClvmDiagnosticsForTests();

      expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length + DEBUG_PRESET_FILES.length);
      for (const name of DEBUG_PRESET_FILES) {
        expect(wasm.cache_debug_metadata).toHaveBeenCalledWith(name, expect.any(Uint8Array));
      }
      expect(wasm.diagnose_clvm).toHaveBeenCalledTimes(2);

      expect(() => connection.make_move(1, '1', new Uint8Array())).toThrow(originalErrors[2]);
      await _drainClvmDiagnosticsForTests();
      expect(fetchPreset).toHaveBeenCalledTimes(PRESET_FILES.length + DEBUG_PRESET_FILES.length);
      expect(wasm.diagnose_clvm).toHaveBeenCalledTimes(3);
      expect(lines.some((line) => line.includes('trace for clvm-three'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it.each(['fetch', 'cache'] as const)(
    'retries a failed %s without recaching successful sidecars',
    async (failure) => {
      const wasm = mockWasm();
      let recovered = false;
      const cached = new Set<string>();
      (wasm.cache_debug_metadata as jest.Mock).mockImplementation((name: string) => {
        if (cached.has(name)) throw new Error('duplicate sidecar');
        if (!recovered && failure === 'cache' && name === DEBUG_PRESET_FILES[1]) {
          throw new Error('temporary cache failure');
        }
        cached.add(name);
      });
      const fetchPreset = jest.fn(async (name: string) => {
        if (!recovered && failure === 'fetch' && name.endsWith('.debug.clvm.bin')) {
          throw new Error('temporary fetch failure');
        }
        return new Uint8Array([1]);
      });
      const error = Object.assign(new Error('operation failed'), {
        clvmDiagnosticToken: 'clvm-first',
      });
      (wasm as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => {
        throw error;
      });
      new WasmStateInit(fetchPreset);
      storeInitArgs(
        jest.fn(async () => {}),
        wasm,
      );
      const connection = await ensureWasmLoaded();
      expect(() => connection.make_move(1, '1', new Uint8Array())).toThrow(error);
      await _drainClvmDiagnosticsForTests();
      expect(wasm.diagnose_clvm).not.toHaveBeenCalled();
      recovered = true;
      error.clvmDiagnosticToken = 'clvm-retry';
      expect(() => connection.make_move(1, '1', new Uint8Array())).toThrow(error);
      await _drainClvmDiagnosticsForTests();
      expect(wasm.diagnose_clvm).toHaveBeenCalledWith('clvm-retry');
      expect(cached.size).toBe(DEBUG_PRESET_FILES.length);
      for (const name of cached) {
        expect(
          (wasm.cache_debug_metadata as jest.Mock).mock.calls.filter(
            ([cachedName]) => cachedName === name,
          ).length,
        ).toBe(name === DEBUG_PRESET_FILES[1] && failure === 'cache' ? 2 : 1);
      }
    },
  );

  it.each(['fetch', 'malformed'] as const)(
    '%s diagnostic failure preserves the operation error and logs the diagnostic failure',
    async (failure) => {
      const wasm = mockWasm();
      const original = new Error('original operation error') as Error & {
        clvmDiagnosticToken: string;
      };
      original.clvmDiagnosticToken = `clvm-${failure}`;
      (wasm as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => {
        throw original;
      });
      if (failure === 'malformed') {
        (wasm.cache_debug_metadata as jest.Mock).mockImplementation(() => {
          throw new Error('malformed debug metadata');
        });
      }
      const fetchPreset = jest.fn(async (name: string) => {
        if (failure === 'fetch' && name.endsWith('.debug.clvm.bin')) {
          throw new Error('debug metadata unavailable');
        }
        return new Uint8Array([1]);
      });
      const lines: string[] = [];
      const unsubscribe = subscribeLog((line) => lines.push(line));
      lines.length = 0;
      try {
        new WasmStateInit(fetchPreset);
        storeInitArgs(
          jest.fn(async () => {}),
          wasm,
        );
        const connection = await ensureWasmLoaded();
        expect(() => connection.make_move(1, '1', new Uint8Array())).toThrow(original);
        await _drainClvmDiagnosticsForTests();
        expect(lines.some((line) => line.includes('diagnostic failed'))).toBe(true);
        expect(
          lines.some((line) => line.includes(failure === 'fetch' ? 'unavailable' : 'malformed')),
        ).toBe(true);
      } finally {
        unsubscribe();
      }
    },
  );
});
