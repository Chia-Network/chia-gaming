import { v4 as uuidv4 } from 'uuid';
import { GameSessionParams } from './types/ChiaGaming';

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
export function toHexString(byteArray: number[]) {
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

export function generateOrRetrieveAlias(): string {
  let previousName = localStorage.getItem('alias');
  if (previousName) {
    return previousName;
  }

  previousName = `newUser${uuidv4()}`;
  updateAlias(previousName);
  return previousName;
}

export function generateOrRetrieveUniqueId(): string {
  let existingId = localStorage.getItem('uniqueId');
  if (existingId) {
    return existingId;
  }
  existingId = uuidv4();
  localStorage.setItem('uniqueId', existingId);
  return existingId;
}

interface GameSelection {
  game: string;
  token: string;
}
// Return true if game= and token= are present in the url.
export function getGameSelection(): GameSelection | undefined {
  const search = getSearchParams();
  if (search.game && search.join) {
    return {
      game: search.game,
      token: search.join,
    };
  }
  return undefined;
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
  if (atom.length <= 0x80) {
    const alen = ((atom.length / 2) | 0x80).toString(16);
    return alen + atom;
  } else {
    const alen = ((atom.length / 2) | 0xc000).toString(16);
    return alen + atom;
  }
}

function spend_to_clvm(spend: any): string {
  const spend_clvm = clvm_enlist([
    spend.puzzle,
    spend.solution,
    clvm_length(spend.signature),
  ]);
  return spend_clvm;
}

function coin_spend_to_clvm(coinspend: any): string {
  const coin_spend_clvm = clvm_enlist([
    clvm_length(coinspend.coin),
    spend_to_clvm(coinspend.bundle),
  ]);
  return coin_spend_clvm;
}

export function spend_bundle_to_clvm(sbundle: any): string {
  const bundle_clvm = clvm_enlist(
    sbundle.spends.map((s: any) => coin_spend_to_clvm(s)),
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

export function formatMojos(mojos: number): string {
  const xch = mojos / 1e12;
  if (Math.abs(xch) >= 0.0001) {
    return `${xch.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} XCH`;
  }
  return `${mojos.toLocaleString()} mojos`;
}

export function parseGameSessionParams(raw: Record<string, string | undefined>): GameSessionParams {
  const iStarted = raw.iStarted !== 'false';
  const amountStr = raw.amount;
  if (!amountStr) throw new Error('Missing required URL param: amount');
  const amount = parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid amount: ${amountStr}`);
  let perGameAmount = Math.floor(amount / 10);
  if (raw.perGame) {
    const parsed = parseInt(raw.perGame, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid perGame: ${raw.perGame}`);
    perGameAmount = parsed;
  }
  const token = raw.token;
  if (!token) throw new Error('Missing required URL param: token');
  const lobbyUrl = raw.lobbyUrl;
  if (!lobbyUrl) throw new Error('Missing required URL param: lobbyUrl');
  return { iStarted, amount, perGameAmount, token, lobbyUrl };
}