import Game from './components/Game';
import ParentFrame from './components/ParentFrame';
import { getSearchParams } from './util';

const App = () => {
  const params = getSearchParams();

  if (params.game && !params.join) {
    return <Game params={params} />;
  }

  return <ParentFrame params={params} />;
};

export default App;
