import {
  Box,
  Button,
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
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ChatBubbleOutline,
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
        bgcolor: '#f5f6f8',
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
          <Typography variant='h5' fontWeight={700}>
            Game Lobby
          </Typography>
        </Box>
        <Button
          variant='outlined'
          fullWidth={false}
          sx={{
            backgroundColor: '#fff',
            borderColor: '#424F6D',
            color: '#424F6D',
            fontWeight: 600,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            borderRadius: '6px',
            padding: '8px 20px',
            boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
            '&:hover': {
              bgcolor: '#EBECEE',
              boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.45)',
            },
          }}
        >
          CHANGE WALLETCONNECT CONNECTION
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
          border: { md: '1px solid #d1d5db' },
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
              borderRadius: 3,
              border: 'none',
              boxShadow: 'none',
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
                <Typography variant='h6' fontWeight={600}>
                  Active Rooms
                </Typography>
                <Button
                  variant='contained'
                  onClick={openDialog}
                  aria-label='generate-room'
                  sx={{
                    width: { xs: '100%', sm: 'auto' },
                    backgroundColor: '#424F6D',
                    color: '#fff',
                    fontWeight: 600,
                    letterSpacing: '0.5px',
                    textTransform: 'uppercase',
                    borderRadius: '6px',
                    padding: '8px 20px',
                    boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                    '&:hover': {
                      backgroundColor: '#3A4663',
                      boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.45)',
                    },
                  }}
                >
                  Generate Room
                </Button>
              </Stack>

              <Divider sx={{ mb: 3 }} />
              <Box sx={{ overflowY: 'auto', height: '100%', pr: 2, pb: 6 }}>
                {rooms.length === 0 ? (
                  <Box textAlign='center' py={6} color='text.secondary'>
                    <SportsEsports
                      sx={{ fontSize: 48, mb: 1, color: 'action.active' }}
                    />
                    <Typography variant='h6' fontWeight={500}>
                      No Active Rooms
                    </Typography>
                    <Typography variant='body2'>
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
                        border: '1px solid #e0e0e0',
                        display: 'flex',
                        flexDirection: { xs: 'column', sm: 'row' },
                        justifyContent: 'space-between',
                        alignItems: { xs: 'flex-start', sm: 'center' },
                        gap: 1,
                      }}
                    >
                      <Box>
                        <Typography variant='subtitle1' fontWeight={600}>
                          {r.token || 'Unknown Game'}
                        </Typography>
                        <Typography variant='body2' color='text.secondary'>
                          Host: {getPlayerAlias(r.host)}
                        </Typography>
                        <Typography variant='body2' color='text.secondary'>
                          Game: {r.game}
                        </Typography>
                      </Box>
                      <Button
                        size='small'
                        variant='outlined'
                        onClick={() => joinRoom(r.token)}
                        sx={{
                          alignSelf: { xs: 'flex-end', sm: 'center' },
                          backgroundColor: '#424F6D',
                          color: '#fff',
                          boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                          '&:hover': {
                            backgroundColor: '#3A4663',
                            boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.45)',
                          },
                        }}
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
            borderLeft: { md: '1px solid #d1d5db' },
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          <Card
            variant='outlined'
            sx={{
              borderRadius: 0,
              border: 'none',
              boxShadow: 'none',
              flexBasis: { md: `${splitPct}%` },
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
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
                <Typography variant='h6' fontWeight={600}>
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
                    />
                    <Button
                      variant='contained'
                      onClick={commitEdit}
                      aria-label='save-alias'
                      sx={{
                        backgroundColor: '#424F6D',
                        color: '#fff',
                        fontWeight: 600,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                        borderRadius: '6px',
                        padding: '8px 20px',
                        boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.25)',
                        '&:hover': {
                          backgroundColor: '#3A4663',
                          boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                        },
                      }}
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
                    <Typography variant='body1'>
                      Alias: <strong>{myAlias}</strong>
                    </Typography>
                    <IconButton
                      size='small'
                      onClick={() => setEditingAlias(true)}
                    >
                      <Edit fontSize='small' />
                    </IconButton>
                  </Stack>
                )}

                {players.length === 0 ? (
                  <Box textAlign='center' py={6} color='text.secondary'>
                    <PeopleAlt
                      sx={{ fontSize: 48, mb: 1, color: 'action.active' }}
                    />
                    <Typography variant='h6' fontWeight={500}>
                      No Other Players Connected
                    </Typography>
                    <Typography variant='body2'>
                      Waiting for others to join…
                    </Typography>
                  </Box>
                ) : (
                  <Box>
                    {players.map((player, index) => (
                      <Typography key={player.id} variant='body2' mb={0.5}>
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
                              <Crown className='w-5 h-5 text-yellow-500' />
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
              borderRadius: 0,
              border: 'none',
              boxShadow: 'none',
              flexBasis: { md: `${100 - splitPct}%` },
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
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
                borderBottom='1px solid #e0e0e0'
              >
                <Typography variant='subtitle1' fontWeight={600}>
                  Lobby Chat
                </Typography>
              </Stack>
              <Divider sx={{ mb: 0 }} />

              {/* Chat Messages */}
              <Box ref={messagesRef} sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
                {messages.length === 0 ? (
                  <Typography color='text.secondary' textAlign='center'>
                    No messages yet.
                  </Typography>
                ) : (
                  messages.map((m, i) => (
                    <Typography key={i} variant='body2' sx={{ mb: 0.5 }}>
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
                  bgcolor: 'background.paper',
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
                />
              </Box>
              <Divider />
            </CardContent>
          </Card>
        </Box>
      </Box>

      {/* Create Room Dialog */}
      <Dialog open={dialogOpen} onClose={closeDialog}>
        <DialogTitle>Create a Room</DialogTitle>
        <DialogContent>
          <Select
            label='Game'
            aria-label='game-id'
            fullWidth
            sx={{ color: '#555555' }}
            value={gameChoice}
            onChange={(e) => setGameChoice(e.target.value)}
          >
            {lobbyGames.map((g) => {
              return (
                <MenuItem aria-label={`choose-${g.game}`} value={g.game}>
                  {g.game}
                </MenuItem>
              );
            })}
          </Select>
          {wagerValidationError ? (
            <Box mb={1}>{wagerValidationError}</Box>
          ) : (
            <div></div>
          )}
          <TextField
            label='Wager (mojo)'
            aria-label='game-wager'
            fullWidth
            type='number'
            margin='normal'
            value={wagerInput}
            onChange={(e) => setWagerInput(e.target.value)}
          />
          <TextField
            label='Each hand (mojo)'
            aria-label='per-hand'
            fullWidth
            type='number'
            margin='normal'
            value={perHandInput}
            onChange={(e) => setPerHandInput(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button sx={{ color: '#424F6D' }} onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            sx={{
              backgroundColor: '#424F6D',
              color: '#fff',
              fontWeight: 600,
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              borderRadius: '6px',
              padding: '8px 20px',
              boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.25)',
              '&:hover': {
                backgroundColor: '#3A4663',
                boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
              },
            }}
            onClick={handleCreate}
            variant='contained'
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={urlDialogOpen}
        onClose={handleCancelShare}
        maxWidth='xs'
        fullWidth
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
            <Close />
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
              bgcolor: '#f6f7fb',
              borderRadius: 1,
              p: 1.2,
              color: '#424F6D',
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
              }}
            >
              {shortenedUrl}
            </Typography>
            <IconButton
              size='small'
              onClick={handleCopyAndClose}
              sx={{
                color: '#424F6D',
                '&:hover': { color: '#3A4663' },
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
