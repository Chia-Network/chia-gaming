import React from 'react';
import { createRoot } from 'react-dom/client';

import LobbyScreen from './lobby';

window.addEventListener('message', (ev) => {
  if (ev.data?.type === 'theme-sync') {
    document.documentElement.classList.toggle('dark', !!ev.data.dark);
  }
});
if (window.parent !== window) {
  window.parent.postMessage({ type: 'theme-request' }, '*');
}

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(
  <LobbyScreen />,
);
