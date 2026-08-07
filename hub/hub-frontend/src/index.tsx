import React from 'react';
import { createRoot } from 'react-dom/client';

import HubScreen from './hub';

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

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(<HubScreen />);
