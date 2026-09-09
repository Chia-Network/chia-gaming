import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';

it('validates a two-spend aggregate signature in real WASM', () => {
  expect(() => WholeWasmObject.test_two_spend_aggregate_signature_validation()).not.toThrow();
});
