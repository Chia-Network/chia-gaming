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
  const origin = originOfUrl(url);
  if (!isMainFrame) {
    return origin !== null && policy.allowedFrameOrigins.has(origin);
  }
  return origin !== null && policy.allowedPopupOrigins.has(origin);
}
