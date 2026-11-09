import { useEffect, useState } from 'react';
import OAuthCallback from './components/OAuthCallback';
import Shell from './components/Shell';
import { CLOUD_WALLET_OAUTH_CALLBACK_PATH } from './constants/env';
import { createApplication } from './lib/application/Application';

function isOAuthCallbackPath(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const target = CLOUD_WALLET_OAUTH_CALLBACK_PATH.replace(/\/$/, '') || '/oauth/callback';
  return path === target || path.endsWith(target);
}

function PlayerApplication() {
  const [application] = useState(createApplication);
  useEffect(() => application.start(), [application]);
  return <Shell application={application} />;
}
const App = () => (isOAuthCallbackPath() ? <OAuthCallback /> : <PlayerApplication />);

export default App;
