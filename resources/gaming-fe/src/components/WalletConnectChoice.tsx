import React, { useCallback, useState, useEffect } from 'react';
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

export interface WalletConnectChoiceProps {
  walletId: number,
  setWalletId: (to: number) => void,
  walletIds: any[],
  fingerprint: number,
  setFingerprint: (to: number) => void,
  fingerprints: any[],
}

export const WalletConnectChoice: React.FC<WalletConnectChoiceProps> = ({ walletId, setWalletId, walletIds, fingerprint, setFingerprint, fingerprints }) => {
  const fingerprintCallbacks = Object.keys(fingerprints).map((f) => {
    return {
      fingerprint: f,
      cb: () => setFingerprint(f)
    };
  });
  const walletCallbacks = walletIds.map((w) => {
    return {
      name: w.name,
      cb: () => setWalletId(w.id)
    };
  });
  const walletSelections = [
    <Typography>Fingerprints</Typography>
  ];
  fingerprintCallbacks.forEach((f) => {
    let color = (fingerprint == f.fingerprint) ? '#93e' : '#fff';
    walletSelections.push(
      <div style={{ display: 'flex', flexDirection: 'row', background: color }}>
        <Typography>{f.fingerprint}</Typography>
        <Button disabled={fingerprint == f.fingerprint} onClick={f.cb}>Select</Button>
      </div>
    );
  });
  if (walletCallbacks.length > 0) {
    walletSelections.push(
      <Typography>Wallet IDs</Typography>
    );
  }
  walletCallbacks.forEach((w) => {
    let color = (walletId == w.id) ? '#93e' : '#fff';
    walletSelections.push(
      <div style={{ display: 'flex', flexDirection: 'row', background: color }}>
        <Typography>{w.id} - {w.name}</Typography>
        <Button disabled={w.id == walletId} onClick={w.cb}>Select</Button>
      </div>
    );
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '6em', width: '100%', overflowY: 'hidden', scrollY: 'auto' }}>
      {walletList}
    </div>
  );
}
