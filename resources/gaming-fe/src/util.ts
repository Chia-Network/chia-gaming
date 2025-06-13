import { FragmentData } from './types/lobby';
import { v4 as uuidv4 } from 'uuid';

// If we were given a token parameter in the fragment, parse it out here.
export function getFragmentParams(): FragmentData {
  const fragment = window.location.hash;
  const fragmentParts = fragment.split('&');
  const params = Object.fromEntries(fragmentParts.map((part) => {
    const partEqIdx = part.indexOf('=');

    if (partEqIdx > 0) {
      return [part.substring(0, partEqIdx), part.substring(partEqIdx + 1)];
    }

    return [part, 'true'];
  }));
  return params;
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
