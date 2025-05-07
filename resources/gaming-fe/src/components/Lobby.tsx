import React, { useState } from 'react';
import { useLobby } from '../hooks/useLobby';
import { useWalletConnect } from '../hooks/useWalletConnect';
import { GameType, MatchmakingPreferences } from '../types/lobby';
import {
  Box,
  Button,
  Container,
  Grid,
  Paper,
  Typography,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Divider,
  IconButton
} from '@mui/material';
import { Send as SendIcon, ExitToApp as ExitIcon } from '@mui/icons-material';

const Lobby: React.FC = () => {
  const { isConnected, connect, disconnect } = useWalletConnect();
  const {
    players,
    rooms,
    currentRoom,
    error,
    joinLobby,
    leaveLobby,
    createRoom,
    joinRoom,
    leaveRoom,
    sendChatMessage
  } = useLobby();

  const [selectedGame, setSelectedGame] = useState<GameType>('california_poker');
  const [minPlayers, setMinPlayers] = useState(2);
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [chatMessage, setChatMessage] = useState('');

  const handleJoinLobby = () => {
    const preferences: MatchmakingPreferences = {
      gameType: selectedGame,
      minPlayers,
      maxPlayers
    };
    joinLobby(preferences);
  };

  const handleCreateRoom = () => {
    const preferences: MatchmakingPreferences = {
      gameType: selectedGame,
      minPlayers,
      maxPlayers
    };
    createRoom(preferences);
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentRoom && chatMessage.trim()) {
      sendChatMessage(currentRoom.id, chatMessage);
      setChatMessage('');
    }
  };

  if (!isConnected) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'grey.100'
        }}
      >
        <Typography variant="h3" component="h1" gutterBottom>
          Chia Gaming Lobby
        </Typography>
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={connect}
        >
          Connect Wallet
        </Button>
      </Box>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 4 }}>
        <Typography variant="h4" component="h1">
          Chia Gaming Lobby
        </Typography>
        <Button
          variant="contained"
          color="error"
          startIcon={<ExitIcon />}
          onClick={disconnect}
        >
          Disconnect
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Lobby Settings
            </Typography>
            <Box component="form" sx={{ mt: 2 }}>
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel>Game Type</InputLabel>
                <Select
                  value={selectedGame}
                  label="Game Type"
                  onChange={(e) => setSelectedGame(e.target.value as GameType)}
                >
                  <MenuItem value="california_poker">California Poker</MenuItem>
                  <MenuItem value="krunk">Krunk</MenuItem>
                  <MenuItem value="exotic_poker">Exotic Poker</MenuItem>
                </Select>
              </FormControl>

              <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6}>
                  <TextField
                    fullWidth
                    type="number"
                    label="Min Players"
                    value={minPlayers}
                    onChange={(e) => setMinPlayers(parseInt(e.target.value))}
                    inputProps={{ min: 2, max: 10 }}
                  />
                </Grid>
                <Grid item xs={6}>
                  <TextField
                    fullWidth
                    type="number"
                    label="Max Players"
                    value={maxPlayers}
                    onChange={(e) => setMaxPlayers(parseInt(e.target.value))}
                    inputProps={{ min: 2, max: 10 }}
                  />
                </Grid>
              </Grid>

              <Box sx={{ display: 'flex', gap: 2 }}>
                <Button
                  fullWidth
                  variant="contained"
                  color="primary"
                  onClick={handleJoinLobby}
                >
                  Join Lobby
                </Button>
                <Button
                  fullWidth
                  variant="contained"
                  color="success"
                  onClick={handleCreateRoom}
                >
                  Create Room
                </Button>
              </Box>
            </Box>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Active Rooms
            </Typography>
            <List>
              {rooms.map((room) => (
                <React.Fragment key={room.id}>
                  <ListItem
                    secondaryAction={
                      <Button
                        variant="contained"
                        color="primary"
                        onClick={() => joinRoom(room.id)}
                      >
                        Join
                      </Button>
                    }
                  >
                    <ListItemText
                      primary={room.gameType}
                      secondary={`Players: ${room.players.length}/${room.maxPlayers}`}
                    />
                  </ListItem>
                  <Divider />
                </React.Fragment>
              ))}
            </List>
          </Paper>
        </Grid>
      </Grid>

      {currentRoom && (
        <Paper sx={{ p: 3, mt: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
            <Typography variant="h6">Current Room</Typography>
            <Button
              variant="contained"
              color="error"
              onClick={() => leaveRoom(currentRoom.id)}
            >
              Leave Room
            </Button>
          </Box>

          <Grid container spacing={3}>
            <Grid item xs={12} md={4}>
              <Typography variant="subtitle1" gutterBottom>
                Players
              </Typography>
              <List>
                {currentRoom.players.map((player) => (
                  <ListItem key={player.id}>
                    <ListItemIcon>
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          bgcolor: 'success.main'
                        }}
                      />
                    </ListItemIcon>
                    <ListItemText primary={player.address} />
                  </ListItem>
                ))}
              </List>
            </Grid>

            <Grid item xs={12} md={8}>
              <Typography variant="subtitle1" gutterBottom>
                Chat
              </Typography>
              <Paper
                variant="outlined"
                sx={{
                  height: 300,
                  overflow: 'auto',
                  mb: 2,
                  p: 2
                }}
              >
                {currentRoom.chat.map((message, index) => (
                  <Box key={index} sx={{ mb: 1 }}>
                    <Typography component="span" fontWeight="bold">
                      {message.sender}:
                    </Typography>{' '}
                    <Typography component="span">{message.text}</Typography>
                  </Box>
                ))}
              </Paper>
              <Box
                component="form"
                onSubmit={handleSendChat}
                sx={{ display: 'flex', gap: 1 }}
              >
                <TextField
                  fullWidth
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder="Type a message..."
                  variant="outlined"
                  size="small"
                />
                <IconButton
                  type="submit"
                  color="primary"
                  disabled={!chatMessage.trim()}
                >
                  <SendIcon />
                </IconButton>
              </Box>
            </Grid>
          </Grid>
        </Paper>
      )}
    </Container>
  );
};

export default Lobby; 