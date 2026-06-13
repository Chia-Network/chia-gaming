import {
  jsonParse,
  jsonParseLossless,
  jsonStringify,
  jsonStringifyLossless,
} from '../../util/jsonSafe';

describe('jsonSafe codecs', () => {
  it('preserves large bigint values with the lossless persistence codec', () => {
    const original = {
      fee: 9_007_199_254_740_993n,
      nested: {
        cards: [1n, 2n, 52n],
      },
    };

    const encoded = jsonStringifyLossless(original);
    const decoded = jsonParseLossless(encoded);

    expect(encoded).toContain('$bigint');
    expect(decoded).toEqual(original);
  });

  it('still accepts legacy integer tokens as bigint on parse', () => {
    expect(jsonParseLossless('{"value":42}')).toEqual({ value: 42n });
  });

  it('keeps the existing rpc/debug codec shape unchanged', () => {
    expect(jsonStringify({ value: 42n })).toBe('{"value":42}');
    expect(jsonParse('{"value":42}')).toEqual({ value: 42n });
  });
});
