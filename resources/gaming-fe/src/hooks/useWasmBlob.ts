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
  const fetchUrl = process.env.REACT_APP_WASM_URL = 'http://localhost:3001/chia_gaming_wasm_bg.wasm';
  const [wasmConnection, setWasmConnection] = useState<WasmConnection | undefined>(undefined);

  console.log('running chia gaming init');
  useEffect(() => {
    function timerCheckWasm() {
      const chia_gaming_init: any = (window as any).chia_gaming_init;
      if (!chia_gaming_init) {
        console.log('cycling, no wasm');
        setTimeout(() => {
          timerCheckWasm();
        }, 100);
      } else {
        console.log('wasm detected');
        fetch(fetchUrl).then(wasm => wasm.blob()).then(blob => {
          return blob.arrayBuffer();
        }).then(modData => {
          const cg = chia_gaming_init(modData);
          console.log('in react, have chia_gaming', cg);
          cg.init();
          setWasmConnection(cg);
        })
      }
    }

    timerCheckWasm();
  });

  return { wasmConnection };
}
