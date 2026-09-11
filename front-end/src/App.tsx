import Shell from './components/Shell';
import OAuthCallback from './components/OAuthCallback';
import { GameHostProvider } from '@games/host/ui';
import { CLOUD_WALLET_OAUTH_CALLBACK_PATH } from './constants/env';
import { getCurrencyLabels } from './constants/currency';
import { formatAmount, formatMojos } from './util';

const hostServices = {
  formatAmount,
  formatMojos,
  get currencyLabels() {
    return getCurrencyLabels();
  },
};

function isOAuthCallbackPath(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const target = CLOUD_WALLET_OAUTH_CALLBACK_PATH.replace(/\/$/, '') || '/oauth/callback';
  return path === target || path.endsWith(target);
}

const App = () =>
  isOAuthCallbackPath() ? (
    <OAuthCallback />
  ) : (
    <GameHostProvider services={hostServices}>
      <Shell />
    </GameHostProvider>
  );

export default App;
