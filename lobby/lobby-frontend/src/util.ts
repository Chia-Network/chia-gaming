function getParamsFromString(paramString: string): any {
  const fragmentParts = paramString.split('&');
  return Object.fromEntries(
    fragmentParts.map((part) => {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) return [part.substring(0, eqIdx), part.substring(eqIdx + 1)];
      return [part, 'true'];
    }),
  );
}

export function getSearchParams(): any {
  if (window.location.search === '') return {};
  return getParamsFromString(window.location.search.substring(1));
}
