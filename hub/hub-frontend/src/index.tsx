import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import HubScreen from './hub';
import { hubSessionFromParentMessage } from './iframeAuth';

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
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return sessionId === null ? null : <HubScreen sessionId={sessionId} />;
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(<HubApp />);
