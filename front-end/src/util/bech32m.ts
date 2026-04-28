import { bech32m } from 'bech32';

export function decodeBech32mPuzzleHash(addr: string): string | null {
  try {
    const { words } = bech32m.decode(addr);
    const bytes = bech32m.fromWords(words);
    if (bytes.length !== 32) return null;
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function encodePuzzleHashToBech32m(hexPuzzleHash: string, prefix = 'xch'): string {
  const clean = hexPuzzleHash.startsWith('0x') ? hexPuzzleHash.slice(2) : hexPuzzleHash;
  const bytes = Uint8Array.from(
    clean.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)),
  );
  const words = bech32m.toWords(bytes);
  return bech32m.encode(prefix, words);
}
