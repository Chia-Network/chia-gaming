import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import HubScreen from './hub';
import { hubSessionFromParentMessage, parentOriginsFromPayload } from './iframeAuth';

// Only the embedding player app may drive the theme. The parent's origin
// varies by deployment (and is a custom scheme in the desktop build), so the
// check is on window identity rather than a fixed origin.
window.addEventListener('message', (ev) => {
  if (window.parent === window || ev.source !== window.parent) return;
  if (ev.data?.type === 'theme-sync') {
    document.documentElement.classList.toggle('dark', !!ev.data.dark);
  }
});
if (window.parent !== window) {
  window.parent.postMessage({ type: 'theme-request' }, '*');
}

function HubApp() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (window.parent === window) return;
    let active = true;
    let handleMessage: ((event: MessageEvent) => void) | undefined;
    const installAuthListener = async () => {
      const response = await fetch('/parent-origins.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`parent origin policy returned ${response.status}`);
      const allowedParentOrigins = parentOriginsFromPayload(await response.json());
      if (allowedParentOrigins === null) throw new Error('invalid parent origin policy');
      if (!active) return;
      handleMessage = (event: MessageEvent) => {
        const receivedSessionId = hubSessionFromParentMessage(
          event,
          window.parent,
          allowedParentOrigins,
        );
        if (receivedSessionId !== null) setSessionId(receivedSessionId);
      };
      window.addEventListener('message', handleMessage);
      window.parent.postMessage({ type: 'hub-auth-request' }, '*');
    };
    void installAuthListener().catch((error: unknown) => {
      console.error(`Failed to load hub parent-origin policy: ${String(error)}`);
    });
    return () => {
      active = false;
      if (handleMessage) window.removeEventListener('message', handleMessage);
    };
  }, []);

  return sessionId === null ? null : <HubScreen sessionId={sessionId} />;
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(<HubApp />);
