import { isAppUrl } from './appUrl.ts';

const OAUTH_CALLBACK_PATH = '/oauth/callback';
const APP_DOCUMENT_PATHS = new Set(['/index.html', '/about.html', OAUTH_CALLBACK_PATH]);

type AppSchemeRequest = {
  url: string;
  headers: Headers;
  referrer: string;
};

function isDocumentNavigation(request: AppSchemeRequest, pathname: string): boolean {
  return (
    APP_DOCUMENT_PATHS.has(pathname) &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document'
  );
}

export function isOAuthCallbackPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, '') || '/';
  return normalized === OAUTH_CALLBACK_PATH;
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

type AssetRead = (filePath: string) => Promise<Uint8Array>;

export class BoundedAssetReader {
  private readonly cache = new Map<string, Promise<ArrayBuffer>>();
  private readonly waiters: Array<() => void> = [];
  private readonly read: AssetRead;
  private readonly maxConcurrentReads: number;
  private activeReads = 0;

  constructor(read: AssetRead, maxConcurrentReads = 4) {
    this.read = read;
    this.maxConcurrentReads = maxConcurrentReads;
  }

  readAsset(filePath: string): Promise<ArrayBuffer> {
    const cached = this.cache.get(filePath);
    if (cached) return cached;

    const pending = this.readWithPermit(filePath).catch((error: unknown) => {
      this.cache.delete(filePath);
      throw error;
    });
    this.cache.set(filePath, pending);
    return pending;
  }

  private async readWithPermit(filePath: string): Promise<ArrayBuffer> {
    await this.acquirePermit();
    try {
      const file = await this.read(filePath);
      return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    } finally {
      this.releasePermit();
    }
  }

  private async acquirePermit(): Promise<void> {
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activeReads += 1;
  }

  private releasePermit(): void {
    this.activeReads -= 1;
    this.waiters.shift()?.();
  }
}
