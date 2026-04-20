import { WasmInitFn, WasmConnection } from './types/ChiaGaming';

declare global {
  interface Window {
    loadWasm?: (init: WasmInitFn, cg: WasmConnection) => void;
    __buildNonce?: string;
  }
}
