/** `value` parsed when it is an https URL on a configured Cloud Wallet origin. */
export function cloudWalletUrl(
  value: unknown,
  cloudWalletOrigins: ReadonlySet<string>,
): URL | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && cloudWalletOrigins.has(url.origin) ? url : null;
}

/**
 * The OAuth `state` of an authorize URL that may be opened for this sign-in:
 * on a Cloud Wallet origin and redirecting to exactly this sign-in's loopback
 * callback. Null otherwise.
 */
export function authorizeRequestState(
  authorizeUrl: unknown,
  redirectUri: string,
  cloudWalletOrigins: ReadonlySet<string>,
): string | null {
  const url = cloudWalletUrl(authorizeUrl, cloudWalletOrigins);
  if (url === null || url.searchParams.get('redirect_uri') !== redirectUri) return null;
  return url.searchParams.get('state') || null;
}

/** True for exactly the `/token` endpoint of a Cloud Wallet origin. */
export function isCloudWalletTokenUrl(
  tokenUrl: unknown,
  cloudWalletOrigins: ReadonlySet<string>,
): boolean {
  const url = cloudWalletUrl(tokenUrl, cloudWalletOrigins);
  return url !== null && url.pathname === '/token' && url.search === '' && url.hash === '';
}
