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
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Close,
  Edit,
  SportsEsports,
  PeopleAlt,
  ContentCopy,
  WorkspacePremiumOutlined,
} from '@mui/icons-material';
import { useLobbySocket } from '../hooks/useLobbyConnection';
import { generateOrRetrieveAlias, updateAlias } from '../util';
import { Crown } from 'lucide-react';

const LobbyScreen = () => {
  const [myAlias, setMyAlias] = useState(generateOrRetrieveAlias());
  const {
    players,
    rooms,
    messages,
    sendMessage,
    setLobbyAlias,
    generateRoom,
    joinRoom,
    uniqueId,
    fragment,
    lobbyGames,
  } = useLobbySocket(myAlias, true);

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
    <Box
      sx={{
        p: { xs: 2, sm: 3, md: 8 },
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
        <Box
          sx={{
            flex: 2,
            pr: { md: 0, xs: 0 },
            height: '100%',
          }}
        >
          <Card
            variant='outlined'
            sx={{
              borderRadius: '12px 0 0 12px',
              border: 'none',
              boxShadow: 'none',
              backgroundColor: 'var(--color-canvas-bg)',
              height: '100%',
              // use available height on desktop
            }}
          >
            <CardContent sx={{ height: '100%', pb: 6 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                justifyContent='space-between'
                alignItems={{ xs: 'flex-start', sm: 'center' }}
                spacing={1}
                mb={2}
              >
                <Typography
                  variant='h6'
                  fontWeight={600}
                  sx={{ color: 'var(--color-canvas-text-contrast)' }}
                >
                  Active Rooms
                </Typography>
                <Button
                  variant='solid'
                  color={'secondary'}
                  onClick={openDialog}
                  aria-label='generate-room'
                >
                  Generate Room
                </Button>
              </Stack>

              <Divider sx={{ mb: 3 }} />
              <Box sx={{ overflowY: 'auto', height: '100%', pr: 2, pb: 6 }}>
                {rooms.length === 0 ? (
                  <Box
                    textAlign='center'
                    py={6}
                    sx={{ color: 'var(--color-canvas-text)' }}
                  >
                    <SportsEsports
                      sx={{
                        fontSize: 48,
                        mb: 1,
                        color: 'var(--color-canvas-solid)',
                      }}
                    />
                    <Typography
                      variant='h6'
                      fontWeight={500}
                      sx={{ color: 'var(--color-canvas-text-contrast)' }}
                    >
                      No Active Rooms
                    </Typography>
                    <Typography
                      variant='body2'
                      sx={{ color: 'var(--color-canvas-text)' }}
                    >
                      Create a room to start a game.
                    </Typography>
                  </Box>
                ) : (
                  rooms.map((r) => (
                    <Box
                      key={r.token}
                      sx={{
                        p: 2,
                        mb: 1.5,
                        borderRadius: 2,
                        border: '1px solid var(--color-canvas-line)',
                        backgroundColor: 'var(--color-canvas-bg)',
                        display: 'flex',
                        flexDirection: { xs: 'column', sm: 'row' },
                        justifyContent: 'space-between',
                        alignItems: { xs: 'flex-start', sm: 'center' },
                        gap: 1,
                      }}
                    >
                      <Box>
                        <Typography
                          variant='subtitle1'
                          fontWeight={600}
                          sx={{ color: 'var(--color-canvas-text-contrast)' }}
                        >
                          {r.token || 'Unknown Game'}
                        </Typography>
                        <Typography
                          variant='body2'
                          sx={{ color: 'var(--color-canvas-text)' }}
                        >
                          Host: {getPlayerAlias(r.host)}
                        </Typography>
                        <Typography
                          variant='body2'
                          sx={{ color: 'var(--color-canvas-text)' }}
                        >
                          Game: {r.game}
                        </Typography>
                      </Box>
                      <Button
                        variant='solid'
                        color={'secondary'}
                        onClick={() => joinRoom(r.token)}
                      >
                        Join
                      </Button>
                    </Box>
                  ))
                )}
              </Box>
            </CardContent>
          </Card>
        </Box>

        {/* Connected Players */}
        <Box
          ref={rightColumnRef}
          sx={{
            flex: 1,
            borderLeft: { md: '1px solid var(--color-canvas-border)' },
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            borderRadius: '0px 16px 0px 0px',
          }}
        >
          <Card
            variant='outlined'
            sx={{
              border: 'none',
              boxShadow: 'none',
              backgroundColor: 'var(--color-canvas-bg)',
              flexBasis: { md: `${splitPct}%` },
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: '0px 16px 0px 0px',
            }}
          >
            <CardContent
              sx={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <Stack
                direction='row'
                justifyContent='space-between'
                alignItems='center'
                mb={3}
              >
                <Typography
                  variant='h6'
                  fontWeight={600}
                  sx={{ color: 'var(--color-canvas-text-contrast)' }}
                >
                  Connected Players
                </Typography>
              </Stack>

              <Divider sx={{ mb: 2 }} />

              <Box sx={{ flex: 1, overflowY: 'auto', pr: 1 }}>
                {editingAlias ? (
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    mb={3}
                  >
                    <TextField
                      fullWidth
                      size='small'
                      placeholder='Enter new alias'
                      value={myAlias}
                      onChange={(e) => setMyAlias(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && commitEdit(e)}
                      onBlur={commitEdit}
                      sx={{
                        backgroundColor: 'var(--color-canvas-bg)',
                        '& .MuiInputBase-input': {
                          color: 'var(--color-canvas-text)',
                        },
                        '& .MuiFormLabel-root': {
                          color: 'var(--color-canvas-text)',
                        },
                      }}
                      inputProps={{ 'aria-label': 'alias-input' }}
                    />
                    <Button
                      variant='solid'
                      color={'secondary'}
                      onClick={commitEdit}
                      aria-label='save-alias'
                    >
                      Save
                    </Button>
                    <IconButton
                      size='small'
                      color='error'
                      onClick={() => setEditingAlias(false)}
                    >
                      <Close />
                    </IconButton>
                  </Stack>
                ) : (
                  <Stack direction='row' alignItems='center' spacing={1} mb={2}>
                    <Typography
                      variant='body1'
                      sx={{ color: 'var(--color-canvas-text)' }}
                    >
                      Alias:&nbsp;
                      <Box
                        component='strong'
                        sx={{
                          color: 'var(--color-canvas-text-contrast)',
                          fontWeight: 700,
                        }}
                      >
                        {myAlias}
                      </Box>
                    </Typography>
                    <IconButton
                      size='small'
                      onClick={() => setEditingAlias(true)}
                      sx={{ color: 'var(--color-canvas-solid)' }}
                      aria-label='edit-alias'
                    >
                      <Edit fontSize='small' />
                    </IconButton>
                  </Stack>
                )}

                {players.length === 0 ? (
                  <Box
                    textAlign='center'
                    py={6}
                    sx={{ color: 'var(--color-canvas-text)' }}
                  >
                    <PeopleAlt
                      sx={{
                        fontSize: 48,
                        mb: 1,
                        color: 'var(--color-canvas-solid)',
                      }}
                    />
                    <Typography
                      variant='h6'
                      fontWeight={500}
                      sx={{ color: 'var(--color-canvas-text-contrast)' }}
                    >
                      No Other Players Connected
                    </Typography>
                    <Typography
                      variant='body2'
                      sx={{ color: 'var(--color-canvas-text)' }}
                    >
                      Waiting for others to join…
                    </Typography>
                  </Box>
                ) : (
                  <Box>
                    {players.map((player, index) => (
                      <Typography
                        key={player.id}
                        variant='body2'
                        sx={{ mb: 0.5, color: 'var(--color-canvas-text)' }}
                      >
                        {index + 1}:&nbsp;
                        {player.id === uniqueId ? (
                          <>
                            <Box
                              component='span'
                              sx={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 0.5,
                              }}
                            >
                              {player.alias}
                              &nbsp;(You)
                              <Crown
                                className='w-5 h-5'
                                style={{ color: 'var(--color-warning-solid)' }}
                              />
                            </Box>
                          </>
                        ) : (
                          player.alias
                        )}
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            </CardContent>
          </Card>

          {/* draggable handle (only shown on md+) */}
          <Box
            onMouseDown={(e) => {
              const el = rightColumnRef.current as any;
              if (el && typeof el._startDrag === 'function')
                el._startDrag(e.clientY);
            }}
            onTouchStart={(e) => {
              const el = rightColumnRef.current as any;
              if (el && typeof el._startDrag === 'function')
                el._startDrag(e.touches[0].clientY);
            }}
            sx={{
              height: { xs: 8, md: 8 },
              cursor: { xs: 'default', md: 'row-resize' },
              background: 'transparent',
              display: { xs: 'none', md: 'block' },
            }}
          />

          <Card
            sx={{
              border: 'none',
              boxShadow: 'none',
              backgroundColor: 'var(--color-canvas-bg)',
              flexBasis: { md: `${100 - splitPct}%` },
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: '0px 0px 12px 0',
            }}
          >
            <CardContent
              sx={{
                p: 0,
                '&:last-child': { padding: 0 },
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <Stack
                direction='row'
                alignItems='center'
                justifyContent='space-between'
                px={2}
                py={1.5}
                borderBottom='1px solid var(--color-canvas-line)'
              >
                <Typography
                  variant='subtitle1'
                  fontWeight={600}
                  sx={{ color: 'var(--color-canvas-text-contrast)' }}
                >
                  Lobby Chat
                </Typography>
              </Stack>
              <Divider sx={{ mb: 0 }} />

              {/* Chat Messages */}
              <Box ref={messagesRef} sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
                {messages.length === 0 ? (
                  <Typography
                    sx={{
                      color: 'var(--color-canvas-text)',
                      textAlign: 'center',
                    }}
                  >
                    No messages yet.
                  </Typography>
                ) : (
                  messages.map((m, i) => (
                    <Typography
                      key={i}
                      variant='body2'
                      sx={{ mb: 0.5, color: 'var(--color-canvas-text)' }}
                    >
                      <strong>{m.alias}:</strong> {m.content.text}
                    </Typography>
                  ))
                )}
              </Box>

              <Divider />
              {/* Keep the input visible: sticky at the bottom of the card */}
              <Box
                sx={{
                  p: 1.5,
                  position: 'sticky',
                  bottom: 0,
                  bgcolor: 'var(--color-canvas-bg)',
                  borderTop: '1px solid var(--color-canvas-line)',
                  zIndex: 2,
                }}
              >
                <TextField
                  fullWidth
                  size='small'
                  placeholder='Type your message...'
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  sx={{
                    backgroundColor: 'var(--color-canvas-bg)',
                    '& .MuiInputBase-input': {
                      color: 'var(--color-canvas-text)',
                    },
                    '& .MuiFormLabel-root': {
                      color: 'var(--color-canvas-text)',
                    },
                  }}
                  inputProps={{ 'aria-label': 'lobby-chat-input' }}
                />
              </Box>
              <Divider />
            </CardContent>
          </Card>
        </Box>
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
          Create a Room
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
              <MenuItem value={g.game}>{g.game}</MenuItem>
            ))}
          </Select>

          {wagerValidationError && (
            <Box mb={1} sx={{ color: 'var(--secondary-solid)' }}>
              {wagerValidationError}
            </Box>
          )}

          <TextField
            label='Wager (mojo)'
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
