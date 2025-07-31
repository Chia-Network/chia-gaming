import React, { useState, useEffect } from 'react';
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
import { useLobbySocket } from '../hooks/useLobbyConnection';
import { generateOrRetrieveAlias, updateAlias, getSearchParams } from "../util";

interface LobbyComponentProps {
  walletConnect: boolean
}

const LobbyScreen: React.FC<LobbyComponentProps> = ({ walletConnect }) => {
  const params = getSearchParams();
  const [myAlias, setMyAlias] = useState(generateOrRetrieveAlias());
  const { players, rooms, messages, sendMessage, setLobbyAlias, generateRoom, joinRoom, uniqueId, fragment } = useLobbySocket(myAlias, walletConnect);
  const [chatInput, setChatInput] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInput] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);

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
    const { secureUrl, token } = await generateRoom(gameChoice, wagerInput);
    window.prompt('Share this room URL:', secureUrl);
    closeDialog();
  };

  useEffect(() => {
    if (params.join && rooms.length != 0) {
      joinRoom(params.join);
    }
  });

  function commitEdit(e: any) {
    console.log('commit edit', e.target.value);
    setEditingAlias(false);
    updateAlias(e.target.value);
    setLobbyAlias(uniqueId, e.target.value);
  }

  function getPlayerAlias(id: string): string {
    const index = players.findIndex(p => p.id === id);
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
          placeholder="Display name"
          value={myAlias}
          onChange={e => setMyAlias(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && commitEdit(e)}
          onBlur={commitEdit}
          />
      );
  } else {
      aliasDisplay = (
        <span onClick={() => setEditingAlias(true)} >{myAlias}</span>
      );
  };

  return (
    <Box p={4} maxWidth={600} mx="auto">
      <Typography variant="h4" gutterBottom>
        Lobby — Alias: {aliasDisplay}
      </Typography>

      <Box mb={3}>
        <Typography variant="h6">Connected Players</Typography>
        <List>
          {players.map(p => (
            <ListItem key={p.id} dense>
              <ListItemText primary={p.id === uniqueId ? `${p.alias} (You)` : p.alias} />
            </ListItem>
          ))}
        </List>
      </Box>

      <Box mb={3}>
        <Typography variant="h6">Active Rooms</Typography>
        <List>
          {rooms.map(r => (
            <ListItem key={r.token} dense secondaryAction={
              <Button size="small" onClick={() => joinRoom(r.token)}>
                Join
              </Button>
            }>
              <ListItemText
                primary={r.token}
                secondary={`Host: ${getPlayerAlias(r.host)} | Token: ${r.token}`}
              />
            </ListItem>
          ))}
        </List>
      </Box>

      <Box mb={3}>
        <Typography variant="h6">Chat</Typography>
        <Box mb={1} height={200} overflow="auto" border="1px solid #ccc" p={1}>
          {messages.map((m, i) => (
            <Typography key={i} variant="body2">
              <strong>{m.alias}:</strong> <span>{m.content.text}</span>
            </Typography>
          ))}
        </Box>
        <Box display="flex">
            <TextField
                fullWidth
                placeholder="Type a message"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
          />
          <Button onClick={handleSend} variant="contained" sx={{ ml: 1 }}>
            Send
          </Button>
        </Box>
      </Box>

      <Box display="flex" justifyContent="space-between">
        <Button variant="outlined" onClick={openDialog}>
          Generate Room
        </Button>
      </Box>

      <Dialog open={dialogOpen} onClose={closeDialog}>
        <DialogTitle>Create a Room</DialogTitle>
        <DialogContent>
          <TextField
            label="Game"
            aria-label="game-id"
            fullWidth
            margin="normal"
            value={gameChoice}
            onChange={e => setGameChoice(e.target.value)}
          />
          <TextField
            label="Wager (XCH)"
            aria-label="game-wager"
            fullWidth
            type="number"
            margin="normal"
            value={wagerInput}
            onChange={e => setWagerInput(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button onClick={handleCreate} variant="contained">
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default LobbyScreen;
