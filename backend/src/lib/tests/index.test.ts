import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';
const {h, t, Program, compile} = require('../../../clvm_tools_rs/wasm/pkg/clvm_tools_wasm');

it('can compile clvm', async () => {
    const program_output = compile(
        fs.readFileSync('test-content/t1.clsp', 'utf8'),
        't1.clsp',
        ['test-content'],
        {
            "read_new_file": (filename: string, dirs: Array<string>) => {
                for (let d in dirs) {
                    let dir = dirs[d];
                    let path = resolve(dir, filename);
                    try {
                        return fs.readFileSync(path, 'utf8');
                    } catch (e) {
                        // Ok, try the next dir.
                    }
                }

                throw `Could not find file ${filename}`;
            }
        }
    );
    assert.equal(program_output.hex, 'ff10ff02ffff010180');
});
