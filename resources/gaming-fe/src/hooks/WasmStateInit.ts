import {
  WasmConnection,
  ChiaGame,
  RngId,
  InternalBlockchainInterface,
  CreateStartCoinReturn,
  IChiaIdentity,
} from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { WasmBlobWrapper } from './WasmBlobWrapper';

var chia_gaming_init: any = undefined;
var cg: any = undefined;
var logInitialized = false;

export const readyToInit = new Subject<boolean>();
export const waitForReadyToInit = new Observable<boolean>((subscriber) => {
  console.log('subscriber added to waitForReadyToInit');
  console.log('chia_gaming_init=', chia_gaming_init);
  console.log('cg=', cg);
  if (chia_gaming_init && cg) {
    subscriber.next(true);
    subscriber.complete();
    return;
  }
  readyToInit.subscribe(subscriber);
});

export const doInternalLoadWasm = async () => {
  const fetchUrl = '/chia_gaming_wasm_bg.wasm';
  return fetch(fetchUrl)
    .then((wasm) => wasm.blob())
    .then((blob) => {
      return blob.arrayBuffer();
    });
};

export async function fetchHex(fetchUrl: string): Promise<string> {
  // TODO: check
  return fetch(fetchUrl).then((wasm) => wasm.text());
}

//    gameStateInit.foo().then()
export async function storeInitArgs(
  chia_gaming_init_ready: any,
  cg_ready: any,
) {
  // Store information we can't get until the window initializes us with valid data
  chia_gaming_init = chia_gaming_init_ready;
  cg = cg_ready;
  readyToInit.next(true);
}

export class WasmStateInit {
  // Make a wasm connection, and make a fully initialized Wasm blob
  doInternalLoadWasm: () => Promise<ArrayBuffer>;
  wasmConnection: WasmConnection | undefined;
  fetchHex: (key: string) => Promise<string>;
  deferredWasmConnection: Subject<WasmConnection>;

  constructor(
    doInternalLoadWasm: () => Promise<ArrayBuffer>,
    fetchHex: (key: string) => Promise<string>,
  ) {
    this.doInternalLoadWasm = doInternalLoadWasm;
    this.fetchHex = fetchHex;
    this.deferredWasmConnection = new Subject<WasmConnection>();
    console.log("WasmStateInit created")
  }

  /*
observable.subscribe({
  next(x) {
    console.log('got value ' + x);
  },
  error(err) {
    console.error('something wrong occurred: ' + err);
  },
  complete() {
    console.log('done');
  },
});
    */

  async internalLoadWasm(
    chia_gaming_init: any,
    cg: WasmConnection,
  ): Promise<WasmConnection> {
    // Fill out WasmConnection object
    console.log('wasm detected');
    const modData = await this.doInternalLoadWasm();
    chia_gaming_init(modData);
    if (!logInitialized) {
      logInitialized = true;
      cg.init((msg: string) => console.warn('wasm', msg));
    }
    const presetFiles = [
      //'resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex', -- now loaded by crates.io::chia_puzzles
      'clsp/unroll/unroll_meta_puzzle.hex',
      'clsp/unroll/unroll_puzzle_state_channel_unrolling.hex',
      'clsp/referee/onchain/referee.hex',
      'clsp/referee/onchain/referee-v1.hex',
      'clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex',
    ];
    this.wasmConnection = cg;
    await this.loadPresets(presetFiles);

    this.deferredWasmConnection.next(cg);
    this.deferredWasmConnection.complete();
    return cg;
  }

  getWasmConnection(): Promise<WasmConnection> {
    let sub = waitForReadyToInit.subscribe({
      next: () => {
        this.internalLoadWasm(chia_gaming_init, cg);
      },
    });

    return new Promise<WasmConnection>((resolve, reject) => {
      let wcSub = this.deferredWasmConnection.subscribe({
        next: (wasmConnection) => {
          resolve(wasmConnection);
          wcSub.unsubscribe();
        },
      });
    });
  }

  loadPresets(presetFiles: string[]) {
    const presetFetches = presetFiles.map((partialUrl) => {
      return this.fetchHex(partialUrl).then((text) => {
        return {
          name: partialUrl,
          content: text,
        };
      });
    });
    return Promise.all(presetFetches).then((presets) => {
      presets.forEach((nameAndContent) => {
        console.log(
          `preset load ${nameAndContent.name} ${nameAndContent.content.length}`,
        );
        if (!this.wasmConnection) {
          throw 'this.wasmConnection undefined in loadPresets';
        }
        this.wasmConnection?.deposit_file(
          nameAndContent.name,
          nameAndContent.content,
        );
      });

      return {
        setGameConnectionState: {
          stateIdentifier: 'starting',
          stateDetail: ['loaded preset files'],
        },
      };
    });
  }

