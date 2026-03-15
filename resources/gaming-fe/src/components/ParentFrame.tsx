import { useEffect, useState } from 'react';

import WalletConnectHeading from './WalletConnectHeading';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { BlockchainReport } from '../types/ChiaGaming';
import { getSaveList, loadSave } from '../hooks/save';
import {
  getGameSelection,
  generateOrRetrieveUniqueId,
} from '../util';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import GameRedirectPopup from './GameRedirectPopup';
import { Loader2 } from 'lucide-react';

interface ParentFrameProps {
  params: Record<string, string | undefined>;
}

const ParentFrame: React.FC<ParentFrameProps> = ({ params }) => {
  const uniqueId = generateOrRetrieveUniqueId();
  const gameSelection = getGameSelection();
  let effectiveParams = params;
  let useIframeUrl = 'about:blank';
  // const saveList = getSaveList();
  const saveList: string[] = []; // Disable save / reload
  if (saveList.length > 0) {
    const decodedSave = loadSave(saveList[0]);
    if (decodedSave) {
      effectiveParams = decodedSave.searchParams;
      useIframeUrl = decodedSave.url;
    }
  }
  const shouldRedirectToLobby =
    saveList.length == 0 && !effectiveParams.lobby && !effectiveParams.iStarted;
  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState(useIframeUrl);
  const [iframeAllowed, setIframeAllowed] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [pendingGameUrl, setPendingGameUrl] = useState<string | null>(null);

  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (_peak: BlockchainReport) => {
        setHavePeak(true);
      },
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    fetch('/urls')
      .then((res) => res.json())
      .then((urls: { tracker: string }) => {
        const trackerURL = new URL(urls.tracker);
        setIframeAllowed(trackerURL.origin);

        if (shouldRedirectToLobby) {
          const baseUrl = urls.tracker;
          const gameUrl = gameSelection
            ? `${baseUrl}&uniqueId=${uniqueId}&token=${gameSelection.token}&view=game`
            : `${baseUrl}&view=game&uniqueId=${uniqueId}`;

          if (effectiveParams.join) {
            setPendingGameUrl(gameUrl);
            setShowPopup(true);
          } else {
            setIframeUrl(gameUrl);
          }
        }
      })
      .catch(e => console.error('[ParentFrame] failed to fetch /urls:', e));
  }, []);

  useThemeSyncToIframe('subframe', [iframeUrl]);

  const handleAccept = () => {
    if (pendingGameUrl) {
      setIframeUrl(pendingGameUrl);
    }
    setShowPopup(false);
  };

  const handleCancel = () => {
    setShowPopup(false);
    window.location.href = '/?lobby=1';
  };

  const wcHeading = (
    <div className='flex shrink-0 h-12 w-full'>
      <WalletConnectHeading />
    </div>
  );

  if (!havePeak) {
    return (
      <div className='flex flex-col relative w-screen h-screen bg-canvas-bg-subtle'>
        {wcHeading}
        <div
          className='w-full flex-1 border-0 m-0 p-0 flex flex-col items-center justify-center text-center gap-3'
        >
          <Loader2 className='h-6 w-6 z-0 animate-spin text-primary mb-4' />
          Waiting for blockchain peak ...
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col relative w-screen h-screen bg-canvas-bg-subtle'>
      {wcHeading}
      <div className='relative z-0 w-full flex-1 bg-canvas-bg-subtle'>
        <iframe
          id='subframe'
          className='w-full h-full border-0 m-0 md:py-0 py-6 bg-canvas-bg-subtle'
          src={iframeUrl}
          allow={`clipboard-write self ${iframeAllowed}`}
        ></iframe>
      </div>
      <GameRedirectPopup
        open={showPopup}
        gameName={effectiveParams.game}
        message='You have been invited to join this game.'
        onAccept={handleAccept}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default ParentFrame;
