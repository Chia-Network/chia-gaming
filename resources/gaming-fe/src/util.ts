import { FragmentData } from './types/lobby';

import { useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Program } from 'clvm-lib';
import toUint8 from 'hex-to-uint8';

export function getParamsFromString(paramString: string): any {
  const fragmentParts = paramString.split('&');
  const params = Object.fromEntries(fragmentParts.map((part) => {
    const partEqIdx = part.indexOf('=');

    if (partEqIdx > 0) {
      return [part.substring(0, partEqIdx), part.substring(partEqIdx + 1)];
    }

    return [part, 'true'];
  }));
  return params;
}

// If we were given a token parameter in the fragment, parse it out here.
export function getFragmentParams(): FragmentData {
  const fragment = window.location.hash;
  return getParamsFromString(fragment);
}

export function getSearchParams(): any {
  if (window.location.search === '') {
    return {};
  }
  const search = window.location.search.substring(1);
  return getParamsFromString(search);
}

export function updateAlias(alias: string) {
  localStorage.setItem("alias", alias);
}

export function generateOrRetrieveAlias(): string {
  let previousName = localStorage.getItem("alias");
  if (previousName) {
    return previousName;
  }

  previousName = `newUser${uuidv4()}`;
  updateAlias(previousName);
  return previousName;
}

export function generateOrRetrieveUniqueId(): string {
  let existingId = localStorage.getItem("uniqueId");
  if (existingId) {
    return existingId;
  }
  existingId = uuidv4();
  localStorage.setItem("uniqueId", existingId);
  return existingId;
}

// https://overreacted.io/making-setinterval-declarative-with-react-hooks/
export function useInterval(callback: () => void, delay: number) {
  const savedCallback = useRef<() => void | undefined>(undefined);

  // Remember the latest callback.
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  // Set up the interval.
  useEffect(() => {
    function tick() {
      if (savedCallback.current) {
        savedCallback.current();
      }
    }
    if (delay !== null) {
      let id = setInterval(tick, delay);
      return () => clearInterval(id);
    }
  }, [delay]);
}

interface GameSelection {
  game: string;
  token: string;
  walletToken: string;
};
// Return true if game= and token= are present in the url.
export function getGameSelection(): GameSelection | undefined {
  const search = getSearchParams();
  if (search.game && search.token && search.walletToken) {
    return {
      game: search.game,
      token: search.token,
      walletToken: search.walletToken
    };
  }
  return undefined;
}

function clvm_enlist(clvms: string[]): string {
  let result = [];

  for (var i = 0; i < clvms.length; i++) {
    result.push('ff');
    result.push(clvms[i]);
  }

  result.push('80');
  console.log(result);
  return result.join("");
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
  const spend_clvm = clvm_enlist([spend.puzzle, spend.solution, clvm_length(spend.signature)]);
  console.log('spend', spend_clvm);
  return spend_clvm;
}

function coin_spend_to_clvm(coinspend: any): string {
  const coin_spend_clvm = clvm_enlist([clvm_length(coinspend.coin), spend_to_clvm(coinspend.bundle)]);
  console.log('coin_spend', coin_spend_clvm);
  return coin_spend_clvm;
}

function explode(p: any): any {
  if (p.value instanceof Uint8Array) {
    return p.value;
  } else {
    return [explode(p.value[0]), explode(p.value[1])];
  }
}

export function proper_list(p: any): any {
  const result = [];
  while(!(p instanceof Uint8Array)) {
    result.push(p[0]);
    p = p[1];
  }
  return result;
}

export function decode_sexp_hex(h: string): any {
  let p = Program.deserialize(toUint8(h));
  const result = null;
  return explode(p);
}

export function spend_bundle_to_clvm(sbundle: any): string {
  const bundle_clvm = clvm_enlist(sbundle.spends.map((s: any) => coin_spend_to_clvm(s)));
  console.log('bundle', bundle_clvm);
  return bundle_clvm;
}

export function popcount(n: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    r += n & 1;
    n >>= 1;
  }
  return r;
}