  createRng(seed: string): RngId | undefined {
    let rng_handle = this.wasmConnection?.create_rng(seed);
    if (rng_handle) {
      return new RngId(rng_handle);
    }
    return undefined;
  }

  // deserializeRng(serializedGame: any) {
  //   return this.wasmConnection?.deserialize_rng(serializedGame);
  // }

  getChiaIdentity(rngSeed: string) {
    // return this.wasmConnection?.chia_identity(rngSeed);
  }

  // need:
  // blockchain for address, do_initial_spend
  //
  async createStartCoin(
    blockchain: InternalBlockchainInterface,
    uniqueId: string,
    identity: IChiaIdentity,
    amount: number,
    wc: WasmConnection,
  ): Promise<CreateStartCoinReturn> {
    if (!identity) {
      throw new Error('create start coin with no identity');
    }
    if (!wc) {
      throw new Error('create start coin with no wasm obj?');
    }
    if (amount < 1) {
      let msg = 'createStartCoin: negative amount:' + amount;
      throw new Error(msg);
    }

    console.log(
      `create coin spendable by ${identity.puzzle_hash} for ${amount}`,
    );

    /*
    TODO: move one call layer up
      .catch((e) => {
        return {
          setError: e.toString(),
        };
      });
    */
    let address = await blockchain.getAddress();

    let inital_spend = await blockchain.do_initial_spend(
      uniqueId,
      identity.puzzle_hash,
      amount,
    );

    let coin = inital_spend.coin;
    if (!coin) {
      throw new Error('tried to create spendable but failed');
    }

    // Handle data conversion back when Coin object was received.
    if (typeof coin !== 'string') {
      const coinset_coin = coin as any;
      const new_coin_string = wc.convert_coinset_to_coin_string(
        coinset_coin.parentCoinInfo,
        coinset_coin.puzzleHash,
        coinset_coin.amount.toString(),
      );
      if (!new_coin_string) {
        throw new Error(
          `Coin could not be converted to coinstring: ${JSON.stringify(coinset_coin)}`,
        );
      }

      coin = new_coin_string;

    }
    return {coinString: coin, blockchainInboundAddressResult: address};
  }

  async loadCalpoker(): Promise<string> {
    return this.fetchHex(
      'clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex',
    );

    /* TODO
    .then((calpoker_hex) => {
      this.calpokerHex = calpoker_hex;
      return {
        setGameConnectionState: {
          stateIdentifier: 'starting',
          stateDetail: ['loaded calpoker'],
        },
      };
    });
    */
  }

  createGame(
    calpokerHex: string,
    rngId: number,
    wasm: WasmConnection,
    private_key: string,
    have_potato: boolean,
    my_contribution: number,
    their_contribution: number,
    rewardPuzzleHash: string,
  ): ChiaGame {
    const env = {
      rng_id: rngId,
      game_types: {
        calpoker: {
          version: 1,
          hex: calpokerHex,
        },
      },
      timeout: 100,
      unroll_timeout: 100,
    };

    let chiaGameId = wasm.create_game_cradle(
      {
        rng_id: env.rng_id,
        game_types: env.game_types,
        identity: private_key,
        have_potato: have_potato,
        my_contribution: { amt: my_contribution },
        their_contribution: { amt: their_contribution },
        channel_timeout: env.timeout,
        unroll_timeout: env.unroll_timeout,
        reward_puzzle_hash: rewardPuzzleHash,
      }
    );

    return new ChiaGame(
      wasm,
      chiaGameId,
      private_key,
      have_potato,
    );

  }


  // getDeserializedWasmBlobWrapper(serializedGame: any) {
  //   let wc = this.wasmConnection;
  //   if (wc) {
  //     let cradleId = wc.create_serialized_game(serializedGame);
  //     let cradle = new ChiaGame(wc, cradleId);
  //     return cradle;
  //   }
  //   return undefined;
  // }

}

export function loadCalpoker(fetchHex: (filename: string) => Promise<string> ): any {
  return fetchHex(
    'clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex',
  );
}
