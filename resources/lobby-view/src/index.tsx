import { CssBaseline } from '@mui/material';
import React from 'react';
import { createRoot } from 'react-dom/client';

import LobbyScreen from './lobby';

const container = document.getElementById('root');
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <CssBaseline />
    <LobbyScreen />
  </React.StrictMode>,
);
