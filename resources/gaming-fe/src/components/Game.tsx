import React, {cloneElement, useState} from "react";
import {  Box,   Button,
  ButtonGroup,
  Divider,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  SxProps,
  Typography, } from "@mui/material";
import useGameSocket from "../hooks/useGameSocket";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import LobbyScreen from "./LobbyScreen";
import { useWalletConnect } from "../hooks/WalletConnectContext";
import { useRpcUi } from "../hooks/useRpcUi"
//import { useWalletConnectCalls } from "../hooks/useWalletConnect";
import useDebug from "../hooks/useDebug";
import Debug from "./Debug";

// Game is the entry point
const Game: React.FC = () => {


  const {client, session, pairings, connect, disconnect } = useWalletConnect();

  const [command, setCommand] = useState(0);
  const { commands, responseData } = useRpcUi();

  const commandEntry = Object.entries(commands)[command];
  {
    console.log("WC", client, session, pairings, connect, disconnect);
  }
  const onConnect = () => {
    if (!client) throw new Error('WalletConnect is not initialized.');

    if (pairings.length === 1) {
        connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
        console.log('The pairing modal is not implemented.', pairings);
    } else {
        connect();
    }
  };

  // const onDisconnect = () => { 0; }

  const {
    gameState,
    wagerAmount,
    setWagerAmount,
    opponentWager,
    log,
    playerHand,
    opponentHand,
    playerCoins,
    opponentCoins,
    isPlayerTurn,
    playerNumber,
    handleFindOpponent,
    handleBet,
    handleMakeMove,
    handleEndTurn,
  } = useGameSocket();

  const {
    wcInfo, setWcInfo,
  } = useDebug();

  if (gameState === "idle") {
    return (
      <LobbyScreen
        wagerAmount={wagerAmount}
        setWagerAmount={setWagerAmount}
        handleFindOpponent={handleFindOpponent}
      />
    );
  } else if (gameState === "searching") {
    return <WaitingScreen />;
  } else if (gameState === "playing") {
    return (
      <Box p={4}>
        <Typography variant="h4" align="center">
          Cal Poker
        </Typography>
        <br />
        <Typography
          variant="h6"
          align="center"
          color={isPlayerTurn ? "success" : "warning"}
        >
          {isPlayerTurn ? "Your turn" : "Opponent's turn"}
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
              playerCoins={playerCoins}
              wagerAmount={wagerAmount}
              playerHand={playerHand}
              isPlayerTurn={isPlayerTurn}
              handleBet={handleBet}
              handleMakeMove={handleMakeMove}
              handleEndTurn={handleEndTurn}
            />
          </Box>
          <Box flex={1} display="flex" flexDirection="column">
            <OpponentSection
              playerNumber={playerNumber}
              opponentCoins={opponentCoins}
              opponentWager={opponentWager}
              opponentHand={opponentHand}
            />
          </Box>
        </Box>
        <GameLog log={log} />
        <Debug connectString={wcInfo} setConnectString={setWcInfo}/>
        <Typography variant="h4" align="center">
          WC Client state: {/*JSON.stringify(Object.keys(client ? client : {}))*/}
          {/* client.protocol version name metadata context */}
          { !client ? "nil" : JSON.stringify(client.context)}
        </Typography>
        {session ?
        <>
        <FormControl fullWidth sx={{ mt: 2 }}>
            <InputLabel id='command-select-label'>
                Command
            </InputLabel>
            <Select
                labelId='command-select-label'
                id='command-select-label'
                value={command}
                label='Command'
                onChange={(e) =>
                    setCommand(e.target.value as number)
                }
            >
                {Object.keys(commands).map((name, i) => (
                    <MenuItem key={i} value={i}>
                        {name}
                    </MenuItem>
                ))}
            </Select>
        </FormControl>

        <Divider sx={{ mt: 4 }} />

        <Box  mt={3}>
            <Typography variant='h5' mb={2}>
                <code>{commandEntry[0]}</code>
            </Typography>

            {commandEntry[1].map((element, i) =>
                cloneElement(element, { key: i })
            )}

            <ButtonGroup variant='outlined'>
                <Button
                    fullWidth
                    variant='outlined'
                    color='error'
                    onClick={() => disconnect()}
                >
                    Unlink Wallet
                </Button>

                <Button
                    fullWidth
                    variant='outlined'
                    color='error'
                    onClick={() => {
                        localStorage.clear();
                        window.location.href = '';
                    }}
                >
                    Reset Storage
                </Button>
            </ButtonGroup>
        </Box>

        <Divider sx={{ mt: 4 }} />

        <Box  mt={3}>
            <Typography variant='h5'>Response</Typography>



                            <Button
                            fullWidth
                            variant='outlined'
                            color='error'
                            onClick={() => {
                                localStorage.clear();
                                window.location.href = '';
                            }}
                        >
                            Unlink Wallet
                        </Button>
                        </Box>
                        </>
 :

        <Button
                        variant='contained'
                        onClick={onConnect}
                        sx={{ mt: 3 }}
                    >
                        Link Wallet
                    </Button>
  }
      </Box>
    );
  }

  return null;
};

export default Game;

