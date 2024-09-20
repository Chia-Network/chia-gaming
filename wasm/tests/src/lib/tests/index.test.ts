import { init } from '../../../../pkg/chia_gaming_wasm.js';

import * as fs from 'fs';
import { resolve } from 'path';
import * as assert from 'assert';
import * as bls_loader from 'bls-signatures';

it('loads', async () => {
    init();
});
