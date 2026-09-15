import { isAppUrl } from './appUrl.ts';

const OAUTH_CALLBACK_PATH = '/oauth/callback';
const APP_DOCUMENT_PATHS = new Set(['/index.html', '/about.html', OAUTH_CALLBACK_PATH]);

type AppSchemeRequest = {
  url: string;
  headers: Headers;
  referrer: string;
};

function normalizeDocumentPath(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}

function isDocumentNavigation(request: AppSchemeRequest, pathname: string): boolean {
  return (
    APP_DOCUMENT_PATHS.has(normalizeDocumentPath(pathname)) &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document'
  );
}

export function isOAuthCallbackPath(pathname: string): boolean {
  return normalizeDocumentPath(pathname) === OAUTH_CALLBACK_PATH;
}

export function appAssetCacheControl(filePath: string): string {
  return filePath.toLowerCase().endsWith('.html')
    ? 'no-store'
    : 'public, max-age=31536000, immutable';
}

export function isAppSchemeRequestAllowed(request: AppSchemeRequest): boolean {
  const url = new URL(request.url);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') {
    return true;
  }
  if (fetchSite === 'cross-site') {
    return isOAuthCallbackPath(url.pathname) && isDocumentNavigation(request, url.pathname);
  }

  const origin = request.headers.get('origin');
  if (origin) {
    return isAppUrl(origin);
  }
  if (request.referrer && request.referrer !== 'about:client') {
    return isAppUrl(request.referrer);
  }
  return isDocumentNavigation(request, url.pathname);
}
