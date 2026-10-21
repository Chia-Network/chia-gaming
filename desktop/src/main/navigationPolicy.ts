import { isAppUrl, isPlayerAppDocumentUrl } from './appUrl.ts';
import { originOfUrl, type NetworkPolicy } from './networkPolicy.ts';

export function isNavigationAllowed(
  url: string,
  isMainFrame: boolean,
  policy: NetworkPolicy,
  isPlayerMainContents: boolean,
): boolean {
  if (isMainFrame && isPlayerMainContents) {
    return isPlayerAppDocumentUrl(url);
  }
  if (!isMainFrame && isPlayerMainContents && isAppUrl(url)) {
    return false;
  }
  if (url === 'about:blank' || isAppUrl(url)) {
    return true;
  }
  if (!isMainFrame) {
    const origin = originOfUrl(url);
    return origin !== null && policy.allowedFrameOrigins.has(origin);
  }
  // Only app documents load in top-level windows; Cloud Wallet pages open in
  // the system browser instead.
  return false;
}
