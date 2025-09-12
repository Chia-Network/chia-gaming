import { init, config_scaffold, create_game_cradle, deliver_message, deposit_file, opening_coin, idle, chia_identity, Spend, CoinSpend, SpendBundle, IChiaIdentity, IdleCallbacks, IdleResult } from '../../../node-pkg/chia_gaming_wasm.js';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import { InternalBlockchainInterface, PeerConnectionResult, BlockchainReport } from '../../types/ChiaGaming';
import { BLOCKCHAIN_SERVICE_URL } from '../../settings';
import { FAKE_BLOCKCHAIN_ID, fakeBlockchainInfo, connectSimulatorBlockchain } from '../../hooks/FakeBlockchainInterface';
import { blockchainDataEmitter } from '../../hooks/BlockchainInfo';
import { blockchainConnector, BlockchainOutboundRequest } from '../../hooks/BlockchainConnector';
import { ChildFrameBlockchainInterface } from '../../hooks/ChildFrameBlockchainInterface';

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

    make_move(move: any) {
        this.blob?.makeMove(move);
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
    let gids = [[], []];
    let move = [0, 0];
    let myTurn = [false, false];
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
                if (evt.setGameConnectionState && evt.setGameConnectionState.stateIdentifier === "running") {
                    evt_results[index] = true;
                }

                if (evt.setGids) {
                    gids[index] = evt.setGids;
                }
                if (evt.setMove) {
                    move[index] = evt.setMove;
                }
                if (evt.setMyTurn) {
                    myTurn[index] = evt.setMyTurn;
                }
            }
        })
    });

    async function process() {
        for (let c = 0; c < 2; c++) {
            let outbound = cradles[c].outbound_messages();
            for (let i = 0; i < outbound.length; i++) {
                console.log(`delivering message from cradle ${c}: ${outbound[i]}`);
                cradles[c ^ 1].deliver_message(outbound[i]);
            }
        }
        await wait(10);
    }

    while (!all_handshaked(cradles) && count++ < 500) {
        await process();
    }

    // If any evt_results are false, that means we did not get a setState msg from that cradle
    if (!evt_results.every((x) => x)) {
        console.log('got running:', evt_results);
        throw("we expected running state in both cradles");
    }

    while (!gids.every((x) => x.length == 0) && count++ < 1000) {
        await process();
    }

    if (!gids.every((x) => x.length > 0)) {
        throw "we expected to have games started";
    }

    async function makeMove(i: number, hex: string) {
        cradles[i].make_move(hex);
        const newCount = count + 500;
        const expectedMove = move[i] + 1;
        while (move[i] < expectedMove && !myTurn[i ^ 1] && count++ < newCount) {
            await process();
        }

        if (count >= newCount) {
            throw `time expired making move ${i} expecting to receive move ${expectedMove}`;
        }
    }

    await makeMove(1, '80');
    await makeMove(0, '80');
}

async function fetchHex(key: string): Promise<string> {
    return fs.readFileSync(rooted(key), 'utf8');
}

async function initWasmBlobWrapper(blockchainInterface: InternalBlockchainInterface, uniqueId: string, iStarted: boolean, peer_conn: PeerConnectionResult) {
    const amount = 100;
    const doInternalLoadWasm = async () => { return new ArrayBuffer(0); }; // Promise<ArrayBuffer>;
    // Ensure that each user has a wallet.
    await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {method: "POST"});
    let wbw = new WasmBlobWrapper({
        blockchain: blockchainInterface,
        uniqueId,
        amount,
        iStarted,
        doInternalLoadWasm,
        fetchHex,
        peer_conn
    });
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
      selection: FAKE_BLOCKCHAIN_ID,
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
