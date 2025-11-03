import React from 'react';
import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { v4 as uuidv4 } from 'uuid';

import { useLobbySocket } from 'chia-gaming-lobby-connection';

import { getFragmentParams, getSearchParams } from './util';

export function generateOrRetrieveAlias(): string {
  let previousName = localStorage.getItem('alias');
  if (previousName) {
    return previousName;
  }

  previousName = `newUser${uuidv4()}`;
  updateAlias(previousName);
  return previousName;
}

export function updateAlias(alias: string) {
  localStorage.setItem('alias', alias);
}

interface LobbyComponentProps {}

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
  } = useLobbySocket(
    React,
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
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInputPrimitive] = useState('');
  const [wagerValidationError, setWagerValidationError] = useState('');
  const [perHandInput, setPerHandInput] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);
  const [gotoUrl, setGotoUrl] = useState('');

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
    setGotoUrl(secureUrl);
    window.prompt('Share this room URL:', secureUrl);
    closeDialog();
  };

  useEffect(() => {
    console.log('check fragment', fragment);
    if (fragment.token) {
      console.log('joining channel', fragment);
      joinRoom(fragment.token);
    }
  });

  function commitEdit(e: any) {
    console.log('commit edit', e.target.value);
    setEditingAlias(false);
    updateAlias(e.target.value);
    setLobbyAlias(uniqueId, e.target.value);
  }

  function getPlayerAlias(id: string): string {
    const index = players.findIndex((p) => p.id === id);
    if (index === -1) {
      return `unknown player id: ${id}`;
    }
    return players[index].alias;
  }

  let aliasDisplay;
  if (editingAlias) {
    aliasDisplay = (
      <TextField
        fullWidth
        placeholder='Display name'
        value={myAlias}
        onChange={(e) => setMyAlias(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commitEdit(e)}
        onBlur={commitEdit}
      />
    );
  } else {
    aliasDisplay = <span onClick={() => setEditingAlias(true)}>{myAlias}</span>;
  }

  return (
    <Box p={4} maxWidth={600} mx='auto'>
      <Typography variant='h4' gutterBottom>
        Lobby — Alias: {aliasDisplay}
      </Typography>
      <div
        style={{ position: 'relative', width: '0', height: '0', opacity: '0' }}
        aria-label='partner-target-url'
      >
        {gotoUrl}
      </div>

      <Box mb={3}>
        <Typography variant='h6'>Connected Players</Typography>
        <List>
          {players.map((p) => (
            <ListItem key={p.id} dense>
              <ListItemText
                primary={p.id === uniqueId ? `${p.alias} (You)` : p.alias}
              />
            </ListItem>
          ))}
        </List>
      </Box>

      <Box mb={3}>
        <Typography variant='h6'>Active Rooms</Typography>
        <List>
          {rooms.map((r) => (
            <ListItem
              key={r.token}
              dense
              secondaryAction={
                <Button size='small' onClick={() => joinRoom(r.token)}>
                  Join
                </Button>
              }
            >
              <ListItemText
                primary={r.token}
                secondary={`Host: ${getPlayerAlias(r.host)} | Token: ${r.token}`}
              />
            </ListItem>
          ))}
        </List>
      </Box>

      <Box mb={3}>
        <Typography variant='h6'>Chat</Typography>
        <Box mb={1} height={200} overflow='auto' border='1px solid #ccc' p={1}>
          {messages.map((m, i) => (
            <Typography key={i} variant='body2'>
              <strong>{m.alias}:</strong> <span>{m.content.text}</span>
            </Typography>
          ))}
        </Box>
        <Box display='flex'>
          <TextField
            fullWidth
            placeholder='Type a message'
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <Button onClick={handleSend} variant='contained' sx={{ ml: 1 }}>
            Send
          </Button>
        </Box>
      </Box>

      <Box display='flex' justifyContent='space-between'>
        <Button
          variant='outlined'
          onClick={openDialog}
          aria-label='generate-room'
        >
          Generate Room
        </Button>
      </Box>

      <Dialog open={dialogOpen} onClose={closeDialog}>
        <DialogTitle>Create a Room</DialogTitle>
        <DialogContent>
          <TextField
            label='Game'
            aria-label='game-id'
            fullWidth
            margin='normal'
            value={gameChoice}
            onChange={(e) => setGameChoice(e.target.value)}
          />
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
          <Button onClick={closeDialog}>Cancel</Button>
          <Button onClick={handleCreate} variant='contained'>
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default LobbyScreen;
