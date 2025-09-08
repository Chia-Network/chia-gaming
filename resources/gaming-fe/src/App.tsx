import React, { useEffect } from 'react';
import Game from './components/Game';
import LobbyScreen from "./components/LobbyScreen";
import { getGameSelection, getSearchParams } from './util';

const App: React.FC = () => {
  const gameSelection = getGameSelection();
  const params = getSearchParams();
  const shouldRedirectToLobby = !params.lobby && !params.iStarted;

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
          window.location.replace(`${urls.tracker}&token=${gameSelection.token}`);
        } else {
          window.location.replace(urls.tracker);
        }
      });
    }
  }, [params]);

  // Dummy render for the redirect.
  if (shouldRedirectToLobby) {
    return (<div/>);
  }

  if (!params.iStarted) {
    return (
      <LobbyScreen />
    );
  }

  return <Game />;
};

export default App;
