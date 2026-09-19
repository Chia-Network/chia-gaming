import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';

describe('canonical funding requests', () => {
  it('copies required fields and omits null or undefined optionals', () => {
    const args = ['launcher'];
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
      conditions: [{ opcode: 60, args: ['launcher'] }],
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

  it.each([
    [{ fee: '0', conditions: [] }, 'amount'],
    [{ amount: 100, fee: '0', conditions: [] }, 'amount'],
    [{ amount: '', fee: '0', conditions: [] }, 'amount'],
    [{ amount: '100', fee: 0, conditions: [] }, 'fee'],
    [{ amount: '100', fee: '', conditions: [] }, 'fee'],
    [{ amount: '100', fee: '0', conditions: null }, 'conditions'],
    [{ amount: '100', fee: '0', conditions: [{ opcode: 60.5, args: [] }] }, 'conditions[0]'],
    [{ amount: '100', fee: '0', conditions: [], coin_id: '' }, 'coin_id'],
    [{ amount: '100', fee: '0', conditions: [], max_height: 1.5 }, 'max_height'],
  ])('rejects a malformed request %#', (request, field) => {
    expect(() => canonicalizeFundingRequest(request)).toThrow(field);
  });
});
