import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';
const {h, t, Program, compile} = require('../../../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

it('can compile clvm', async () => {
    const program_output = compile(
        '(mod (X) (include *standard-cl-23*) (+ X 1))',
        'test.clsp',
        []
    );
    assert.equal(program_output.hex, 'ff10ff02ffff010180');
});
