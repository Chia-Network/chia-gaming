export type FragmentData = Record<string, string>;

export function getParamsFromString(paramString: string): any {
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

export function getSearchParams(): any {
  if (window.location.search === '') {
    return {};
  }
  const search = window.location.search.substring(1);
  return getParamsFromString(search);
}
