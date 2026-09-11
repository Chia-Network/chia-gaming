import { useEffect, useState } from 'react';
import { handleOAuthCallbackPage } from '../hooks/cloudWalletOAuth';

/**
 * Minimal handoff page for Cloud Wallet OAuth redirect.
 * Posts the authorization code to the opener and shows a short status.
 */
export default function OAuthCallback() {
  const [message, setMessage] = useState('Completing Cloud Wallet login…');
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    const result = handleOAuthCallbackPage();
    setOk(result.status === 'ok');
    setMessage(result.message);
    if (result.status === 'ok') {
      const timer = setTimeout(() => {
        try {
          window.close();
        } catch {
          // ignore
        }
      }, 400);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        fontFamily: 'system-ui, sans-serif',
        background: '#0f1419',
        color: '#e7ecf1',
      }}
    >
      <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>
          {ok === false ? 'Cloud Wallet login failed' : 'Cloud Wallet'}
        </h1>
        <p style={{ opacity: 0.85, lineHeight: 1.5 }}>{message}</p>
      </div>
    </div>
  );
}
