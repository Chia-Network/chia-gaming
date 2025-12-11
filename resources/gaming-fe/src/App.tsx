import { useEffect, useState } from 'react';

import Gallery from './components/Gallery';
import Game from './components/Game';
import WalletConnectHeading from './components/WalletConnectHeading';
import { blockchainDataEmitter } from './hooks/BlockchainInfo';
import { getSaveList, loadSave } from './hooks/save';
import { getGameSelection, getSearchParams, generateOrRetrieveUniqueId } from './util';

const App = () => {
  const uniqueId = generateOrRetrieveUniqueId();
  const gameSelection = getGameSelection();
  const params = getSearchParams();
  let useParams = params;
  let useIframeUrl = 'about:blank';
  // const saveList = getSaveList();
  const saveList: string[] = []; // Disable save / reload
  const shouldRedirectToLobby = saveList.length == 0 && !params.lobby && !params.iStarted;
  if (saveList.length > 0) {
    const decodedSave = loadSave(saveList[0]);
    useParams = decodedSave.searchParams;
    useIframeUrl = decodedSave.url;
  }
  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState(useIframeUrl);
  const [fetchedUrls, setFetchedUrls] = useState(false);
  const [iframeAllowed, setIframeAllowed] = useState('');

  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (_peak: any) => {
        setHavePeak(true);
      },
    });

    return () => subscription.unsubscribe();
  });

  // Fetch the urls document and get the tracker url so we know to allow the iframe
  // to use the clipboard.
  useEffect(() => {
    if (!fetchedUrls) {
      setFetchedUrls(true);
      fetch('/urls')
        .then((res) => res.json())
	.then((urls) => {
	  let trackerURL = new URL(urls.tracker);
	  setIframeAllowed(trackerURL.origin);
        });
    }
  }, [fetchedUrls]);

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
              `${urls.tracker}&uniqueId=${uniqueId}&token=${gameSelection.token}&view=game`,
            );
          } else {
            setIframeUrl(`${urls.tracker}&view=game&uniqueId=${uniqueId}`);
          }
        });
    }
  }, [params]);

  // Keep iframe in sync with the parent theme (CSS variables and dark class).
  // If the iframe is same-origin we copy the CSS custom properties and `dark` class
  // into the iframe's root. If cross-origin, we post a message the iframe can
  // listen for and apply itself.
  useEffect(() => {
    let observer: MutationObserver | null = null;

    function buildVarsPayload() {
      const styles = getComputedStyle(document.documentElement);
      const vars: Record<string, string> = {};
      for (let i = 0; i < styles.length; i++) {
        const name = styles[i];
        if (name && name.startsWith('--')) {
          vars[name] = styles.getPropertyValue(name).trim();
        }
      }
      return vars;
    }

    async function syncThemeToIframe() {
      const iframe = document.getElementById('subframe') as HTMLIFrameElement | null;
      if (!iframe) return;

      const payload = buildVarsPayload();
      const isDark = document.documentElement.classList.contains('dark');

      try {
        // Try same-origin access
        const doc = iframe.contentDocument;
        if (doc && doc.documentElement) {
          const targetRoot = doc.documentElement;
          // copy variables
          Object.keys(payload).forEach((k) => {
            targetRoot.style.setProperty(k, payload[k]);
          });
          // copy dark class
          if (isDark) targetRoot.classList.add('dark');
          else targetRoot.classList.remove('dark');
          return;
        }
      } catch (e) {
        // Access denied -> cross-origin, fall back to postMessage
      }

      // Cross-origin fallback: send theme data via postMessage
      try {
        iframe.contentWindow?.postMessage({ type: 'theme-sync', vars: payload, dark: isDark }, '*');
      } catch (e) {
        // ignore
      }
    }

    // Run on iframe load
    function onLoad() {
      syncThemeToIframe();
    }

    const iframeEl = document.getElementById('subframe') as HTMLIFrameElement | null;
    iframeEl?.addEventListener('load', onLoad);

    // Respond to explicit requests from iframes that may have attached their
    // message listener after the parent's initial postMessage. When an iframe
    // posts {type: 'theme-request'}, send the current theme to it.
    function messageHandler(ev: MessageEvent) {
      try {
        if (ev.data && ev.data.type === 'theme-request') {
          // Only respond to requests coming from the iframe we care about.
          // If there are multiple iframes, more checks may be needed.
          syncThemeToIframe();
        }
      } catch (e) {
        // ignore
      }
    }
    window.addEventListener('message', messageHandler);

    // Observe changes to the root class (for dark mode toggles) and resync
    observer = new MutationObserver(() => {
      syncThemeToIframe();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // initial sync (in case iframe already loaded)
    setTimeout(syncThemeToIframe, 150);

    return () => {
      iframeEl?.removeEventListener('load', onLoad);
      window.removeEventListener('message', messageHandler);
      if (observer) observer.disconnect();
    };
  }, [iframeUrl]);

  if (params.gallery) {
    return <Gallery />;
  }

  if (params.game && !params.join) {
    return <Game params={params}/>;
  }

  const wcHeading = (
    <div className="flex shrink-0 h-12 w-full">
      <WalletConnectHeading />
    </div>
  );

const pre_lobby_status = (
  <div
    /*className="flex flex-col relative w-screen h-screen"*/
    className="w-full flex-1 border-0 m-0 p-0"
    style={{
        backgroundColor: 'var(--color-canvas-bg-subtle)',
        display: 'flex',          // Enables flexbox
        alignItems: 'center',     // Centers children vertically
        justifyContent: 'center', // Optional: centers children horizontally as well
        height: '100vh',          // Optional: ensures the container takes up the full viewport height
      }}
  >
  Waiting for peak from coinset.org ...
  </div>
);

  if (!havePeak) {
    return (
      <div className="flex flex-col relative w-screen h-screen" style={{ backgroundColor: 'var(--color-canvas-bg-subtle)' }}>
        {wcHeading}
        {pre_lobby_status}
      </div>
    );
  }

  return (
    <div className="flex flex-col relative w-screen h-screen" style={{ backgroundColor: 'var(--color-canvas-bg-subtle)' }}>
      {wcHeading}
      <iframe
        id='subframe'
        className="w-full flex-1 border-0 m-0 p-0"
        src={iframeUrl}
	allow={`clipboard-write self ${iframeAllowed}`}
      ></iframe>
    </div>
  );
};

export default App;
