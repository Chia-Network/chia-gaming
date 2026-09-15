export const APP_SCHEME = 'chiagaming';
export const APP_HOST = 'app';

export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Matched on scheme and host because URL.origin is `null` for this custom
 * scheme, while Chromium serializes the app origin with a trailing slash.
 */
export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

export function isPlayerAppDocumentUrl(value: string): boolean {
  if (!isAppUrl(value)) return false;
  return new URL(value).pathname === '/index.html';
}
