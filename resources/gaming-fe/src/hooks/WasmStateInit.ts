import { WasmConnection, ChiaGame, RngId, WasmBlobParams } from '../types/ChiaGaming';
import { Observable, Subject } from 'rxjs';
import { GAME_SERVICE_URL } from '../settings';
import { WasmBlobWrapper } from './WasmBlobWrapper';

var chia_gaming_init: any = undefined;
var cg: any = undefined;
var logInitialized = false;

export const readyToInit = new Subject<boolean>();
export const waitForReadyToInit = new Observable<boolean>((subscriber) => {
    console.log("subscriber added to waitForReadyToInit");
    console.log("chia_gaming_init={chia_gaming_init} cg={cg}");
    if (chia_gaming_init && cg) {
        subscriber.next(true);
        subscriber.complete();
        return;
    }
    readyToInit.subscribe(subscriber);
});

export const doInternalLoadWasm = async () => {
    const fetchUrl = GAME_SERVICE_URL + '/chia_gaming_wasm_bg.wasm';
    return fetch(fetchUrl).then(wasm => wasm.blob()).then(blob => {
    return blob.arrayBuffer();
    });
};

export async function fetchHex(fetchUrl: string): Promise<string> {
    // TODO: check
    return fetch(fetchUrl).then(wasm => wasm.text());
}

//    gameStateInit.foo().then()
export async function storeInitArgs(chia_gaming_init_ready: any, cg_ready: any) {
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

    constructor(doInternalLoadWasm : () => Promise<ArrayBuffer>, fetchHex: (key: string) => Promise<string>) {
        this.doInternalLoadWasm = doInternalLoadWasm;
        this.fetchHex = fetchHex;
        this.deferredWasmConnection = new Subject<WasmConnection>();
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

    async internalLoadWasm(chia_gaming_init: any, cg: WasmConnection): Promise<WasmConnection> {
        // Fill out WasmConnection object
        console.log('wasm detected');
        const modData = await this.doInternalLoadWasm();
        chia_gaming_init(modData);
        if (!logInitialized) {
            logInitialized = true;
            cg.init((msg: string) => console.warn('wasm', msg));
        }
        const presetFiles = [
            "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex",
            "clsp/unroll/unroll_meta_puzzle.hex",
            "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
            "clsp/referee/onchain/referee.hex",
            "clsp/referee/onchain/referee-v1.hex"
        ];
        this.wasmConnection = cg;
        await this.loadPresets(presetFiles);

        this.deferredWasmConnection.next(cg);
        this.deferredWasmConnection.complete();
        return cg;
    }

    getWasmConnection() : Promise<WasmConnection> {
        let sub = waitForReadyToInit.subscribe({next: () => {
            this.internalLoadWasm(chia_gaming_init, cg);
        }});

        return new Promise<WasmConnection>((resolve, reject) => {
            let wcSub = this.deferredWasmConnection.subscribe({
                next: (wasmConnection) => {
                    resolve(wasmConnection);
                    wcSub.unsubscribe();
                }
            })
        })
    }

    getWasmBlobWrapper(wasmConnection: WasmConnection, wasmParams: WasmBlobParams) : WasmBlobWrapper {
        return new WasmBlobWrapper(wasmParams, wasmConnection);
    }

    loadPresets(presetFiles: string[]) {
        const presetFetches = presetFiles.map((partialUrl) => {
            return this.fetchHex(partialUrl).then((text) => {
                return {
                name: partialUrl,
                content: text
                };
            });
        });
        return Promise.all(presetFetches).then(presets => {
            presets.forEach((nameAndContent) => {
                console.log(`preset load ${nameAndContent.name} ${nameAndContent.content.length}`);
                if (!this.wasmConnection) { throw("this.wasmConnection undefined in loadPresets"); }
                this.wasmConnection?.deposit_file(nameAndContent.name, nameAndContent.content);
            });

            return {
                'setGameConnectionState': {
                stateIdentifier: "starting",
                stateDetail: ["loaded preset files"]
                }
            };
        });
    };

    createRng(seed: string) : RngId | undefined {
        let rng_handle = this.wasmConnection?.create_rng(seed);
        if (rng_handle) {
            return new RngId(rng_handle);
        }
        return undefined;
    }

    deserializeRng(serializedGame: any) {
        return this.wasmConnection?.deserialize_rng(serializedGame);
    }

    getChiaIdentity(rngSeed: string) {
        // return this.wasmConnection?.chia_identity(rngSeed);
    }

    getDeserializedWasmBlobWrapper(serializedGame: any) {
        let wc = this.wasmConnection;
        if (wc) {
            let cradleId = wc.create_serialized_game(serializedGame);
            let cradle = new ChiaGame(wc, cradleId);
            return cradle;
        }
        return undefined;
    }
}
