import { deposit_file } from '../../../node-pkg/chia_gaming_wasm.js';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import { InternalBlockchainInterface, PeerConnectionResult, RngId, BlockchainReport, WasmBlobParams } from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import { FAKE_BLOCKCHAIN_ID } from '../../hooks/FakeBlockchainInterface';
import { blockchainDataEmitter } from '../../hooks/BlockchainInfo';
import { ChildFrameBlockchainInterface } from '../../hooks/ChildFrameBlockchainInterface';
import { WasmBlobWrapper, getNewChiaGameCradle } from '../../hooks/WasmBlobWrapper'
import { WasmStateInit, doInternalLoadWasm, storeInitArgs } from '../../hooks/WasmStateInit';
import { WasmCommand } from '../../hooks/useWasmBlob';
import { Subject } from 'rxjs';

// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import { resolve } from 'path';
// @ts-ignore
import * as assert from 'assert';

function rooted(name: string) {
    // @ts-ignore
    return resolve(__dirname, '../../../../..', name);
}

function preset_file(name: string) {
    deposit_file(name, fs.readFileSync(rooted(name), 'utf8'));
}

const loadCalpoker: () => Promise<any> = () => {
    const calpokerFactory = fetchHex(
        "clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex"
    );
    return calpokerFactory;
}

class WasmBlobWrapperAdapter {
    blob: WasmBlobWrapper | undefined;
    waiting_messages: Array<string>;

    constructor(wasmCommandChannel: Subject<WasmCommand>) {
        this.waiting_messages = [];
    }

    take_block(peak: number, blocks: any[], block_report: any) {
        this.blob?.blockNotification(peak, blocks, block_report);
    }

    getObservable() {
        if (!this.blob) {
            throw ("WasmBlobWrapperAdapter.getObservable() called before set_blob");
        }
        return this.blob.getObservable();
    }

    set_blob(blob: WasmBlobWrapper) {
        this.blob = blob;
        this.blob.kickSystem(1);
    }

    deliver_message(msg: string) {
        this.blob?.deliverMessage(msg);
    }

    handshaked(): boolean {
        return !!this.blob?.isHandshakeDone();
    }

    outbound_messages(): Array<string> {
        let w = this.waiting_messages;
        this.waiting_messages = [];
        return w;
    }

    add_outbound_message(msg: string) {
        this.waiting_messages.push(msg);
    }

    get_stored_messages() {
        if (!this.blob) {
            return [];
        }
        return this.blob?.getStoredMessages();
    }
}

function all_handshaked(cradles: Array<WasmBlobWrapperAdapter>) {
    for (let c = 0; c < 2; c++) {
        if (!cradles[c].handshaked()) {
            return false;
        }
    }
    return true;
}

function wait(msec: number): Promise<void> {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, msec);
    });
}

async function action_with_messages(timer: Timer, shutdown: () => void, blockchainInterface: ChildFrameBlockchainInterface, cradle1: WasmBlobWrapperAdapter, cradle2: WasmBlobWrapperAdapter) {
    let count = 0;
    let cradles = [cradle1, cradle2];
    console.log("action_with_messages TIME: ", timer.howLong());
    let blockchainSubscription = blockchainInterface.getObservable().subscribe({
        next: (evt: BlockchainReport) => {
            cradles.forEach((c, i) => {
                let block_array: any[] = [];
                if (evt.block) {
                    block_array = evt.block;
                }
                console.log('pass on block', evt.peak, block_array, evt.report);
                c.take_block(evt.peak, block_array, evt.report);
            });
        }
    });

    let evt_results: Array<boolean> = [false, false];
    cradles.forEach((cradle, index) => {
        cradle.getObservable().subscribe({
            next: (evt) => {
                console.log("WasmBlobWrapper Event: ", evt);
                if (evt.setGameConnectionState && evt.setGameConnectionState.stateIdentifier === "running") {
                    evt_results[index] = true;
                }
            }
        })
    });

    while (!all_handshaked(cradles)) {
        console.log("WHILE TIME: ", timer.howLong());
        if (timer.timedOut()) {
            console.log("TEST TIMED OUT");
            blockchainSubscription.unsubscribe();
            shutdown();
            throw("TEST TIMED OUT 2");
        }
        for (let c = 0; c < 2; c++) {
            let outbound = cradles[c].outbound_messages();
            let msgs = cradles[c].get_stored_messages();
            for (let i = 0; i < outbound.length; i++) {
                console.log(`delivering message from cradle ${c}: ${outbound[i]}`);
                cradles[c ^ 1].deliver_message(outbound[i]);
            }
        }
        await wait(10);
    }

    // If any evt_results are false, that means we did not get a setState msg from that cradle
    if (!evt_results.every((x) => x)) {
        console.log('got running:', evt_results);
        throw ("we expected running state in both cradles");
    }
}

