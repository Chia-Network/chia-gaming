import { useEffect, useState } from 'react';

import Gallery from './components/Gallery';
import Game from './components/Game';
import LobbyScreen from './components/LobbyScreen';
import WalletConnectHeading from './components/WalletConnectHeading';
import { blockchainDataEmitter } from './hooks/BlockchainInfo';
import { getGameSelection, getSearchParams } from './util';

const App = () => {
  const gameSelection = getGameSelection();
  const params = getSearchParams();
  const shouldRedirectToLobby = !params.lobby && !params.iStarted;
  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState('about:blank');

  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (_peak: any) => {
        setHavePeak(true);
      },
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
      fetch('/urls')
        .then((res) => res.json())
        .then((urls) => {
          console.log('navigate to lobby', urls);
          if (gameSelection) {
            setIframeUrl(
              `${urls.tracker}&token=${gameSelection.token}&view=game`,
            );
          } else {
            setIframeUrl(`${urls.tracker}&view=game`);
          }
        });
    }
  }, [params]);

  if (params.lobby) {
    return <LobbyScreen />;
  }

  if (params.gallery) {
    return <Gallery />;
  }

  if (params.game && !params.join) {
    return <Game />;
  }

  const wcHeading = (
    <div className="flex shrink-0 h-12 w-full">
      <WalletConnectHeading />
    </div>
  );

  if (!havePeak) {
    return (
      <div className="flex flex-col relative w-screen h-screen" style={{ backgroundColor: 'var(--color-canvas-bg)' }}>
        {wcHeading}
      </div>
    );
  }

  return (
    <div className="flex flex-col relative w-screen h-screen" style={{ backgroundColor: 'var(--color-canvas-bg)' }}>
      {wcHeading}
      <iframe
        id='subframe'
        className="w-full flex-1 border-0 m-0 p-0"
        src={iframeUrl}
      ></iframe>
    </div>
  );
};

export default App;
