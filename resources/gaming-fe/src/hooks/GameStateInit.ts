import { PeerConnectionResult, WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, WatchReport, BlockchainReport, InternalBlockchainInterface, RngId } from '../types/ChiaGaming';
import { ChiaGameParams, getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount, empty } from '../util';
import { Observable, NextObserver } from 'rxjs';

/*
    1. Detect presence of Wasm Loader
    2. Call Wasm Loader to yield a WasmConnection

    WasmBlobWrapper


    serialize_cradle: (cid: number) => any;
*/

export class GameStateInit {
    doInternalLoadWasm: () => Promise<ArrayBuffer>;
    wasmConnection: WasmConnection | undefined;
    fetchHex: (key: string) => Promise<string>;

    constructor(doInternalLoadWasm : () => Promise<ArrayBuffer>, fetchHex: (key: string) => Promise<string>) {
        this.doInternalLoadWasm = doInternalLoadWasm;
        this.fetchHex = fetchHex;
    }

    internalLoadWasm(chia_gaming_init: any, cg: WasmConnection): any {
        console.log('wasm detected');
        return this.doInternalLoadWasm().then(modData => {
        chia_gaming_init(modData);
        cg.init((msg: string) => console.warn('wasm', msg));
        this.wasmConnection = cg;
        const presetFiles = [
            "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex",
            "clsp/unroll/unroll_meta_puzzle.hex",
            "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
            "clsp/referee/onchain/referee.hex",
            "clsp/referee/onchain/referee-v1.hex"
        ];
        return {};
        });
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
            this.wasmConnection?.deposit_file(nameAndContent.name, nameAndContent.content);
        });

        // this.pushEvent({ loadCalpoker: true });
        return {
            'setGameConnectionState': {
            stateIdentifier: "starting",
            stateDetail: ["loaded preset files"]
            },
            'setGameIdentity': newGameIdentity
        };
        });
    };

    createRng(seed: string) {
        return this.wasmConnection?.create_rng(seed);
    }

    deserializeRng(serializedGame: any) {
        return this.wasmConnection?.deserialize_rng(serializedGame);
    }

    getChiaIdentity(rngSeed: string) {
        // return this.wasmConnection?.chia_identity(rngSeed);
    }

    getNewWasmBlobWrapper(params: ChiaGameParams) {
        let cradleId = this.wasmConnection?.create_game_cradle({
            // TODO
            seed: seed,
            game_types: env.game_types,
            identity: identity.private_key,
            have_potato: have_potato,
            my_contribution: {amt: my_contribution},
            their_contribution: {amt: their_contribution},
            channel_timeout: env.timeout,
            unroll_timeout: env.unroll_timeout,
            reward_puzzle_hash: identity.puzzle_hash,
        });
        let cradle = new ChiaGame(env, this.wasmConnection, params, cradleId);
        return cradle;
    }

    getDeserializedWasmBlobWrapper(serializedGame: any, rng: RngXX, params: SerializedWasmBlobWrapperParams) {
        let cradleId = this.wasmConnection.create_serialized_game(serializedGame, rng);
        let cradle = new ChiaGame(env, this.wasmConnection, params, cradleId);
        return cradle;
    }
}

let gameStateInit: GameStateInit | undefined = undefined;

function getGameStateInit() {
    if (!gameStateInit) {
        return
    }
}

// undefined is not "any", null is
//export const gameStateInitSingleton =
//assignWasmBlob