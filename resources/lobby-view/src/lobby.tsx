
import { useState, useEffect, useCallback, useRef } from 'react';
import { useLobbySocket } from 'chia-gaming-lobby-connection';
import { getSearchParams, getFragmentParams, generateOrRetrieveAlias, updateAlias } from './util';
import ConnectedPlayers from './features/lobbyComponents/ConnectedPlayers';
import CardDivider from './features/lobbyComponents/CardDivider';
import Chat from './features/lobbyComponents/Chat';
import ActiveRooms from './features/lobbyComponents/ActiveRooms';
import CreateRoomDialog from './features/lobbyComponents/CreateRoomDialog';
import ShareRoomDialog from './features/lobbyComponents/ShareRoomDialog';
import { Button } from './button';

const LobbyScreen = () => {
  const [myAlias, setMyAlias] = useState(generateOrRetrieveAlias());
  const params = getSearchParams();
  const fragment = getFragmentParams();
  const uniqueId = params.uniqueId;
  const {
    players,
    rooms,
    messages,
    sendMessage,
    setLobbyAlias,
    generateRoom,
    joinRoom,
    lobbyGames,
  } = useLobbySocket(
    window.location.origin,
    uniqueId,
    myAlias,
    true,
    params,
    fragment,
    (newUrl: string) => {
      console.warn(`from tryJoinRoom, navigate ${newUrl}`);
      window.location.href = newUrl;
    }
  );

  const [chatInput, setChatInput] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState(lobbyGames[0]?.game || '');
  const [wagerInput, setWagerInputPrimitive] = useState('');
  const [wagerValidationError, setWagerValidationError] = useState('');
  const [perHandInput, setPerHandInput] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);
  const [gotoUrl, setGotoUrl] = useState('');
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [secureUrl, setSecureUrl] = useState('');
  // UI state for split handle
  const [splitPct, setSplitPct] = useState(50); // percentage for top (Connected Players)
  const rightColumnRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // Calculate per-hand amount
  const setWagerInput = useCallback((newWagerInput: string) => {
    setWagerInputPrimitive(newWagerInput);
    try {
      const newWagerInputInteger = parseInt(newWagerInput);
      setWagerValidationError('');
      const newPerHand = Math.max(1, Math.floor(newWagerInputInteger / 10));
      setPerHandInput(newPerHand.toString());
    } catch (e: any) {
      setWagerValidationError(`${e.toString()}`);
    }
  }, []);

  const handleSend = () => {
    if (chatInput.trim()) {
      sendMessage(chatInput);
      setChatInput('');
    }
  };

  // Auto-scroll chat messages to bottom when new messages arrive
  useEffect(() => {
    if (messagesRef.current) {
      const el = messagesRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Drag handle logic for resizing the two right-column panels
  useEffect(() => {
    let dragging = false;

    const onMove = (clientY: number) => {
      if (!rightColumnRef.current) return;
      const rect = rightColumnRef.current.getBoundingClientRect();
      const rel = (clientY - rect.top) / rect.height;
      // clamp between 25% and 75% so neither panel gets too small
      const pct = Math.max(25, Math.min(75, Math.round(rel * 100)));
      setSplitPct(pct);
    };

    const mouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      onMove(e.clientY);
    };

    const touchMove = (e: TouchEvent) => {
      if (!dragging) return;
      onMove(e.touches[0].clientY);
    };

    const mouseUp = () => {
      dragging = false;
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', mouseMove);
      window.removeEventListener('touchmove', touchMove);
      window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('touchend', mouseUp);
    };

    const startDrag = (startY: number) => {
      dragging = true;
      document.body.style.userSelect = 'none';
      onMove(startY);
      window.addEventListener('mousemove', mouseMove);
      window.addEventListener('touchmove', touchMove, {
        passive: false,
      } as any);
      window.addEventListener('mouseup', mouseUp);
      window.addEventListener('touchend', mouseUp);
    };

    // expose startDrag via dataset on ref element for the handle to call
    if (rightColumnRef.current) {
      (rightColumnRef.current as any)._startDrag = startDrag;
    }

    return () => {
      window.removeEventListener('mousemove', mouseMove);
      window.removeEventListener('touchmove', touchMove as any);
      window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('touchend', mouseUp);
    };
  }, []);

  const openDialog = () => setDialogOpen(true);
  const closeDialog = () => setDialogOpen(false);

  const handleCreate = async () => {
    if (!gameChoice || !wagerInput) return;
    const { secureUrl } = await generateRoom(
      gameChoice,
      wagerInput,
      perHandInput,
    );
    setSecureUrl(secureUrl);
    setUrlDialogOpen(true);
  };

  const handleCopyAndClose = async () => {
    try {
      await navigator.clipboard.writeText(secureUrl);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
    setGotoUrl(secureUrl);
    setUrlDialogOpen(false);
    closeDialog();
  };

  const handleCancelShare = () => {
    setUrlDialogOpen(false);
    closeDialog();
  };

  useEffect(() => {
    if (fragment.token) joinRoom(fragment.token);
  }, [fragment, joinRoom]);

  function commitEdit(e: any) {
    const value = e.target.value;
    setEditingAlias(false);
    updateAlias(value);
    setLobbyAlias(uniqueId, value);
  }

  function getPlayerAlias(id: string): string {
    const player = players.find((p) => p.id === id);
    return player ? player.alias : `Unknown Player (${id})`;
  }

  useEffect(() => {
    if (lobbyGames.length > 0 && !gameChoice) {
      setGameChoice(lobbyGames[0].game);
    }
  }, [lobbyGames, gameChoice]);

  const shortenedUrl =
    secureUrl?.length > 40 ? `${secureUrl.slice(0, 40)}...` : secureUrl;

  return (
    <div className="p-4 sm:p-6 md:p-8 pb-0 min-h-screen bg-canvas-bg-subtle relative">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-3">
        <div>
          <h2 className="text-xl font-bold text-canvas-text-contrast">Game Lobby</h2>
        </div>
        <Button variant='surface' color={'secondary'} fullWidth={false}>
          Change WalletConnect Connection
        </Button>
      </div>

      {/* Hidden automation URL */}
      <div className="absolute opacity-0" aria-label="partner-target-url">
        {gotoUrl}
      </div>

      {/* Main Content */}
      <div className="flex flex-col md:flex-row border-none md:border md:border-canvas-border rounded-3xl gap-3 md:gap-0 h-auto md:h-[calc(100vh-150px)]">
        {/* Active Rooms */}
        <ActiveRooms
          rooms={rooms}
          openDialog={openDialog}
          joinRoom={joinRoom}
          getPlayerAlias={getPlayerAlias}
        />

        {/* Connected Players and Chat */}
        <div
          ref={rightColumnRef}
          className="flex flex-col w-full lg:w-1/3 min-w-0 h-full md:border-l border-canvas-border rounded-tr-2xl"
        >
          <ConnectedPlayers
            splitPct={splitPct}
            editingAlias={editingAlias}
            myAlias={myAlias}
            setMyAlias={setMyAlias}
            commitEdit={commitEdit}
            setEditingAlias={setEditingAlias}
            players={players}
            uniqueId={uniqueId}
          />

          <CardDivider rightColumnRef={rightColumnRef} />

          <Chat
            splitPct={splitPct}
            messagesRef={messagesRef}
            messages={messages}
            chatInput={chatInput}
            setChatInput={setChatInput}
            handleSend={handleSend}
          />
        </div>
      </div>

      {/* Create Room Dialog */}
      <CreateRoomDialog
        dialogOpen={dialogOpen}
        closeDialog={() => setDialogOpen(false)}
        gameChoice={gameChoice}
        setGameChoice={setGameChoice}
        lobbyGames={lobbyGames}
        wagerInput={wagerInput}
        setWagerInput={setWagerInput}
        perHandInput={perHandInput}
        setPerHandInput={setPerHandInput}
        wagerValidationError={wagerValidationError}
        handleCreate={handleCreate}
      />

      {/* Share Room Dialog */}
      <ShareRoomDialog
        urlDialogOpen={urlDialogOpen}
        handleCancelShare={handleCancelShare}
        shortenedUrl={shortenedUrl}
        handleCopyAndClose={handleCopyAndClose}
      />
    </div>

  );
};

export default LobbyScreen;
