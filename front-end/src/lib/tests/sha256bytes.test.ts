import { init, sha256bytes } from '../../../node-pkg/chia_gaming_wasm.js';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

it('hashes', async () => {
  init();
  const msg = 'hello.there.my.dear.friend';
  const hash = sha256bytes(msg);
  assert.equal(hash, '5272821c151fdd49f19cc58cf8833da5781c7478a36d500e8dc2364be39f8216');
});
