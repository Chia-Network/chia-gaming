import React, { cloneElement, useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import useGameSocket from "../hooks/useGameSocket";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameEndPlayer from "./GameEndPlayer";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import LobbyScreen from "./LobbyScreen";
import { useWalletConnect } from "../hooks/WalletConnectContext";
import { useRpcUi } from "../hooks/useRpcUi";
import useDebug from "../hooks/useDebug";
import { useWasmBlob } from "../hooks/useWasmBlob";
import Debug from "./Debug";
import { getGameSelection, getSearchParams } from '../util';

const Game: React.FC = () => {
  const gameSelection = getGameSelection();
  const { client, session, pairings, connect, disconnect } = useWalletConnect();
  const [command, setCommand] = useState(0);
  const { commands } = useRpcUi();
  const commandEntries = Object.entries(commands);
  const selectedCommandEntry = commandEntries[command];
  const {
    error,
    gameConnectionState,
    setState,
    isPlayerTurn,
    iStarted,
    moveNumber,
    handleMakeMove,
    playerHand,
    opponentHand,
    playerNumber,
    cardSelections,
    setCardSelections,
    outcome,
    stopPlaying
  } = useWasmBlob();

  const handleConnectWallet = () => {
    if (!client) throw new Error("WalletConnect is not initialized.");

    if (pairings.length === 1) {
      connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
      console.log("The pairing modal is not implemented.", pairings);
    } else {
      connect();
    }
  };

  const { wcInfo, setWcInfo } = useDebug();

  const setStateFromMessage = useCallback((evt: any) => {
    setState(evt.data);
  }, []);

  useEffect(function () {
    window.addEventListener("message", setStateFromMessage);

    return function () {
      window.removeEventListener("message", setStateFromMessage);
    };
  });

  // All early returns need to be after all useEffect, etc.
  const params = getSearchParams();
  if (!params.lobby && !params.iStarted) {
    fetch("/urls").then((res) => {return res.json();}).then((urls) => {
      console.log('navigate to lobby', urls);
      if (gameSelection) {
        window.location.href = `${urls.tracker}&token=${gameSelection.token}`;
      } else {
        window.location.href = urls.tracker;
      }
    });
    return (<div/>);
  }

  if (!params.iStarted) {
    return (
      <LobbyScreen />
    );
  }

  if (error) {
    return (<div>{error}</div>);
  }

  if (gameConnectionState.stateIdentifier === 'starting') {
    return <WaitingScreen stateName={gameConnectionState.stateIdentifier} messages={gameConnectionState.stateDetail}  />;
  }

  if (gameConnectionState.stateIdentifier === 'shutdown') {
    return (
      <Box p={4}>
          <Typography variant="h4" align="center">
              {`Cal Poker - shutdown succeeded`}
          </Typography>
      </Box>
    );
  }

  console.log('game outcome', outcome);
  let myWinOutcome = outcome?.my_win_outcome;
  let colors = {
    'win': 'green',
    'lose': 'red',
    'tie': '#ccc',
    'success': '#363',
    'warning': '#633',
  };
  let color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome ? myWinOutcome : isPlayerTurn ? "success" : "warning";
  const iAmAlice = playerNumber === 2;
  const myHandValue = iAmAlice ? outcome?.alice_hand_value : outcome?.bob_hand_value;
  let banner = isPlayerTurn ? "Your turn" : "Opponent's turn";
  if (myWinOutcome === 'win') {
    banner = `You win ${myHandValue}`;
  } else if (myWinOutcome === 'lose') {
    banner = `You lose ${myHandValue}`;
  } else if (myWinOutcome === 'tie') {
    banner = `Game tied ${myHandValue}`;
  }
  const moveDescription = [
    "Commit to random number",
    "Choose 4 cards to discard",
    "Finish game"
  ][moveNumber];

  if (outcome) {
    return (
      <div id='total'>
        <div id='overlay'> </div>
        <Box p={4}>
          <Typography variant="h4" align="center">
          {`Cal Poker - move ${moveNumber}`}
          </Typography>
          <br />
          <Typography
            variant="h6"
            align="center"
            color={colors[color]}
          >
            {banner}
          </Typography>
          <br />
          <Box
            display="flex"
            flexDirection={{ xs: "column", md: "row" }}
            alignItems="stretch"
            gap={2}
            mb={4}
          >
            <Box flex={1} display="flex" flexDirection="column">
              <GameEndPlayer
                iStarted={iStarted}
                playerNumber={iStarted ? 1 : 2}
                outcome={outcome}
              />
            </Box>
            <Box flex={1} display="flex" flexDirection="column">
                <GameEndPlayer
                    iStarted={iStarted}
                    playerNumber={iStarted ? 2 : 1}
                    outcome={outcome}
                />
            </Box>
          </Box>
        </Box>
      </div>
    );
  }

  return (
    <Box p={4}>
      <Typography variant="h4" align="center">
      {`Cal Poker - move ${moveNumber}`}
      </Typography>
      <Button onClick={stopPlaying} disabled={moveNumber !== 0}
      aria-label="stop-playing"
      aria-disabled={moveNumber !== 0}
      >Stop</Button>
      <br />
      <Typography
        variant="h6"
        align="center"
        color={colors[color]}
      >
        {banner}
      </Typography>
      <br />
      <Box
        display="flex"
        flexDirection={{ xs: "column", md: "row" }}
        alignItems="stretch"
        gap={2}
        mb={4}
      >
        <Box flex={1} display="flex" flexDirection="column">
          <PlayerSection
            playerNumber={playerNumber}
            playerHand={playerHand}
            isPlayerTurn={isPlayerTurn}
            moveNumber={moveNumber}
            handleMakeMove={handleMakeMove}
            cardSelections={cardSelections}
            setCardSelections={setCardSelections}
          />
        </Box>
        <Box flex={1} display="flex" flexDirection="column">
            <OpponentSection
                playerNumber={(playerNumber == 1) ? 2 : 1}
                opponentHand={opponentHand}
            />
        </Box>
      </Box>
      <br/>
      <Typography>{moveDescription}</Typography>
      <br/>
      <GameLog log={[]} />
      <Debug connectString={wcInfo} setConnectString={setWcInfo} />
      {session ? (
        <>
          <FormControl fullWidth sx={{ mt: 2 }}>
            <InputLabel id="command-select-label">Command</InputLabel>
            <Select
              labelId="command-select-label"
              id="command-select"
              value={command}
              label="Command"
              onChange={(e) => setCommand(Number(e.target.value))}
            >
              {commandEntries.map(([name], i) => (
                <MenuItem key={i} value={i}>
                  {name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Divider sx={{ mt: 4 }} />
          <Box mt={3}>
            <Typography variant="h5" mb={2}>
              <code>{selectedCommandEntry[0]}</code>
            </Typography>
            {selectedCommandEntry[1].map((element, i) =>
              cloneElement(element, { key: i })
            )}
            <ButtonGroup variant="outlined" fullWidth>
              <Button variant="outlined" color="error" onClick={() => disconnect()}>
                Unlink Wallet
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={() => {
                  localStorage.clear();
                  window.location.href = "";
                }}
              >
                Reset Storage
              </Button>
            </ButtonGroup>
          </Box>
          <Divider sx={{ mt: 4 }} />
          <Box mt={3}>
            <Typography variant="h5">Response</Typography>
            <Button
              fullWidth
              variant="outlined"
              color="error"
              onClick={() => {
                localStorage.clear();
                window.location.href = "";
              }}
            >
              Unlink Wallet
            </Button>
          </Box>
        </>
      ) : (
        <Button variant="contained" onClick={handleConnectWallet} sx={{ mt: 3 }}>
          Link Wallet
        </Button>
      )}
    </Box>
  );
};

export default Game;
