import { log } from '../services/log';
import { markAutoResumeOnce, markSavedSession } from '../hooks/save';

export function normalizeBasePath(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Pathname form of a basePath or absolute URL, for equality checks. */
export function basePathKey(pathOrUrl: string): string {
  try {
    if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(pathOrUrl)) {
      return normalizeBasePath(new URL(pathOrUrl).pathname);
    }
  } catch {
    /* fall through */
  }
  return normalizeBasePath(pathOrUrl);
}

/**
 * The nonce base URL this page was booted with (`<base href>` from build-meta).
 * Prefers the IDL `href` (absolute) so resolution matches document.baseURI.
 */
export function pageBasePath(
  doc: Pick<Document, 'querySelector' | 'baseURI'> | null =
    typeof document !== 'undefined' ? document : null,
): string | null {
  if (!doc) return null;
  const el = doc.querySelector('base') as HTMLBaseElement | null;
  if (el) {
    const href = el.href || el.getAttribute('href');
    if (href) return href;
  }
  // Fall back to document.baseURI when it already includes an /app/<nonce>/ path.
  try {
    const pathname = new URL(doc.baseURI).pathname;
    if (pathname.startsWith('/app/')) return doc.baseURI;
  } catch {
    /* ignore */
  }
  return null;
}

/** Resolve a deploy-relative asset path against the page nonce base. */
export function resolveDeployAssetUrl(
  fetchUrl: string,
  base: string | null = pageBasePath(),
): string {
  if (/^[a-zA-Z][a-zA-Z+\-.]*:/.test(fetchUrl) || fetchUrl.startsWith('//')) {
    return fetchUrl;
  }
  if (fetchUrl.startsWith('/')) {
    return fetchUrl;
  }
  if (base) {
    return new URL(fetchUrl, base.endsWith('/') ? base : `${base}/`).href;
  }
  if (typeof document !== 'undefined') {
    return new URL(fetchUrl, document.baseURI).href;
  }
  return fetchUrl;
}

/**
 * True when `/build-meta.json` points at a different nonce tree than this tab.
 * Used when a nonce-scoped asset 404s after a redeploy wiped the old files.
 */
export async function isStaleDeploy(
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  currentBase: string | null = pageBasePath(),
): Promise<boolean> {
  if (currentBase === null) return false;
  try {
    const resp = await fetchImpl('/build-meta.json', { cache: 'no-store' });
    if (!resp.ok) return false;
    const meta = await resp.json() as { basePath?: unknown };
    if (typeof meta.basePath !== 'string') return false;
    return basePathKey(meta.basePath) !== basePathKey(currentBase);
  } catch {
    return false;
  }
}

export type DeployRecoveryHooks = {
  isStale?: () => Promise<boolean>;
  reload?: () => void;
};

/**
 * On 404 of a deploy-scoped asset: reload if the live basePath moved on;
 * otherwise throw. After reload, returns a promise that never settles so
 * callers do not keep running old JS.
 */
export async function recoverFromMissingDeployAsset(
  label: string,
  url: string,
  status: number,
  statusText: string,
  hooks: DeployRecoveryHooks = {},
): Promise<never> {
  const checkStale = hooks.isStale ?? (() => isStaleDeploy());
  const reload = hooks.reload ?? (() => { window.location.reload(); });
  if (status === 404 && await checkStale()) {
    // Ensure Resume survives the reload even if a concurrent clearSession()
    // had dropped the marker while starting a fresh session. Auto-resume so
    // the user is not prompted for a deploy cutover they did not initiate.
    markSavedSession();
    markAutoResumeOnce();
    log(`[deploy] ${label} 404 for ${url}; build-meta basePath changed, reloading`);
    reload();
    return new Promise(() => {});
  }
  throw new Error(`${label} ${url}: HTTP ${status} ${statusText}`);
}
