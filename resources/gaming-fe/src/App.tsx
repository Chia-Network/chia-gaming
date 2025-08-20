import React, { useState, useCallback } from 'react';
import Game from './components/Game';
import LobbyScreen from "./components/LobbyScreen";
import WalletConnectHeading from './components/WalletConnectHeading';
import { useWalletConnect } from "./hooks/WalletConnectContext";
import { simulatorActive } from "./hooks/useFullNode";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { getSearchParams } from './util';

const App: React.FC = () => {
  const params = getSearchParams();
  const [chatInput, setChatInput] = useState('');
  const { client, session, pairings, connect, disconnect } = useWalletConnect();

  if (params.lobby || params.join) {
    return (<LobbyScreen walletConnect={!!session} simulatorActive={simulatorActive()}/>);
  } else if (params.game) {
    return (<Game />);
  } else if (!session && !simulatorActive()) {
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading client={client} session={session} pairings={pairings} connect={connect} disconnect={disconnect}/>
        </div>
        <Box p={4} maxWidth={600} mx="auto">
          <Typography variant="h4" gutterBottom>
            Waiting for wallet connect connection (use the menu).
          </Typography>
        </Box>
      </div>
    );
  } else {
    // Iframe host for the lobby first, then the game.
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading client={client} session={session} pairings={pairings} connect={connect} disconnect={disconnect}/>
        </div>
        <iframe id='subframe' style={{ display: 'flex', width: '100%', flexShrink: 1, flexGrow: 1, height: '100%' }} src={`?lobby=true&join=${params.join}`}></iframe>
      </div>
    );
  }
};

export default App;
