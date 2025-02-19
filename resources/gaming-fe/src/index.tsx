import { CssBaseline } from '@mui/material';
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

import { CHAIN_ID, PROJECT_ID, RELAY_URL } from './constants/env';
import { JsonRpcProvider } from './hooks/JsonRpcContext';
import { WalletConnectProvider } from './hooks/WalletConnectContext';

ReactDOM.render(
  <React.StrictMode>
        <WalletConnectProvider
            projectId={PROJECT_ID}
            relayUrl={RELAY_URL}
            chainId={CHAIN_ID}
        >
            <JsonRpcProvider>
                <CssBaseline />
                <App />
            </JsonRpcProvider>
        </WalletConnectProvider>
  </React.StrictMode>,
  document.getElementById('root')
);

