import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import { startSimulator } from './load_wasm.harness';

const USERS = Array.from({ length: 8 }, (_, index) => `ws-stress-${index}`);

test('handles repeated overlapping simulator RPCs', async () => {
  const poller = await startSimulator(USERS);
  if (!poller) return;

  for (let round = 0; round < 20; round += 1) {
    const puzzleHashes = await Promise.all(
      USERS.map((userId) => fakeBlockchainInfo.registerUser(userId)),
    );
    expect(puzzleHashes).toHaveLength(USERS.length);
    expect(puzzleHashes.every((puzzleHash) => puzzleHash.length > 0)).toBe(true);
  }
}, 120_000);
