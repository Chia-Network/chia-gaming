import { useEffect } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';
import GameSession from './GameSession';

export interface GameParams {
  params: any;
}

const Game: React.FC<GameParams> = ({ params }) => {
  useEffect(() => {
    const uninstall = installThemeSyncListener();
    return () => uninstall();
  }, []);

  return <GameSession params={params} />;
};

export default Game;
