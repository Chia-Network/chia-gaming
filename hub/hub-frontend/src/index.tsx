import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import HubScreen from './hub';
import { hubSessionFromParentMessage } from './iframeAuth';

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
    const handleMessage = (event: MessageEvent) => {
      const receivedSessionId = hubSessionFromParentMessage(event, window.parent);
      if (receivedSessionId !== null) setSessionId(receivedSessionId);
    };
    window.addEventListener('message', handleMessage);
    window.parent.postMessage({ type: 'hub-auth-request' }, '*');
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return sessionId === null ? null : <HubScreen sessionId={sessionId} />;
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(<HubApp />);
