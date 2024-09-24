import { init, config_scaffold, create_game_cradle } from '../../../../pkg/chia_gaming_wasm.js';

import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';

it('loads', async () => {
    init();
    let calpoker_hex = fs.readFileSync(resolve(__dirname, '../../../../../clsp/calpoker_include_calpoker_factory.hex'));
    let cradle = create_game_cradle({
        seed: "3579",
        game_types: {
            "calpoker": calpoker_hex
        },
        identity: "112233441122334411223344112233441122334411223344112233441122334411223344112233441122334411223344",
        have_potato: true,
        my_contribution: {amt: 100},
        their_contribution: {amt: 100},
        channel_timeout: 99,
        reward_puzzle_hash: "1122334411223344112233441122334411223344112233441122334411223344"
    });
    console.log(cradle);
});
