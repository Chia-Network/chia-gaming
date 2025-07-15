import React, { cloneElement, useState, useEffect, useCallback } from "react";
import { useRpcUi } from "../hooks/useRpcUi";
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

const WalletConnectDirectInterface: React.FC = () => {
  const [command, setCommand] = useState(0);
  const { commands } = useRpcUi();
  const commandEntries = Object.entries(commands);
  const selectedCommandEntry = commandEntries[command];
  const innerElements = selectedCommandEntry[1].map((element, i) => cloneElement(element, { key: i }));
  const commandEntryItems = commandEntries.map(([name], i) => (
    <MenuItem key={i} value={i}>
      {name}
    </MenuItem>
  ));
  return (
    <>
      <FormControl fullWidth sx={{ mt: 2 }}>
        <InputLabel id="command-select-label">Command</InputLabel>
        <Select
          labelId="command-select-label"
          id="command-select"
          value={command}
          label="Command"
          onChange={(e) => setCommand(Number(e.target.value))}
        >{commandEntryItems}</Select>
      </FormControl>
      <Divider sx={{ mt: 4 }} />
      <Box mt={3}>
        <Typography variant="h5" mb={2}>
          <code>{selectedCommandEntry[0]}</code>
        </Typography>
        {innerElements}
      </Box>
    </>
  );
};
