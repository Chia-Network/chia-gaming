import React, { useState } from 'react';
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

interface LobbyComponentProps {
  alias: string;
}

const LobbyScreen: React.FC<LobbyComponentProps> = ({ alias }) => {
  const { players, rooms, messages, sendMessage, generateRoom, joinRoom } = useLobbySocket(alias);
  const [chatInput, setChatInput] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInput] = useState('');

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
    const url = await generateRoom(gameChoice, wagerInput);
    window.prompt('Share this room URL:', url);
    closeDialog();
  };

  return (
    <Box p={4} maxWidth={600} mx="auto">
      <Typography variant="h4" gutterBottom>
        Lobby — Alias: {alias}
      </Typography>

      <Box mb={3}>
        <Typography variant="h6">Connected Players</Typography>
        <List>
          {players.map(p => (
            <ListItem key={p.id} dense>
              <ListItemText primary={p.id === alias ? `${p.id} (You)` : p.id} />
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
                primary={r.host.game}
                secondary={`Host: ${r.host.id} | Token: ${r.token}`}
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
              <strong>{m.alias}:</strong> {m.content}
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
            fullWidth
            margin="normal"
            value={gameChoice}
            onChange={e => setGameChoice(e.target.value)}
          />
          <TextField
            label="Wager (XCH)"
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