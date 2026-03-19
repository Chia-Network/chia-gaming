import { Spend, CoinSpend, SpendBundle } from './types/ChiaGaming';

export function toUint8(s: string) {
  if (s.length % 2 != 0) {
    throw 'Odd length hex string';
  }
  const result = new Uint8Array(s.length >> 1);
  for (let i = 0; i < s.length; i += 2) {
    const sub = s.slice(i, i + 2);
    const val = parseInt(sub, 16);
    result[i >> 1] = val;
  }
  return result;
}

// Thanks: https://stackoverflow.com/questions/34309988/byte-array-to-hex-string-conversion-in-javascript
export function toHexString(byteArray: Uint8Array | number[]) {
  return Array.from(byteArray, function (byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2);
  }).join('');
}

export type FragmentData = Record<string, string>;

export function getParamsFromString(paramString: string): Record<string, string> {
  const fragmentParts = paramString.split('&');
  const params = Object.fromEntries(
    fragmentParts.map((part) => {
      const partEqIdx = part.indexOf('=');

      if (partEqIdx > 0) {
        return [part.substring(0, partEqIdx), part.substring(partEqIdx + 1)];
      }

      return [part, 'true'];
    }),
  );
  return params;
}

// If we were given a token parameter in the fragment, parse it out here.
export function getFragmentParams(): FragmentData {
  const fragment = window.location.hash;
  return getParamsFromString(fragment);
}

export function getSearchParams(): Record<string, string> {
  if (window.location.search === '') {
    return {};
  }
  const search = window.location.search.substring(1);
  return getParamsFromString(search);
}

export function updateAlias(alias: string) {
  localStorage.setItem('alias', alias);
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateOrRetrieveAlias(): string {
  let previousName = localStorage.getItem('alias');
  if (previousName) return previousName;
  previousName = `Player_${randomHex().substring(0, 8)}`;
  updateAlias(previousName);
  return previousName;
}

export function generateOrRetrieveUniqueId(): string {
  let existingId = localStorage.getItem('playerId');
  if (existingId) return existingId;
  existingId = randomHex();
  localStorage.setItem('playerId', existingId);
  return existingId;
}

export function generateOrRetrieveSessionId(): string {
  let id = localStorage.getItem('sessionId');
  if (id) return id;
  id = randomHex();
  localStorage.setItem('sessionId', id);
  return id;
}

function clvm_enlist(clvms: string[]): string {
  const result = [];

  for (const clvm of clvms) {
    result.push('ff');
    result.push(clvm);
  }

  result.push('80');
  return result.join('');
}

function clvm_length(atom: string): string {
  const byteLen = atom.length / 2;
  if (byteLen <= 63) {
    const alen = (byteLen | 0x80).toString(16).padStart(2, '0');
    return alen + atom;
  } else {
    const alen = (byteLen | 0xc000).toString(16).padStart(4, '0');
    return alen + atom;
  }
}

function spend_to_clvm(spend: Spend): string {
  const spend_clvm = clvm_enlist([
    spend.puzzle,
    spend.solution,
    clvm_length(spend.signature),
  ]);
  return spend_clvm;
}

function coin_spend_to_clvm(coinspend: CoinSpend): string {
  const coin_spend_clvm = clvm_enlist([
    clvm_length(coinspend.coin),
    spend_to_clvm(coinspend.bundle),
  ]);
  return coin_spend_clvm;
}

export function spend_bundle_to_clvm(sbundle: SpendBundle): string {
  const bundle_clvm = clvm_enlist(
    sbundle.spends.map((s) => coin_spend_to_clvm(s)),
  );
  return bundle_clvm;
}

export async function empty() {
  return {};
}

export function getRandomInt(max: number) {
  return Math.floor(Math.random() * max);
}

export function getEvenHexString(n: number) {
  let hexString = n.toString(16);
  if (hexString.length & 1) {
    hexString = '0' + hexString;
  }
  return hexString;
}

export function formatAmount(mojos: bigint): string {
  if (mojos < 1_000_000n) {
    return `${mojos} MOJO`;
  }
  const TRILLION = 1_000_000_000_000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} XCH`;
}

export function formatMojos(mojos: bigint): string {
  const TRILLION = 1_000_000_000_000n;
  const absMojos = mojos < 0n ? -mojos : mojos;
  if (absMojos >= 100_000_000n) {
    const sign = mojos < 0n ? '-' : '';
    const whole = absMojos / TRILLION;
    const frac = absMojos % TRILLION;
    const fracStr = frac.toString().padStart(12, '0').slice(0, 4);
    return `${sign}${whole.toLocaleString()}.${fracStr} XCH`;
  }
  return `${mojos.toLocaleString()} mojos`;
}
