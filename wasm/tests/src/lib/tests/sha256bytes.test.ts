import { init, sha256bytes } from '../../../../pkg/chia_gaming_wasm.js';
import { to_hex_string, foo } from './common';
import * as assert from 'assert';

let utf8Encode = new TextEncoder();
let b = utf8Encode.encode("abc");

it('hashes', async () => {
    init();
    let msg = 'hello.there.my.dear.friend';
    let hash = sha256bytes(msg);
    console.log(msg, hash);
    console.log(foo());
    assert.equal( to_hex_string(hash), "5272821c151fdd49f19cc58cf8833da5781c7478a36d500e8dc2364be39f8216" );
});
