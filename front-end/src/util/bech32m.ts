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
