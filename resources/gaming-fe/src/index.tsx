import { CssBaseline } from '@mui/material';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// Install theme-sync listener as early as possible so cross-origin iframes
// can receive theme updates from the parent. Also request the parent
// to resend the current theme in case the parent's initial postMessage
// happened before this listener was attached.
import installThemeSyncListener from './utils/themeSyncListener';

// install listener immediately
const uninstallThemeListener = installThemeSyncListener();
// ask parent for theme (no-op if not embedded)
try {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'theme-request' }, '*');
  }
} catch (e) {
  // ignore
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <CssBaseline />
    <App />
  </React.StrictMode>,
);

// Optional: leave listener installed for life of page; if unmount logic
// ever added, call `uninstallThemeListener()` to remove.
