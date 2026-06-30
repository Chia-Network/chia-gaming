import {
  decode,
  encode,
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
});
