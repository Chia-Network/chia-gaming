import {
  decode,
  encode,
  getBytes,
  getInteger,
  isDictionary,
  type BencodexKey,
  type BencodexValue,
} from 'chia-gaming-bencodex';

const ascii = new TextDecoder();

function text(bytes: Uint8Array): string {
  return ascii.decode(bytes);
}

function expectRoundTrip(value: BencodexValue, encoded: string): void {
  const bytes = encode(value);
  expect(text(bytes)).toBe(encoded);
  expect(decode(bytes)).toEqual(value);
}

describe('local bencodex codec', () => {
  it('encodes scalar values using the Rust crate wire forms', () => {
    expectRoundTrip(null, 'n');
    expectRoundTrip(true, 't');
    expectRoundTrip(false, 'f');
    expectRoundTrip(42n, 'i42e');
    expectRoundTrip(-3n, 'i-3e');
    expectRoundTrip('hello', 'u5:hello');
  });

  it('rejects non-canonical integer grammars', () => {
    const encoder = new TextEncoder();
    for (const encoded of ['i+12e', 'i 12e', 'i12 e', 'i 0x10e', 'i 0o17e', 'i 0b101e']) {
      expect(() => decode(encoder.encode(encoded))).toThrow('invalid integer encoding');
    }
  });

  it('enforces configurable nesting and value budgets', () => {
    const encoder = new TextEncoder();
    const limits = { maxDepth: 2, maxValues: 3 };

    expect(decode(encoder.encode('llnee'), limits)).toEqual([[null]]);
    expect(() => decode(encoder.encode('lllneee'), limits)).toThrow(
      'maximum value nesting depth exceeded',
    );
    expect(decode(encoder.encode('du1:ai1ee'), limits)).toEqual(new Map([['a', 1n]]));
    expect(() => decode(encoder.encode('du1:ai1ee'), { ...limits, maxValues: 2 })).toThrow(
      'maximum value count exceeded',
    );
  });

  it('rejects hostile inputs at the default Rust decoder budgets', () => {
    const encoder = new TextEncoder();
    const deeplyNested = `${'l'.repeat(513)}n${'e'.repeat(513)}`;
    const tooManyValues = `l${'n'.repeat(100_000)}e`;

    expect(() => decode(encoder.encode(deeplyNested))).toThrow(
      'maximum value nesting depth exceeded',
    );
    expect(() => decode(encoder.encode(tooManyValues))).toThrow('maximum value count exceeded');
  });

  it('encodes byte arrays as byte strings', () => {
    const bytes = new TextEncoder().encode('spam');
    const encoded = encode(bytes);
    expect(text(encoded)).toBe('4:spam');
    expect(decode(encoded)).toEqual(bytes);
  });

  it('encodes lists and dictionaries with canonical dictionary ordering', () => {
    expectRoundTrip([1n, 2n, 3n], 'li1ei2ei3ee');
    expect(text(encode({ z: 1n, a: 2n }))).toBe('du1:ai2eu1:zi1ee');
  });

  it('sorts byte dictionary keys before text dictionary keys', () => {
    const value = new Map<BencodexKey, BencodexValue>([
      ['a', 2n],
      [new TextEncoder().encode('z'), 1n],
    ]);
    const encoded = encode(value);
    expect(text(encoded)).toBe('d1:zi1eu1:ai2ee');

    const decoded = decode(encoded);
    expect(isDictionary(decoded)).toBe(true);
    expect((decoded as Map<BencodexKey, BencodexValue>).get('a')).toBe(2n);
  });

  it('reads byte strings and integers without coercing other value types', () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const decoded = decode(encode({ bytes, integer: 42n, text: '42' }));
    expect(isDictionary(decoded)).toBe(true);
    if (!isDictionary(decoded)) throw new Error('expected dictionary');
    expect(getBytes(decoded, 'bytes')).toEqual(bytes);
    expect(getInteger(decoded, 'integer')).toBe(42n);
    expect(getInteger(decoded, 'text')).toBeUndefined();
    expect(getBytes(decoded, 'text')).toBeUndefined();
  });
});
