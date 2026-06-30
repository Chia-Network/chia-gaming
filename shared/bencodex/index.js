const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BencodexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BencodexError';
  }
}

function concat(parts) {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function ascii(s) {
  return textEncoder.encode(s);
}

function encodeBytes(bytes) {
  return concat([ascii(String(bytes.byteLength)), ascii(':'), bytes]);
}

function encodeText(text) {
  const bytes = textEncoder.encode(text);
  return concat([ascii('u'), ascii(String(bytes.byteLength)), ascii(':'), bytes]);
}

function keySortValue(key) {
  if (typeof key === 'string') {
    return { kind: 1, bytes: textEncoder.encode(key), encoded: encodeText(key) };
  }
  if (key instanceof Uint8Array) {
    return { kind: 0, bytes: key, encoded: encodeBytes(key) };
  }
  throw new BencodexError('dictionary keys must be strings or Uint8Array');
}

function compareBytes(a, b) {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.byteLength - b.byteLength;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Uint8Array || value instanceof Map) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function encode(value) {
  if (value === null) return ascii('n');
  if (typeof value === 'boolean') return ascii(value ? 't' : 'f');
  if (typeof value === 'bigint') return ascii(`i${value.toString()}e`);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BencodexError('numbers must be safe integers');
    return ascii(`i${BigInt(value).toString()}e`);
  }
  if (typeof value === 'string') return encodeText(value);
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (Array.isArray(value)) {
    return concat([ascii('l'), ...value.map((item) => encode(item)), ascii('e')]);
  }
  if (value instanceof Map || isPlainObject(value)) {
    const entries = value instanceof Map
      ? [...value.entries()]
      : Object.entries(value);
    const encodedEntries = entries.map(([key, item]) => {
      const sortKey = keySortValue(key);
      return { sortKey, value: encode(item) };
    });
    encodedEntries.sort((a, b) => {
      if (a.sortKey.kind !== b.sortKey.kind) return a.sortKey.kind - b.sortKey.kind;
      return compareBytes(a.sortKey.bytes, b.sortKey.bytes);
    });
    const parts = [ascii('d')];
    for (const entry of encodedEntries) {
      parts.push(entry.sortKey.encoded, entry.value);
    }
    parts.push(ascii('e'));
    return concat(parts);
  }
  throw new BencodexError(`unsupported value type: ${typeof value}`);
}

class Decoder {
  constructor(input) {
    this.input = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.offset = 0;
  }

  eof() {
    return this.offset >= this.input.byteLength;
  }

  peek() {
    if (this.eof()) throw new BencodexError('unexpected end of input');
    return this.input[this.offset];
  }

  take() {
    const b = this.peek();
    this.offset++;
    return b;
  }

  readUntil(byte) {
    const start = this.offset;
    while (!this.eof() && this.input[this.offset] !== byte) {
      this.offset++;
    }
    if (this.eof()) throw new BencodexError(`missing delimiter 0x${byte.toString(16)}`);
    const out = this.input.slice(start, this.offset);
    this.offset++;
    return out;
  }

  readLength(prefixAlreadyRead) {
    const start = prefixAlreadyRead ? this.offset - 1 : this.offset;
    while (!this.eof()) {
      const b = this.input[this.offset];
      if (b === 0x3a) break;
      if (b < 0x30 || b > 0x39) throw new BencodexError('invalid byte string length');
      this.offset++;
    }
    if (this.eof()) throw new BencodexError("missing ':' in byte string");
    const raw = textDecoder.decode(this.input.slice(start, this.offset));
    if (raw.length > 1 && raw.startsWith('0')) throw new BencodexError('invalid byte string length');
    this.offset++;
    const len = Number(raw);
    if (!Number.isSafeInteger(len) || len < 0) throw new BencodexError('invalid byte string length');
    return len;
  }

  readBytes(prefixAlreadyRead = false) {
    const len = this.readLength(prefixAlreadyRead);
    if (this.input.byteLength < this.offset + len) throw new BencodexError('unexpected end of byte string');
    const out = this.input.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readInteger() {
    const rawBytes = this.readUntil(0x65);
    const raw = textDecoder.decode(rawBytes);
    if (raw === '' || raw === '-' || raw.startsWith('-0') || (raw.startsWith('0') && raw.length > 1)) {
      throw new BencodexError('invalid integer encoding');
    }
    try {
      return BigInt(raw);
    } catch {
      throw new BencodexError(`cannot parse integer: ${raw}`);
    }
  }

  readValue() {
    const tag = this.take();
    if (tag === 0x6e) return null;
    if (tag === 0x74) return true;
    if (tag === 0x66) return false;
    if (tag === 0x69) return this.readInteger();
    if (tag === 0x75) return textDecoder.decode(this.readBytes());
    if (tag >= 0x30 && tag <= 0x39) return this.readBytes(true);
    if (tag === 0x6c) {
      const items = [];
      while (this.peek() !== 0x65) {
        items.push(this.readValue());
      }
      this.offset++;
      return items;
    }
    if (tag === 0x64) {
      const items = new Map();
      while (this.peek() !== 0x65) {
        const keyTag = this.take();
        let key;
        if (keyTag === 0x75) key = textDecoder.decode(this.readBytes());
        else if (keyTag >= 0x30 && keyTag <= 0x39) key = this.readBytes(true);
        else throw new BencodexError('dictionary key must be bytes or text');
        items.set(key, this.readValue());
      }
      this.offset++;
      return items;
    }
    throw new BencodexError(`unexpected byte: 0x${tag.toString(16)}`);
  }
}

function decode(bytes) {
  const decoder = new Decoder(bytes);
  const value = decoder.readValue();
  if (!decoder.eof()) throw new BencodexError('trailing bytes after value');
  return value;
}

function isDictionary(value) {
  return value instanceof Map;
}

function getText(map, key) {
  const value = map.get(key);
  return typeof value === 'string' ? value : undefined;
}

function getBoolean(map, key) {
  const value = map.get(key);
  return typeof value === 'boolean' ? value : undefined;
}

module.exports = {
  BencodexError,
  decode,
  encode,
  getBoolean,
  getText,
  isDictionary,
};
