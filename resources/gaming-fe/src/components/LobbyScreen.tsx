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
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState, useEffect, useCallback } from 'react';
import {
  ChatBubbleOutline,
  Close,
  Edit,
  SportsEsports,
  PeopleAlt,
  ContentCopy,
} from '@mui/icons-material';
import { useLobbySocket } from '../hooks/useLobbyConnection';
import { generateOrRetrieveAlias, updateAlias } from '../util';

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
  } = useLobbySocket(myAlias, true);

  const [chatInput, setChatInput] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInputPrimitive] = useState('');
  const [wagerValidationError, setWagerValidationError] = useState('');
  const [perHandInput, setPerHandInput] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);
  const [gotoUrl, setGotoUrl] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [secureUrl, setSecureUrl] = useState('');
  const gameOptions = [
    { label: 'Calpoker', value: 'calpoker' },
    // Add more games here if needed
  ];
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
          <Typography variant='body2' color='text.secondary'>
            Alias: {myAlias}
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
            boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.25)',
            '&:hover': {
              bgcolor: '#7A8398',
              boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
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
          gap: 3,
        }}
      >
        {/* Active Rooms */}
        <Box sx={{ flex: 2 }}>
          <Card variant='outlined' sx={{ borderRadius: 3 }}>
            <CardContent>
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
                    boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.25)',
                    '&:hover': {
                      backgroundColor: '#3A4663',
                      boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                    },
                  }}
                >
                  Generate Room
                </Button>
              </Stack>

              <Divider sx={{ mb: 3 }} />

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
                        {r.game || 'Unknown Game'}
                      </Typography>
                      <Typography variant='body2' color='text.secondary'>
                        Host: {getPlayerAlias(r.host)}
                      </Typography>
                      <Typography variant='body2' color='text.secondary'>
                        Token: {r.token}
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
                        boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.25)',
                        '&:hover': {
                          backgroundColor: '#3A4663',
                          boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                        },
                      }}
                    >
                      Join
                    </Button>
                  </Box>
                ))
              )}
            </CardContent>
          </Card>
        </Box>

        {/* Connected Players */}
        <Box sx={{ flex: 1 }}>
          <Card variant='outlined' sx={{ borderRadius: 3 }}>
            <CardContent>
              <Stack
                direction='row'
                justifyContent='space-between'
                alignItems='center'
                mb={2}
              >
                <Typography variant='h6' fontWeight={600}>
                  Connected Players
                </Typography>
              </Stack>

              <Divider sx={{ mb: 3 }} />

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
                players.map((player) => (
                  <Typography key={player.id} variant='body2' mb={0.5}>
                    {player.id === uniqueId
                      ? `${player.alias} (You)`
                      : player.alias}
                  </Typography>
                ))
              )}
            </CardContent>
          </Card>
        </Box>
      </Box>

      {/* Floating Chat Button */}
      <IconButton
        sx={{
          color: '#000000',
          position: 'fixed',
          bottom: 24,
          right: 64,
          bgcolor: 'white',
          boxShadow: 2,
          '&:hover': { bgcolor: '#7A8398', color: 'white' },
        }}
        onClick={() => setChatOpen(!chatOpen)}
        aria-label='open-chat'
      >
        <ChatBubbleOutline />
      </IconButton>

      {/* Chat Window */}
      {chatOpen && (
        <Card
          sx={{
            position: 'fixed',
            bottom: 80,
            right: 24,
            width: { xs: '90%', sm: 360 },
            height: 420,
            borderRadius: 3,
            boxShadow: 6,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'background.paper',
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
            <IconButton size='small' onClick={() => setChatOpen(false)}>
              <Close />
            </IconButton>
          </Stack>

          {/* Chat Messages */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
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
          <Box sx={{ p: 1.5 }}>
            <TextField
              fullWidth
              size='small'
              placeholder='Type your message...'
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            />
          </Box>
        </Card>
      )}

      {/* Create Room Dialog */}
      <Dialog open={dialogOpen} onClose={closeDialog}>
        <DialogTitle>Create a Room</DialogTitle>
        <DialogContent>
          <TextField
            select
            label='Game'
            aria-label='game-id'
            fullWidth
            margin='normal'
            value={gameChoice}
            onChange={(e) => setGameChoice(e.target.value)} // always sets lowercase value
          >
            {gameOptions.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          {wagerValidationError && (
            <Typography color='error' variant='body2'>
              {wagerValidationError}
            </Typography>
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
