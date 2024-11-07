import { init, sha256bytes } from '../../../../pkg/chia_gaming_wasm.js';

import { assert, to_hex_string } from '../../../../tests/src/lib/tests/common.js';

let utf8Encode = new TextEncoder();
let b = utf8Encode.encode("abc");

it('hashes', async () => {
    init();
    let msg = 'hello.there.my.dear.friend';
    let hash = sha256bytes(msg);
    console.log(msg, hash);
    assert( to_hex_string(hash) === "5272821c151fdd49f19cc58cf8833da5781c7478a36d500e8dc2364be39f8216" );
});