async function fetchHex(key: string): Promise<string> {
    return fs.readFileSync(rooted(key), 'utf8');
}

async function initWasmBlobWrapper(wasmCommandChannel: Subject<WasmCommand>, blockchain: InternalBlockchainInterface, uniqueId: string, iStarted: boolean, peer_conn: PeerConnectionResult): Promise<{ game: WasmBlobWrapper, shutdown: () => void }> {
    const amount = 100;
    const doInternalLoadWasm = async () => { return new ArrayBuffer(0); };
    // Ensure that each user has a wallet.
    console.log('calling fetch(POST,', BLOCKCHAIN_SERVICE_URL, '/register?name=', uniqueId, ')');
    await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {
        method: "POST"
    }).then(res => {
        return res.json();
    }).then(token => {
        // token is the address of the created wallet
        console.log('Got token from', BLOCKCHAIN_SERVICE_URL, 'token=', token);
        return token;
    });

    await storeInitArgs(() => { }, WholeWasmObject);

    // blockchainInterface, uniqueId, amount, iStarted, doInternalLoadWasm, fetchHex, peer_conn
    let wasmStateInit: WasmStateInit = new WasmStateInit(doInternalLoadWasm, fetchHex);
    //const calpokerHex = loadCalpoker();
    //const wasmConnection = await wasmStateInit.getWasmConnection()
    return loadCalpoker().then((calpokerHex) => {
        console.log('Calpoker ChiaLisp loaded');
        return wasmStateInit.getWasmConnection().then((wasmConnection) => {
            console.log('Wasm connection active');
            return {
                calpokerHex, wasmConnection
            };
        });
    }).then(({ calpokerHex, wasmConnection }) => {
        const env = {
            game_types: {
                "calpoker": {
                    version: 1,
                    hex: calpokerHex
                }
            },
            timeout: 100,
            unroll_timeout: 100
        };
        console.log('Configuring known game types: ', env);
        const hexString = `444${4 + (iStarted ? 1 : 0)}`;
        const rngId = wasmConnection.create_rng(hexString);

        const gameInitParams = {
            wasmConnection,
            env,
            rng: new RngId(rngId),
            chiaIdentity: wasmConnection.chia_identity(rngId),
            iStarted, // iStarted, aka have_potato
            // TODO: IEEE float ('number') is a slightly smaller range than MAX_NUM_MOJOS
            // TODO: CalPoker has both players contribute equal amounts. Change this code before Krunk
            myContribution: 100,
            theirContribution: 100,
        }
        let cradle = getNewChiaGameCradle(wasmConnection, gameInitParams);
        console.log('Chia Gaming Cradle created. Session ID:', hexString);
        console.log('I am ', iStarted ? 'Alice' : 'Bob');
        let wasmParams: WasmBlobParams = {
            blockchain: blockchain,
            peerconn: peer_conn,
            cradle: cradle,
            uniqueId: uniqueId,
            iStarted: iStarted,
            fetchHex: fetchHex,
        };

        const liveGame = new WasmBlobWrapper(wasmParams, wasmConnection)
        console.log('WasmBlobWrapper game object created.');

        console.log("About to subscribe to wasmCommandChannel");
        wasmCommandChannel.subscribe({
            next: (wasmCommand: WasmCommand) => {
                const msg: WasmCommand = wasmCommand;
                console.log('Sending wasm command:', Object.keys(msg));
            }
        });
        console.log("About to subscribe to blockchain service");
        let blockSubscription = blockchain.getObservable().subscribe({
            next: (e: BlockchainReport) => {
                console.log('Received Chia block ', e.peak);
                liveGame.blockNotification(e.peak, e.block, e.report);
            }
        });
        let shutdown = function() {
            blockSubscription.unsubscribe();
        }
        console.log("About to subscribe to game service");
        let stateSubscription = liveGame.getObservable().subscribe({
            next: (state: any) => {
                console.log("wasm blob recvd update:", state);
                if (state.shutdown) {
                    console.log('Chia Gaming shutting down.');
                    stateSubscription.unsubscribe();
                    blockSubscription.unsubscribe();
                }
            }
        });

        console.log('Wasm Initialization Complete.');
        console.log("About to create start coin");
        return liveGame.createStartCoin().then((coin) => {
            console.log('Initial coin creation complete. Got: ', coin);
            if (coin === undefined) {
                throw ("Failed to create initial game coin");
            }
            liveGame.setStartCoin(coin);
            console.log('Chia Gaming infrastructure Initialization Complete.');
            return { game: liveGame, shutdown: shutdown };
        });
    });
    console.log('Chia Gaming infrastructure Initialization threaded and ready to be configured.');
}



