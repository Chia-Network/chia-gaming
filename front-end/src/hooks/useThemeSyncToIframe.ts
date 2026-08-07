import { useEffect } from 'react';

function buildVarsPayload(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (let i = 0; i < styles.length; i++) {
    const name = styles[i];
    if (name && name.startsWith('--')) {
      vars[name] = styles.getPropertyValue(name).trim();
    }
  }
  return vars;
}

function frameElement(iframeId: string): HTMLIFrameElement | null {
  return document.getElementById(iframeId) as HTMLIFrameElement | null;
}

function syncThemeToIframe(iframeId: string, frameOrigin: string | null) {
  const iframe = frameElement(iframeId);
  if (!iframe) return;

  const payload = buildVarsPayload();
  const isDark = document.documentElement.classList.contains('dark');

  try {
    const doc = iframe.contentDocument;
    if (doc && doc.documentElement) {
      const targetRoot = doc.documentElement;
      Object.keys(payload).forEach((k) => {
        targetRoot.style.setProperty(k, payload[k]);
      });
      if (isDark) targetRoot.classList.add('dark');
      else targetRoot.classList.remove('dark');
      return;
    }
  } catch {
    // Access denied -> cross-origin, fall back to postMessage
  }

  // Addressed to the frame's own origin rather than '*': the hub is untrusted
  // third-party code, and a frame that navigated elsewhere must not keep
  // receiving messages meant for it.
  if (frameOrigin === null) return;
  try {
    iframe.contentWindow?.postMessage(
      { type: 'theme-sync', vars: payload, dark: isDark },
      frameOrigin,
    );
  } catch {
    // ignore
  }
}

type ThemeSyncOptions = {
  iframeId: string;
  /** Origin of the document in the frame. Outbound sync is skipped when null. */
  frameOrigin: string | null;
  /** Current frame src. A change re-establishes the subscription. */
  frameUrl: string | null;
};

/**
 * Pushes CSS custom properties and dark-mode class from the parent document
 * into an iframe. Works same-origin (direct DOM access) and cross-origin
 * (postMessage fallback). Re-syncs on iframe load, dark-mode toggle, and
 * explicit theme-request messages from the frame.
 *
 * Inbound messages are accepted only from the frame this hook syncs, verified
 * by both window identity and origin, so no other frame or opener can drive
 * theme work in the player document.
 */
export function useThemeSyncToIframe({ iframeId, frameOrigin, frameUrl }: ThemeSyncOptions) {
  useEffect(() => {
    const sync = () => syncThemeToIframe(iframeId, frameOrigin);

    const iframeEl = frameElement(iframeId);
    iframeEl?.addEventListener('load', sync);

    function messageHandler(ev: MessageEvent) {
      if (ev.data === null || typeof ev.data !== 'object') return;
      if ((ev.data as { type?: unknown }).type !== 'theme-request') return;
      // Look the frame up per event: the element is replaced when the src changes.
      const iframe = frameElement(iframeId);
      if (iframe === null || ev.source !== iframe.contentWindow) return;
      if (frameOrigin !== null && ev.origin !== frameOrigin) return;
      sync();
    }
    window.addEventListener('message', messageHandler);

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const initialSync = setTimeout(sync, 150);

    return () => {
      clearTimeout(initialSync);
      iframeEl?.removeEventListener('load', sync);
      window.removeEventListener('message', messageHandler);
      observer.disconnect();
    };
  }, [iframeId, frameOrigin, frameUrl]);
}
