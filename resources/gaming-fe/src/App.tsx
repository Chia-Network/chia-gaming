import React, { useState, useEffect, useCallback } from 'react';
import Game from './components/Game';
import LobbyScreen from "./components/LobbyScreen";
import WalletConnectHeading from './components/WalletConnectHeading';
import { useWalletConnect } from "./hooks/WalletConnectContext";
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

type AppModeType = "disconnected" | "app_has_lobby_subframe" | "app_has_game_subframe" | "app_is_game_subframe" | "app_is_lobby_subframe";

const App: React.FC = () => {
  const params = getSearchParams();
  const [chatInput, setChatInput] = useState('');
  const [receivedWalletConnect, setReceivedWalletConnect] = useState(false);
  const [lobbyUrl, setLobbyUrl] = useState('about:blank');

  const listenForWalletConnect = useCallback((e: any) => {
    const messageKey = e.message ? 'message' : 'data';
    const messageData = e[messageKey];
    // console.warn('lobby: inner frame received message', messageData);
    console.log(`App.tsx: got message: ${messageData.name}`);
    if (messageData.name === 'walletconnect_up' && !receivedWalletConnect) {
      console.log("App.tsx :got walletconnect_up");
      setReceivedWalletConnect(true);
    }
  }, []);

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

  let app_mode: AppModeType = "disconnected";
  if (params.lobby) {
    app_mode = "app_is_lobby_subframe";
  } else if (params.game && !params.join) {
    app_mode = "app_is_game_subframe";
  } else if (!receivedWalletConnect) {
    app_mode = "disconnected";
  } else {
    if (lobbyUrl.startsWith(window.location.origin)) {
      app_mode =  "app_has_game_subframe";
    } else {
      app_mode = "app_has_lobby_subframe";
    }
  }

  if (app_mode === "app_is_lobby_subframe") {
    return (<LobbyScreen receivedWalletConnect={receivedWalletConnect} />);
  } else if (app_mode === "app_is_game_subframe") {
    return (<Game receivedWalletConnect={receivedWalletConnect} />);
  } else if (app_mode === "disconnected") {
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading />
        </div>
        <Box p={4} maxWidth={600} mx="auto">
          <Typography variant="h4" gutterBottom>
            Waiting for wallet connect connection (use the menu).
          </Typography>
        </Box>
      </div>
    );
  } else if (app_mode === "app_has_game_subframe" || app_mode === "app_has_lobby_subframe") {
    // Iframe host for the lobby first, then the game.
    // TODO: Tell iframe what kind it is.
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading />
        </div>
        <iframe id='subframe' style={{ display: 'flex', width: '100%', flexShrink: 1, flexGrow: 1, height: '100%' }} src={lobbyUrl}></iframe>
      </div>
    );
  } else {
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
          <WalletConnectHeading />
        </div>
              <Typography variant="h1" gutterBottom>
                DAMN. {app_mode}
              </Typography>
      </div>
  }
};

export default App;
