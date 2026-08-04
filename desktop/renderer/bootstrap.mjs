// Hands the wasm-bindgen glue to the player app, which registers
// `window.loadWasm` from WasmStateInit and announces itself with a
// 'chia-gaming-wasm-loader-ready' event. Either module may evaluate first, so
// both orders are handled.
import * as cg from './chia_gaming_wasm.js';

const deliver = () => window.loadWasm(cg.default, cg);

if (window.loadWasm) {
  deliver();
} else {
  window.addEventListener('chia-gaming-wasm-loader-ready', deliver, { once: true });
}
