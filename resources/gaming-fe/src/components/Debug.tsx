import React from 'react';
//import { useWalletConnect } from "../hooks/WalletConnectContext";
import { Box, Button, Typography, TextField, Paper } from '@mui/material';

interface DebugProps {
  connectString: string;
  setConnectString: (value: string) => void;
}

{
  /*
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
*/
}

//const onSetConnectString = () => { 0; }
// const setWCStringButtonHandler = () => { 0; }
const setWCStringButtonHandler = () => {};

// Rename: DebugPanel, DebugSection ...
const Debug: React.FC<DebugProps> = ({ connectString, setConnectString }) => {
  return (
    <Box mt={4}>
      <Typography variant="h5">Debug Controls:</Typography>
      <br />

      <TextField
        label="Connect String"
        type="text"
        value={connectString}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConnectString(e.target.value)}
        placeholder="e.g. wc:ffffff...."
        fullWidth
        margin="normal"
      />
      <Button variant="contained" color="primary" onClick={setWCStringButtonHandler}>
        Set WC string
      </Button>
      {/*}
      <Button
                        fullWidth
                        variant='contained'
                        onClick={onConnect}
                        sx={{ mt: 3 }}
                    >
                        Link Wallet
                    </Button>
*/}
    </Box>
  );
};

export default Debug;