//--------------------------------
/*
    const env = {
        game_types: {
            "calpoker": {
            version: 1,
            hex: calpokerHex
            }
        }
    };
    const rngId = wasmConnection.create_rng("0");
    const gameInitParams = {
        wasmConnection,
        env,
        rng: new RngId(rngId),
        chiaIdentity: wasmConnection.chia_identity(rngId),
        iStarted, // iStarted, aka have_potato
        // TODO: IEEE float ('number') is a slightly smaller range than MAX_NUM_MOJOS
        // TODO: CalPoker has both players contribute equal amounts. Change this code before Krunk
        myContribution: amount,
        theirContribution: amount,
    }
    let cradle = getNewChiaGameCradle(wasmConnection, gameInitParams);
    let wasmParams: WasmBlobParams = {
        blockchain: blockchain,
        peerconn: peer_conn,
        cradle: cradle,
        uniqueId: uniqueId,
        iStarted: iStarted,
        fetchHex: fetchHex,
      };

    await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {method: "POST"});
    //let wbw = new WasmBlobWrapper(blockchainInterface, uniqueId, amount, amount / 10, iStarted, doInternalLoadWasm, fetchHex, peer_conn);
    let wbw = new WasmBlobWrapper(wasmParams, wasmConnection);
    let ob = wbw.getObservable();
    console.log("WasmBlobWrapper Observable: ", ob);
    let wwo = Object.assign({}, WholeWasmObject);
    wwo.init = () => {};
    // gameObject?.loadWasm(chia_gaming_init, cg);
    // wbw.internalLoadWasm(() => {}, wwo);

    return wbw;
}
*/

class Timer {
    timerId: any | undefined;
    timeout: boolean = false;
    startTime: Date | undefined;
    start(ms: number) {
        this.startTime = new Date();
        this.timerId = setTimeout(() => {
            this.timeout = true;
        }, ms);
    }
    howLong() {
        const started = this.startTime;
        if (started) {
            return (new Date().getTime()) - started.getTime()
        } else {
            return -1;
        }
    }
    timedOut() {
        return this.timeout;
    }
}

const load_wasm_test = async () => {
    console.log("Starting load_wasm smoke test");
    let timer = new Timer();
    timer.start(15000);

    const blockchainInterface = new ChildFrameBlockchainInterface();
    // The blockchain service does separate monitoring now.
    blockchainDataEmitter.select({
        selection: FAKE_BLOCKCHAIN_ID,
        uniqueId: 'block-producer'
    });
    console.log("blockchainDataEmitter selected with blockchain id:", FAKE_BLOCKCHAIN_ID);

    // function get_wasm_connection(): Subject<WasmCommand> {

    // }
    let wcc1 = new Subject<WasmCommand>();
    const cradle1 = new WasmBlobWrapperAdapter(wcc1);
    let peer_conn1 = {
        sendMessage: (message: string) => {
            console.log('cradle1 has outbound msg', message);
            cradle1.add_outbound_message(message);
        }
    };

    let { game: wasm_blob1, shutdown: shutdown1 } = await initWasmBlobWrapper(wcc1, blockchainInterface, "a11ce000", true, peer_conn1);
    cradle1.set_blob(wasm_blob1);
    console.log("cradle1 created");

    let wcc2 = new Subject<WasmCommand>();
    const cradle2 = new WasmBlobWrapperAdapter(wcc2);
    let peer_conn2 = {
        sendMessage: (message: string) => {
            console.log('cradle2 has outbound msg', message);
            cradle2.add_outbound_message(message);
        }
    };
    let { game: wasm_blob2, shutdown: shutdown2 }= await initWasmBlobWrapper(wcc2, blockchainInterface, "b0b77777", false, peer_conn2);
    cradle2.set_blob(wasm_blob2);
    console.log("cradle2 created");

    let shutdown = function() {
        shutdown1();
        shutdown2();
    }

    console.log("calling action_with_messages ...");
    await action_with_messages(timer, shutdown, blockchainInterface, cradle1, cradle2);
}

// @ts-ignore
test('load_wasm', load_wasm_test, 17 * 1000);
