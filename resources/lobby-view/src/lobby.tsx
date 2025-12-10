import React from 'react';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Stack,
  TextField,
  Typography,
  Select,
  MenuItem,
} from '@mui/material';
import { Button } from './button';
import { Close, SportsEsports, ContentCopy } from '@mui/icons-material';
import { useLobbySocket } from 'chia-gaming-lobby-connection';
import { getSearchParams, getFragmentParams, generateOrRetrieveAlias, updateAlias } from './util';
import ConnectedPlayers from './features/lobbyComponents/ConnectedPlayers';
import CardDivider from './features/lobbyComponents/CardDivider';
import Chat from './features/lobbyComponents/Chat';
import ActiveRooms from './features/lobbyComponents/ActiveRooms';

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
  const [chatOpen, setChatOpen] = useState(false);
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

  const validateCreateSessionIsOK = () => {
    if (parseInt(wagerInput) < 100) {
      setWagerValidationError('Please buy-in with 100 mojos or more.');
      return false;
    }
    return true;
  }

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
    if (!validateCreateSessionIsOK()) return;
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
    <Box
      sx={{
        p: { xs: 2, sm: 3, md: 8 },
        pb: 0,
        minHeight: '100vh',
        bgcolor: 'var(--color-canvas-bg-subtle)',
      }}
    >
      {/* Header */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent='space-between'
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={2}
        mb={3}
      >
        <Box>
          <Typography
            variant='h5'
            fontWeight={700}
            sx={{ color: 'var(--color-canvas-text-contrast)' }}
          >
            Game Lobby
          </Typography>
        </Box>
        <Button variant='surface' color={'secondary'} fullWidth={false}>
          Change WalletConnect Connection
        </Button>
      </Stack>

      {/* Hidden automation URL */}
      <Box
        sx={{ position: 'absolute', opacity: 0 }}
        aria-label='partner-target-url'
      >
        {gotoUrl}
      </Box>

      {/* Main Content */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          border: { md: '1px solid var(--color-canvas-border)' },
          borderRadius: 3,
          gap: { xs: 3, md: 0 },
          height: { md: 'calc(100vh - 150px)', xs: 'auto' },
        }}
      >
        {/* Active Rooms */}
        <ActiveRooms
          rooms={rooms}
          openDialog={openDialog}
          joinRoom={joinRoom}
          getPlayerAlias={getPlayerAlias}
        />

        {/* Connected Players */}
        <div
          ref={rightColumnRef}
          className='flex w-full md:w-1/3 flex-col min-w-0 h-full md:border-l border-canvas-border rounded-tr-2xl'
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
      </Box>

      {/* Create Room Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        sx={{
          '& .MuiPaper-root': {
            backgroundColor: 'var(--canvas-bg)',
            color: 'var(--canvas-text)',
          },
        }}
      >
        <DialogTitle sx={{ color: 'var(--canvas-text)' }}>
          Start a Calpoker Session
        </DialogTitle>

        <DialogContent>
          <Select
            label='Game'
            aria-label='game-id'
            fullWidth
            sx={{
              backgroundColor: 'var(--canvas-bg)',
              color: 'var(--canvas-text)',
            }}
            value={gameChoice}
            onChange={(e) => setGameChoice(e.target.value)}
          >
            {lobbyGames.map((g) => (
              <MenuItem data-testid={`choose-${g.game}`} value={g.game}>{g.game}</MenuItem>
            ))}
          </Select>

          {wagerValidationError && (
            <Box mb={1} sx={{ color: '#FF6F00' }}>
              {"    " + wagerValidationError}
            </Box>
          )}

          <TextField
            label='Buy-in (minimum 100 mojos)'
            aria-label='game-wager'
            fullWidth
            type='number'
            margin='normal'
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
            sx={{
              backgroundColor: 'var(--canvas-bg)',
              '& .MuiInputBase-input::placeholder': {
                color: 'var(--canvas-text-contrast)',
                opacity: 1, // important: otherwise MUI reduces opacity
              },
              '& .MuiInputBase-input': {
                color: 'var(--canvas-text)',
              },
            }}
          />

          <TextField
            label='Each hand (mojo)'
            aria-label='per-hand'
            fullWidth
            type='number'
            margin='normal'
            value={perHandInput}
            onChange={(e) => setPerHandInput(e.target.value)}
            sx={{
              backgroundColor: 'var(--canvas-bg)',
              '& .MuiInputBase-input::placeholder': {
                color: 'var(--canvas-text-contrast)',
                opacity: 1, // important: otherwise MUI reduces opacity
              },
              '& .MuiInputBase-input': {
                color: 'var(--canvas-text)',
              },
            }}
          />
        </DialogContent>

        <DialogActions>
          <Button variant='outline' color={'secondary'} onClick={closeDialog}>
            Cancel
          </Button>

          <Button onClick={handleCreate} variant='solid' color={'secondary'}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* SHARE DIALOG */}

      <Dialog
        open={urlDialogOpen}
        onClose={handleCancelShare}
        maxWidth='xs'
        fullWidth
        sx={{
          '& .MuiPaper-root': {
            backgroundColor: 'var(--canvas-bg)',
            color: 'var(--canvas-text)',
          },
        }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            pr: 1,
          }}
        >
          Room Created 🎉
          <IconButton onClick={handleCancelShare} size='small'>
            <Close sx={{ color: 'var(--canvas-text)' }} />
          </IconButton>
        </DialogTitle>

        <DialogContent>
          <Typography variant='body1' sx={{ mb: 1 }}>
            Share this room URL:
          </Typography>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              bgcolor: 'var(--canvas-bg-subtle)',
              borderRadius: 1,
              p: 1.2,
              color: 'var(--secondary-solid)',
              fontFamily: 'monospace',
              wordBreak: 'break-all',
            }}
          >
            <Typography
              variant='body2'
              sx={{
                flexGrow: 1,
                mr: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--canvas-text)',
              }}
            >
              {shortenedUrl}
            </Typography>

            <IconButton
              size='small'
              onClick={handleCopyAndClose}
              sx={{
                color: 'var(--secondary-solid)',
                '&:hover': { color: 'var(--secondary-solid-hover)' },
              }}
            >
              <ContentCopy fontSize='small' />
            </IconButton>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
};

export default LobbyScreen;
