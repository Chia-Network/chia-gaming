import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// Install theme-sync listener as early as possible so cross-origin iframes
// can receive theme updates from the parent. Also request the parent
// to resend the current theme in case the parent's initial postMessage
// happened before this listener was attached.
import installThemeSyncListener from './utils/themeSyncListener';

// Only when embedded. In the top-level shell — which is how the player app
// normally runs, and always runs in the desktop build — there is no parent
// entitled to restyle the document, and accepting theme-sync there would let
// any frame the page hosts set arbitrary CSS custom properties on it.
try {
  if (window.parent && window.parent !== window) {
    installThemeSyncListener();
    window.parent.postMessage({ type: 'theme-request' }, '*');
  }
} catch (e) {
  // ignore
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(<App />);
