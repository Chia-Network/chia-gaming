import { useState, useEffect, useRef, useCallback } from 'react';

interface WasmConnection {
  // System
  init: () => any;
  create_game_cradle: (config: any) => number;
  deposit_file: (name: string, data: string) => any;

  // Blockchain
  opening_coin: (cid: number, coinstring: string) => any;
  new_block: (cid: number, height: number, additions: string[], removals: string[], timed_out: string[]) => any;

  // Game
  start_games: (cid: number, initiator: boolean, game: any) => any;
  make_move_entropy: (cid: number, id: string, readable: string, new_entropy: string) => any;
  make_move: (cid: number, id: string, readable: string) => any;
  accept: (cid: number, id: string) => any;
  shut_down: (cid: number) => any;
  deliver_message: (cid: number, inbound_message: string) => any;
  idle: (cid: number, callbacks: any) => any;

  // Misc
  chia_identity: (seed: string) => any;
  sha256bytes: (hex: string) => string;
};

export function useWasmBlob() {
  const WASM_URL = process.env.REACT_APP_WASM_BLOB_URL || "http://localhost:3000/chia-gaming.wasm";

  const [wasmConnection, setWasmConnection] = useState<WasmConnection | undefined>(undefined);

  fetch(WASM_URL).then(r => r.blob()).then(blob => {
    const moduleParams = {
      module: {},
      env: {
        memory: new WebAssembly.Memory({ initial: 4096 * 1024 })
      }
    };
    return WebAssembly.instantiate(blob, moduleParams);
  }).then(wasmResult => {
    console.log('wasmLoadResult', wasmResult);
  });

  return { wasmConnection };
}
