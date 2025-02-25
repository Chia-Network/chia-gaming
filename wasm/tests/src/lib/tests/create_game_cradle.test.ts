import { init, create_game_cradle } from  '../../../../pkg/chia_gaming_wasm.js';
import * as assert from 'assert';

it('create game cradle failed', async () => {
    init();
    const game_id = create_game_cradle({});
    console.log("GAME ID: ", game_id);
    //assert.equal( game_id, 0 );
});
