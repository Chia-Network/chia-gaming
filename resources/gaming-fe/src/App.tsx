import React, { useEffect, useState } from 'react';
import { Box, Typography } from "@mui/material";
import Game from './components/Game';
import LobbyScreen from "./components/LobbyScreen";
import WalletConnectHeading from "./components/WalletConnectHeading";
import Gallery from "./components/Gallery";
import { getGameSelection, getSearchParams } from './util';
import { CHAIN_ID, PROJECT_ID, RELAY_URL } from './constants/env';
import { WalletConnectProvider } from './hooks/WalletConnectContext';
import { blockchainDataEmitter } from './hooks/BlockchainInfo';

const App: React.FC = () => {
  const gameSelection = getGameSelection();
  const params = getSearchParams();
  const shouldRedirectToLobby = !params.lobby && !params.iStarted;
  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState("about:blank");

  console.log("Build 6:25 Entering App.tsx URL PARAMS: ", params);

  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (peak: any) => {
        setHavePeak(true);
      }
    });

    return () => subscription.unsubscribe();
  });

  // Redirect to the lobby if we haven't been given enough information to render
  // the game yet.
  //
  // This will be inside a frame whose parent owns the wallet and blockchain
  // connection soon.  I think we can change the iframe location from the outside
  // in that scenario.
  useEffect(() => {
    if (shouldRedirectToLobby) {
      fetch("/urls").then((res) => res.json()).then((urls) => {
        console.log('navigate to lobby', urls);
        if (gameSelection) {
          setIframeUrl(`${urls.tracker}&token=${gameSelection.token}&view=game`);
        } else {
          setIframeUrl(`${urls.tracker}&view=game`);
        }
      });
    }
  }, [params]);

  if (params.lobby) {
    console.log('params.lobby detected in', params);
    return (
      <LobbyScreen />
    );
  }

  if (params.gallery) {
    return <Gallery />;
  }

  if (params.game && !params.join) {
    console.log('params.game detected in', params);
    return <Game />;
  }

  const wcHeading = (
    <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '3rem', width: '100%' }}>
      <WalletConnectHeading/>
    </div>
  );

  if (!havePeak) {
    return (
      <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
        {wcHeading}
        <Box p={4} maxWidth={600} mx="auto">
          <Typography variant="h4" gutterBottom>
            Waiting for wallet connect connection (use the menu).
          </Typography>
        </Box>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', position: 'relative', left: 0, top: 0, width: '100vw', height: '100vh', flexDirection: "column" }}>
      {wcHeading}
      <iframe id='subframe' style={{ display: 'flex', width: '100%', flexShrink: 1, flexGrow: 1, height: '100%' }} src={iframeUrl}></iframe>
    </div>
  );
};

export default App;
