// Krunk dictionary helpers. Normalises a user-supplied word list to the
// canonical form (uppercase, trimmed, 5-letter words, sorted, de-duped)
// before currying it into the krunk CLVM programs. The wasm side does
// the same normalisation when computing dict_hash, so the hash shown
// to the user matches the hash the wasm layer produces.

const DEFAULT_DICT_URL = 'clsp/games/krunk/krunkwords.txt';

export function normaliseKrunkWords(raw: string): string[] {
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const w = line.trim().toUpperCase();
    if (w.length === 0) continue;
    seen.add(w);
  }
  return Array.from(seen).sort();
}

export function countValidKrunkWords(words: string[]): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const w of words) {
    if (w.length === 5 && /^[A-Z]{5}$/.test(w)) {
      valid.push(w);
    } else {
      invalid.push(w);
    }
  }
  return { valid, invalid };
}

let cachedDefaultDict: string | null = null;

export async function fetchDefaultKrunkDictionary(
  fetcher: (url: string) => Promise<string> = (u) => fetch(u).then((r) => r.text()),
): Promise<string> {
  if (cachedDefaultDict !== null) return cachedDefaultDict;
  const text = await fetcher(DEFAULT_DICT_URL);
  cachedDefaultDict = text;
  return text;
}
