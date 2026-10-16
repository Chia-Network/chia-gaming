import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';

const SETTLEMENT_PAYMENT_HASH = 'cfbfdeed5c4ca2de3d0bf520b9cb4bb7743a359bd2e6a188d19ce7dffc21d3e7';

function walletIdentity(): { puzzle: string; puzzle_hash: string } {
  const rng = WholeWasmObject.create_rng('07'.repeat(32));
  return WholeWasmObject.chia_identity(rng);
}

it('builds an unsigned Sage funding spend over a standard wallet coin in real WASM', () => {
  const identity = walletIdentity();
  const unsigned = JSON.parse(
    WholeWasmObject.build_wallet_spend(
      JSON.stringify({
        coins: [
          {
            coin: {
              parent_coin_info: 'aa'.repeat(32),
              puzzle_hash: identity.puzzle_hash,
              amount: '1000',
            },
            puzzle_reveal: identity.puzzle,
          },
        ],
        change_puzzle_hash: identity.puzzle_hash,
        purpose: {
          kind: 'funding',
          amount: '600',
          conditions: [{ opcode: 67, args: ['10', 'abcd', 'bb'.repeat(32)] }],
          max_height: '1234',
        },
      }),
    ),
  );

  expect(unsigned.coin_spends).toHaveLength(1);
  const [spend] = unsigned.coin_spends;
  expect(spend.coin).toEqual({
    parent_coin_info: `0x${'aa'.repeat(32)}`,
    puzzle_hash: `0x${identity.puzzle_hash}`,
    amount: 1000,
  });
  expect(spend.puzzle_reveal).toBe(`0x${identity.puzzle}`);
  expect(spend.solution).toContain(SETTLEMENT_PAYMENT_HASH);
  expect(spend.solution).toContain(identity.puzzle_hash);
});

it('rejects a fee spend when no standard coin covers the fee in real WASM', () => {
  const identity = walletIdentity();
  expect(() =>
    WholeWasmObject.build_wallet_spend(
      JSON.stringify({
        coins: [
          {
            coin: {
              parent_coin_info: 'aa'.repeat(32),
              puzzle_hash: identity.puzzle_hash,
              amount: '50',
            },
            puzzle_reveal: identity.puzzle,
          },
        ],
        change_puzzle_hash: identity.puzzle_hash,
        purpose: { kind: 'fee', fee: '100', target_coin_id: 'cc'.repeat(32) },
      }),
    ),
  ).toThrow(/needs 100/);
});
