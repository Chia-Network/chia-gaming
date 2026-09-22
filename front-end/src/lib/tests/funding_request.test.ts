import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';

describe('canonical funding requests', () => {
  it('copies required fields and omits null or undefined optionals', () => {
    const args = ['abcd'];
    const input = {
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60, args }],
      coin_id: null,
      max_height: undefined,
    };

    const request = canonicalizeFundingRequest(input);
    args.push('mutated');

    expect(request).toEqual({
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60n, args: ['abcd'] }],
    });
    expect(request).not.toBe(input);
    expect(request.conditions).not.toBe(input.conditions);
  });

  it('produces the same key for null and absent optionals', () => {
    const withNulls = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [],
      coin_id: null,
      max_height: null,
    });
    const absent = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [],
    });

    expect(withNulls).toEqual(absent);
    expect(fundingRequestKey(withNulls)).toBe(fundingRequestKey(absent));
  });

  it('normalizes WASM integer representations into the immutable canonical model', () => {
    const request = canonicalizeFundingRequest({
      amount: '18446744073709551615',
      fee: '0',
      conditions: [{ opcode: 4_294_967_295n, args: ['00'] }],
      coin_id: 'ab'.repeat(32),
      max_height: 18446744073709551615n,
    });

    expect(request).toEqual({
      amount: '18446744073709551615',
      fee: '0',
      conditions: [{ opcode: 4_294_967_295n, args: ['00'] }],
      coin_id: 'ab'.repeat(32),
      max_height: '18446744073709551615',
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.conditions)).toBe(true);
    expect(Object.isFrozen(request.conditions[0].args)).toBe(true);
  });

  it('preserves keys produced for current valid Rust requests', () => {
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '10',
      conditions: [{ opcode: 60, args: ['abcd'] }],
      coin_id: 'ab'.repeat(32),
      max_height: 123,
    });

    expect(fundingRequestKey(request)).toBe(
      `funding:{"amount":"100","fee":"10","conditions":[{"opcode":60,"args":["abcd"]}],"coin_id":"${'ab'.repeat(32)}","max_height":123}`,
    );
  });

  it.each([
    [{ fee: '0', conditions: [] }, 'amount'],
    [{ amount: 100, fee: '0', conditions: [] }, 'amount'],
    [{ amount: '', fee: '0', conditions: [] }, 'amount'],
    [{ amount: '01', fee: '0', conditions: [] }, 'amount'],
    [{ amount: '-1', fee: '0', conditions: [] }, 'amount'],
    [{ amount: '18446744073709551616', fee: '0', conditions: [] }, 'amount'],
    [{ amount: '100', conditions: [] }, 'fee'],
    [{ amount: '100', fee: null, conditions: [] }, 'fee'],
    [{ amount: '100', fee: 0, conditions: [] }, 'fee'],
    [{ amount: '100', fee: '', conditions: [] }, 'fee'],
    [{ amount: '100', fee: '00', conditions: [] }, 'fee'],
    [{ amount: '100', fee: '0', conditions: null }, 'conditions'],
    [{ amount: '100', fee: '0', conditions: [{ opcode: 60.5, args: [] }] }, 'conditions[0]'],
    [
      { amount: '100', fee: '0', conditions: [{ opcode: 4_294_967_296, args: [] }] },
      'conditions[0]',
    ],
    [{ amount: '100', fee: '0', conditions: [], coin_id: '' }, 'coin_id'],
    [{ amount: '100', fee: '0', conditions: [], coin_id: 'AB'.repeat(32) }, 'coin_id'],
    [{ amount: '100', fee: '0', conditions: [], max_height: 1.5 }, 'max_height'],
    [{ amount: '100', fee: '0', conditions: [], max_height: '01' }, 'max_height'],
    [{ amount: '100', fee: '0', conditions: [], max_height: '18446744073709551616' }, 'max_height'],
  ])('rejects a malformed request %#', (request, field) => {
    expect(() => canonicalizeFundingRequest(request)).toThrow(field);
  });
});
