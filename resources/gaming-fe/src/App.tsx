import React from 'react';
import Game from './components/Game';
import LobbyScreen from "./components/LobbyScreen";
import { getGameSelection, getSearchParams } from './util';

const App: React.FC = () => {
  const gameSelection = getGameSelection();
  const params = getSearchParams();
  if (!params.lobby && !params.iStarted) {
    fetch("/urls").then((res) => {return res.json();}).then((urls) => {
      console.log('navigate to lobby', urls);
      if (gameSelection) {
        window.location.href = `${urls.tracker}&token=${gameSelection.token}`;
      } else {
        window.location.href = urls.tracker;
      }
    });
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
