import { init, config_scaffold, create_game_cradle, deposit_file, opening_coin, idle } from '../../../../pkg/chia_gaming_wasm.js';

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

const fake_identity = "112233441122334411223344112233441122334411223344112233441122334411223344112233441122334411223344";
const fake_reward_puzzle_hash = "1122334411223344112233441122334411223344112233441122334411223344";
const fake_coin = fake_reward_puzzle_hash + fake_reward_puzzle_hash + "64";

it('loads', async () => {
    init();
    preset_file("resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex");
    preset_file("clsp/unroll/unroll_meta_puzzle.hex");
    preset_file("clsp/unroll/unroll_puzzle_state_channel_unrolling.hex");
    preset_file("clsp/onchain/referee.hex");
    let calpoker_hex = fs.readFileSync(rooted('clsp/calpoker_include_calpoker_factory.hex'),'utf8');
    const cradle = create_game_cradle({
        seed: "3579",
        game_types: {
            "calpoker": calpoker_hex
        },
        identity: fake_identity,
        have_potato: true,
        my_contribution: {amt: 100},
        their_contribution: {amt: 100},
        channel_timeout: 99,
        reward_puzzle_hash: fake_reward_puzzle_hash,
    });

    opening_coin(cradle, fake_coin);

    let idle_result = idle(cradle, {});
    console.log(idle_result);
});
