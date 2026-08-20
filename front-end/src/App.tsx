import Shell from './components/Shell';
import { GameHostProvider } from '@games/host/ui';
import { getCurrencyLabels } from './constants/currency';
import { formatAmount, formatMojos } from './util';

const hostServices = {
  formatAmount,
  formatMojos,
  get currencyLabels() {
    return getCurrencyLabels();
  },
};

const App = () => (
  <GameHostProvider services={hostServices}>
    <Shell />
  </GameHostProvider>
);

export default App;
