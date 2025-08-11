import React, { useState, useEffect, useCallback } from 'react';
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
  const [receivedWalletConnect, setReceivedWalletConnect] = useState(false);
  const { client, session, pairings, connect, disconnect } = useWalletConnect();
  const [lobbyUrl, setLobbyUrl] = useState('about:blank');

  const listenForWalletConnect = useCallback((e: any) => {
    const messageKey = e.message ? 'message' : 'data';
    const messageData = e[messageKey];
    console.warn('lobby: inner frame received message', messageData);
    if (messageData.name === 'walletconnect_up' && !receivedWalletConnect) {
      setReceivedWalletConnect(true);
    }
  }, []);

  console.warn('App, simulatorActive', simulatorActive());
  if (simulatorActive() && !receivedWalletConnect) {
    setReceivedWalletConnect(true);
  }

  useEffect(() => {
    if (!params.lobby) {
      fetch('/urls').then(res => res.json()).then(urls => {
        const trackerUrl = params.join ?
          `${urls.tracker}&join=${params.join}` :
          urls.tracker;
        setLobbyUrl(trackerUrl);
      });
    }

    console.log('doing event listener for lobby frame');
    window.addEventListener('message', listenForWalletConnect);
    return function() {
      window.removeEventListener('message', listenForWalletConnect);
    };
  });

  if (params.lobby) {
    return (<LobbyScreen walletConnect={receivedWalletConnect} simulatorActive={simulatorActive()} />);
  } else if (params.game && !params.join) {
    return (<Game />);
  } else if (!session && !simulatorActive()) {
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading client={client} session={session} pairings={pairings} connect={connect} disconnect={disconnect} simulatorActive={simulatorActive()} />
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
          <WalletConnectHeading client={client} simulatorActive={simulatorActive()} session={session} pairings={pairings} connect={connect} disconnect={disconnect}/>
        </div>
        <iframe id='subframe' style={{ display: 'flex', width: '100%', flexShrink: 1, flexGrow: 1, height: '100%' }} src={lobbyUrl}></iframe>
      </div>
    );
  }
};

export default App;
