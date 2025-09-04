import { init, config_scaffold, create_game_cradle, deliver_message, deposit_file, opening_coin, idle, chia_identity, Spend, CoinSpend, SpendBundle, IChiaIdentity, IdleCallbacks, IdleResult } from '../../../rust/wasm/pkg/chia_gaming_wasm.js';
import WholeWasmObject from '../../../rust/wasm/pkg/chia_gaming_wasm.js';
import { InternalBlockchainInterface, PeerConnectionResult, BlockchainReport, BLOCKCHAIN_SERVICE_URL } from '../../types/ChiaGaming';
import { ChildFrameBlockchainInterface, blockchainDataEmitter } from '../../hooks/useFullNode';

import { WasmBlobWrapper } from '../../hooks/WasmBlobWrapper'
import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';

function rooted(name: string) {
    return resolve(__dirname, '../../../../..', name);
}

function preset_file(name: string) {
    deposit_file(name, fs.readFileSync(rooted(name), 'utf8'));
}

class WasmBlobWrapperAdapter {
    blob: WasmBlobWrapper | undefined;
    waiting_messages: Array<string>;

    constructor() {
        this.waiting_messages = [];
    }

    take_block(peak: number, blocks: any[], block_report: any) {
      this.blob?.blockNotification(peak, blocks, block_report);
    }

    getObservable() {
        if (!this.blob) {
            throw("WasmBlobWrapperAdapter.getObservable() called before set_blob");
        }
        return this.blob.getObservable();
    }

    set_blob(blob: WasmBlobWrapper) {
        this.blob = blob;
        this.blob.kickSystem(2);
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

async function action_with_messages(blockchainInterface: ChildFrameBlockchainInterface, cradle1: WasmBlobWrapperAdapter, cradle2: WasmBlobWrapperAdapter) {
    let count = 0;
    let cradles = [cradle1, cradle2];

    blockchainInterface.getObservable().subscribe({
        next: (evt: BlockchainReport) => {
            cradles.forEach((c, i) => {
                let block_array = [];
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
                if( evt.setGameConnectionState && evt.setGameConnectionState.stateIdentifier === "running") {
                    evt_results[index] = true;
                }
            }
        })
    });

    while (!all_handshaked(cradles)) {
        for (let c = 0; c < 2; c++) {
            let outbound = cradles[c].outbound_messages();
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
        throw("we expected running state in both cradles");
    }
}

async function fetchHex(key: string): Promise<string> {
    return fs.readFileSync(rooted(key), 'utf8');
}

async function initWasmBlobWrapper(blockchainInterface: InternalBlockchainInterface, uniqueId: string, iStarted: boolean, peer_conn: PeerConnectionResult) {
    const amount = 100;
    const doInternalLoadWasm = async () => { return new ArrayBuffer(0); }; // Promise<ArrayBuffer>;
    // Ensure that each user has a wallet.
    await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {method: "POST"});
    let wbw = new WasmBlobWrapper(blockchainInterface, uniqueId, amount, iStarted, doInternalLoadWasm, fetchHex, peer_conn);
    let ob = wbw.getObservable();
    console.log("WasmBlobWrapper Observable: ", ob);
    let wwo = Object.assign({}, WholeWasmObject);
    wwo.init = () => {};
    wbw.loadWasm(() => {}, wwo);

    return wbw;
}

it('loads', async () => {
    const blockchainInterface = new ChildFrameBlockchainInterface();
    // The blockchain service does separate monitoring now.
    blockchainDataEmitter.select({
      selection: 0,
      uniqueId: 'block-producer'
    });

    const cradle1 = new WasmBlobWrapperAdapter();
    let peer_conn1 = { sendMessage: (message: string) => {
        cradle1.add_outbound_message(message);
    } };
    let wasm_blob1 = await initWasmBlobWrapper(blockchainInterface, "a11ce000", true, peer_conn1);
    cradle1.set_blob(wasm_blob1);

    const cradle2 = new WasmBlobWrapperAdapter();
    let peer_conn2 = { sendMessage: (message: string) => {
        cradle2.add_outbound_message(message);
    } };
    let wasm_blob2 = await initWasmBlobWrapper(blockchainInterface, "b0b77777", false, peer_conn2);
    cradle2.set_blob(wasm_blob2);

    await action_with_messages(blockchainInterface, cradle1, cradle2);
}, 15 * 1000);
