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
    config: any | undefined;
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

    set_blob(config: any, blob: WasmBlobWrapper) {
        this.config = config;
        this.blob = blob;
        this.blob.kickSystem(2);
    }

    make_move(move: any) {
        this.blob?.makeMove(move);
    }

    set_card_selections(mask: number) {
        this.blob?.setCardSelections(mask);
    }

    deliver_message(msg: string) {
        this.blob?.deliverMessage(msg);
    }

    serialize(): any {
        return this.blob?.serialize();
    }

    create_from_serialized(serialized: any): any {
        this.config.serialized = serialized;
        this.blob = new WasmBlobWrapper(this.config);
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
    let serializationWorked: () => void = () => { };
    let serialized = new Promise((resolve) => {
      serializationWorked = () => resolve(null);
    });
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
                console.log("WasmBlobWrapper Event:", index, evt);
                if (evt.setGameConnectionState && evt.setGameConnectionState.stateIdentifier === "running") {
                    evt_results[index] = true;
                }
                if (evt.setGids) {
                    gids[index] = evt.setGids;
                }
                if (evt.setMoveNumber !== undefined) {
                    move[index] = evt.setMoveNumber;
                }
                if (evt.setMyTurn !== undefined) {
                    myTurn[index] = evt.setMyTurn;
                }
                if (evt.serialized) {
                    console.log('saved cradle 0', evt.serialized);
                    cradles[0].create_from_serialized(evt.serialized);
                    serializationWorked();
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
        if (!myTurn[i]) {
            throw 'Should be my turn when making a move';
        }

        console.log('make move', i, hex);

      const nextMove = move[i] + 1;

        cradles[i].make_move(hex);

        const originalCount = count;
        const newCount = count + 1000;

        function doneMove() {
            console.log('makeMove', i, hex, 'have', move, myTurn, count, newCount);
            return (!myTurn[i] && myTurn[i^1]) || (count++ > newCount);
        }

        while (!doneMove()) {
            await process();
        }

        if (count >= newCount) {
            throw `time expired making move ${i} ${hex}`;
        }
    }

    await makeMove(1, '80');
    await makeMove(0, '80');

    cradles[0].set_card_selections(0x55);
    cradles[1].set_card_selections(0xaa);

    cradles[0].serialize();
    await serialized;

    await makeMove(1, '55');
    await makeMove(0, '81aa');
}

async function fetchHex(key: string): Promise<string> {
    return fs.readFileSync(rooted(key), 'utf8');
}

async function initWasmBlobWrapper(blockchainInterface: InternalBlockchainInterface, uniqueId: string, iStarted: boolean, peer_conn: PeerConnectionResult): Promise<WasmBlobWrapperAdapter> {
    const amount = 100;
    const doInternalLoadWasm = async () => { return new ArrayBuffer(0); }; // Promise<ArrayBuffer>;
    // Ensure that each user has a wallet.
    await fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, {method: "POST"});
    let config = {
        blockchain: blockchainInterface,
        uniqueId,
        amount,
        iStarted,
        doInternalLoadWasm,
        fetchHex,
        peer_conn
    };
    let wbw = new WasmBlobWrapper(config);
    let ob = wbw.getObservable();
    console.log("WasmBlobWrapper Observable: ", ob);
    let wwo = Object.assign({}, WholeWasmObject);
    wwo.init = () => {};
    wbw.loadWasm(() => {}, wwo);

    const cradle1 = new WasmBlobWrapperAdapter();
    cradle1.set_blob(config, wbw);
    return cradle1;
}

it('loads', async () => {
    const blockchainInterface = new ChildFrameBlockchainInterface();
    // The blockchain service does separate monitoring now.
    blockchainDataEmitter.select({
      selection: FAKE_BLOCKCHAIN_ID,
      uniqueId: 'block-producer'
    });

    let peer_conn1 = { sendMessage: (message: string) => {
        cradle1.add_outbound_message(message);
    } };
    let cradle1 = await initWasmBlobWrapper(blockchainInterface, "a11ce000", true, peer_conn1);

    let peer_conn2 = { sendMessage: (message: string) => {
        cradle2.add_outbound_message(message);
    } };
    let cradle2 = await initWasmBlobWrapper(blockchainInterface, "b0b77777", false, peer_conn2);

    await action_with_messages(blockchainInterface, cradle1, cradle2);
}, 30 * 1000);
