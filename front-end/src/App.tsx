import Shell from './components/Shell';
import OAuthCallback from './components/OAuthCallback';
import { CLOUD_WALLET_OAUTH_CALLBACK_PATH } from './constants/env';

function isOAuthCallbackPath(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const target = CLOUD_WALLET_OAUTH_CALLBACK_PATH.replace(/\/$/, '') || '/oauth/callback';
  return path === target || path.endsWith(target);
}

const App = () => (isOAuthCallbackPath() ? <OAuthCallback /> : <Shell />);

export default App;
