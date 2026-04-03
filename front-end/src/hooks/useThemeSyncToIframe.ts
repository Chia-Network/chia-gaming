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

function syncThemeToIframe(iframeId: string) {
  const iframe = document.getElementById(iframeId) as HTMLIFrameElement | null;
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

  try {
    iframe.contentWindow?.postMessage(
      { type: 'theme-sync', vars: payload, dark: isDark },
      '*',
    );
  } catch {
    // ignore
  }
}

/**
 * Pushes CSS custom properties and dark-mode class from the parent document
 * into an iframe. Works same-origin (direct DOM access) and cross-origin
 * (postMessage fallback). Re-syncs on iframe load, dark-mode toggle, and
 * explicit theme-request messages from the iframe.
 */
export function useThemeSyncToIframe(iframeId: string, deps: unknown[]) {
  useEffect(() => {
    const sync = () => syncThemeToIframe(iframeId);

    const iframeEl = document.getElementById(iframeId) as HTMLIFrameElement | null;
    iframeEl?.addEventListener('load', sync);

    function messageHandler(ev: MessageEvent) {
      try {
        if (ev.data && ev.data.type === 'theme-request') {
          sync();
        }
      } catch {
        // ignore
      }
    }
    window.addEventListener('message', messageHandler);

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    setTimeout(sync, 150);

    return () => {
      iframeEl?.removeEventListener('load', sync);
      window.removeEventListener('message', messageHandler);
      observer.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
