import { WasmInitFn, WasmConnection } from './types/ChiaGaming';

declare global {
  interface Window {
    loadWasm?: (init: WasmInitFn, cg: WasmConnection) => void;
    __chiaDistribution?: string;
    /** Exposed by the desktop preload in the top-level frame only. */
    __chiaHub?: {
      requestTrust: (
        origin: string,
      ) => Promise<'trusted' | 'granted' | 'invalid' | 'persist-failed'>;
    };
  }
}
