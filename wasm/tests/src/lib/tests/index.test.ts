import { init, config_scaffold, create_game_cradle, deliver_message, deposit_file, opening_coin, idle, chia_identity, Spend, CoinSpend, SpendBundle, IChiaIdentity, IdleCallbacks, IdleResult } from '../../../../pkg/chia_gaming_wasm.js';

import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';

function rooted(name: string) {
    return resolve(__dirname, '../../../../..', name);
}

function preset_file(name: string) {
    deposit_file(name, fs.readFileSync(rooted(name), 'utf8'));
}

class ChiaGame {
    waiting_messages: Array<string>;
    private_key: string;
    cradle: number;
    have_potato: boolean;

    constructor(env: any, seed: string, identity: IChiaIdentity, have_potato: boolean, my_contribution: number, their_contribution: number) {
        this.waiting_messages = [];
        this.private_key = identity.private_key;
        this.have_potato = have_potato;
        this.cradle = create_game_cradle({
            seed: seed,
            game_types: env.game_types,
            identity: identity.private_key,
            have_potato: have_potato,
            my_contribution: {amt: my_contribution},
            their_contribution: {amt: their_contribution},
            channel_timeout: env.timeout,
            reward_puzzle_hash: identity.puzzle_hash,
        });
        console.log(`constructed ${have_potato}`);
    }

    deliver_message(msg: string) {
        deliver_message(this.cradle, msg);
    }

    opening_coin(coin_string: string) {
        opening_coin(this.cradle, coin_string);
    }

    quiet(): boolean {
        return this.waiting_messages.length === 0;
    }

    outbound_messages(): Array<string> {
        let w = this.waiting_messages;
        this.waiting_messages = [];
        return w;
    }

    idle(callbacks: IdleCallbacks) : IdleResult {
        let result = idle(this.cradle, callbacks);
        console.log('idle', result);
        this.waiting_messages = this.waiting_messages.concat(result.outbound_messages);
        return result;
    }
}

function all_quiet(cradles: Array<ChiaGame>) {
    for (let c = 0; c < 2; c++) {
        if (!cradles[c].quiet()) {
            return false;
        }
    }
    return true;
}

function empty_callbacks(): IdleCallbacks {
    return <IdleCallbacks>{};
}

function action_with_messages(cradle1: ChiaGame, cradle2: ChiaGame) {
    let cradles = [cradle1, cradle2];

    for (let c = 0; c < 2; c++) {
        cradles[c].idle(empty_callbacks());
    }

    while (!all_quiet(cradles)) {
        for (let c = 0; c < 2; c++) {
            let outbound = cradles[c].outbound_messages();
            for (let i = 0; i < outbound.length; i++) {
                console.log(`delivering message from cradle ${i}: ${outbound[i]}`);
                cradles[c ^ 1].deliver_message(outbound[i]);
            }
        }

        for (let c = 0; c < 2; c++) {
            cradles[c].idle(empty_callbacks());
        }
    }
}

it('loads', async () => {
    init();
    preset_file("resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex");
    preset_file("clsp/unroll/unroll_meta_puzzle.hex");
    preset_file("clsp/unroll/unroll_puzzle_state_channel_unrolling.hex");
    preset_file("clsp/onchain/referee.hex");
    let identity1 = chia_identity('test1');
    let identity2 = chia_identity('test2');
    console.log(identity1, identity2);

    let calpoker_hex = fs.readFileSync(rooted('clsp/calpoker_include_calpoker_factory.hex'),'utf8');
    let env = {
        game_types: {
            "calpoker": calpoker_hex
        },
        timeout: 99
    };

    let fake_coin1 = identity1.puzzle_hash + identity1.puzzle_hash + '64';
    let fake_coin2 = identity2.puzzle_hash + identity2.puzzle_hash + '64';

    const cradle1 = new ChiaGame(env, "3579", identity1, true, 100, 100);
    const cradle2 = new ChiaGame(env, "3589", identity2, false, 100, 100);

    cradle1.opening_coin(fake_coin1);
    cradle2.opening_coin(fake_coin2);

    action_with_messages(cradle1, cradle2);
});
