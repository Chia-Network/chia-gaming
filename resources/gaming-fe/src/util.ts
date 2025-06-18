import { FragmentData } from './types/lobby';
import { v4 as uuidv4 } from 'uuid';

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

interface GameSelection {
  game: string;
  token: string;
};
// Return true if game= and token= are present in the url.
export function getGameSelection(): GameSelection | undefined {
  const search = getSearchParams();
  if (search.game && search.token) {
    return { game: search.game, token: search.token };
  }
  return undefined;
}
