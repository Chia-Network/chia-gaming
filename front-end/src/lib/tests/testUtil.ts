export function getParamsFromString(paramString: string): Record<string, string> {
  const fragmentParts = paramString.split('&');
  return Object.fromEntries(
    fragmentParts.map((part) => {
      const partEqIdx = part.indexOf('=');
      if (partEqIdx > 0) {
        return [part.substring(0, partEqIdx), part.substring(partEqIdx + 1)];
      }
      return [part, 'true'];
    }),
  );
}

export function getSearchParams(): Record<string, string> {
  if (window.location.search === '') {
    return {};
  }
  const search = window.location.search.substring(1);
  return getParamsFromString(search);
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
