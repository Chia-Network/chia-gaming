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
import { useRpcUi } from "../hooks/useRpcUi";
import useDebug from "../hooks/useDebug";
import Debug from "./Debug";
// @ts-ignore
import { bech32m } from 'bech32m-chia';
import { useWalletConnect } from "../hooks/useWalletConnect";
import { blockchainConnector } from "../hooks/BlockchainConnector";
import { CoinOutput } from '../types/ChiaGaming';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { FAKE_BLOCKCHAIN_ID, connectSimulatorBlockchain } from '../hooks/FakeBlockchainInterface';
import { REAL_BLOCKCHAIN_ID, connectRealBlockchain } from '../hooks/RealBlockchainInterface';
import { generateOrRetrieveUniqueId } from '../util';
import { BLOCKCHAIN_SERVICE_URL } from '../settings';

const WalletConnectHeading: React.FC<any> = (args: any) => {
  const { client, session, connect, disconnect } = useWalletConnect();
  const { wcInfo, setWcInfo } = useDebug();
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [walletId, setWalletId] = useState(1);
  const [walletIds, setWalletIds] = useState<any[]>([]);
  const [fakeAddress, setFakeAddress] = useState<string | undefined>();
  const [wantSpendable, setWantSpendable] = useState<any | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);
  const { rpc } = useRpcUi();

  function callRpcWithRetry(functionKey: string, data: any, timeout: number) {
    return (rpc as any)[functionKey](data).catch((e: any) => {
      console.error('retry', functionKey, data);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          callRpcWithRetry(functionKey, data, timeout).catch(reject).then(resolve);
        }, timeout);
      });
    });
  }

  useEffect(() => {
    function receivedWindowMessage(evt: any) {
      const key = evt.message ? 'message' : 'data';
      // Not decoded, despite how it's displayed in console.log.
      let data = evt[key];
      if (data.blockchain_request) {
        console.log('parent window received message', data.blockchain_request);
        if (evt.origin !== window.location.origin) {
          throw new Error(`wrong origin for parent event: ${JSON.stringify(evt)}`);
        }
        // Ensure that requests from the child frame go to our request channel.
        blockchainConnector.getOutbound().next(data.blockchain_request);
      }
    }

    window.addEventListener("message", receivedWindowMessage);

    // Ensure that replies go to the child frame.
    const bcSubscription = blockchainConnector.getInbound().subscribe({
      next: (evt: any) => {
        const subframe = document.getElementById('subframe');
        if (subframe) {
          (subframe as any).contentWindow.postMessage({
            blockchain_reply: evt
          }, window.location.origin);
        } else {
          throw new Error("blockchain reply to no subframe");
        }
      }
    });

    const biSubscription = blockchainDataEmitter.getObservable().subscribe({
      next: (evt) => {
        const subframe = document.getElementById('subframe');
        if (subframe) {
          (subframe as any).contentWindow.postMessage({
            blockchain_info: evt
          }, '*');
        } else {
          throw new Error("blockchain reply to no subframe");
        }
      }
    });

    return function () {
      window.removeEventListener("message", receivedWindowMessage);
      bcSubscription.unsubscribe();
      biSubscription.unsubscribe();
    };
  });

  const useHeight = expanded ? '3em' : '20em';
  const handleConnectWallet = () => {
    if (!client) throw new Error("WalletConnect is not initialized.");

    connect();
  };

  const uniqueId = generateOrRetrieveUniqueId();
  const handleConnectSimulator = () => {
    const baseUrl = BLOCKCHAIN_SERVICE_URL;

    setExpanded(false);
    fetch(`${baseUrl}/register?name=${uniqueId}`, {
      method: "POST"
    }).then(res => {
      return res.json();
    }).then(res => {
      // Trigger fake connect if not connected.
      console.warn('fake address is', res);
      setFakeAddress(res);
      blockchainDataEmitter.select({
        selection: FAKE_BLOCKCHAIN_ID,
        uniqueId
      });
    });
  };

  if (!alreadyConnected && session && !fakeAddress) {
    setAlreadyConnected(true);
    setExpanded(false);
    if (session) {
      console.log('doing connect real blockchain');
      blockchainDataEmitter.select({
        selection: REAL_BLOCKCHAIN_ID,
        uniqueId
      });
      connectRealBlockchain("https://api.coinset.org", rpc);
    }
  }

  const sessionConnected = session ? "connected" : fakeAddress ? "simulator" : "disconnected";
  const ifSession = session ? (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Box>
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
    </div>
  ) : fakeAddress ? (
    <Typography variant="h5" style={{ background: '#aa2' }}>Simulator {fakeAddress}</Typography>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '3em' }}>
      <Button variant="contained" onClick={handleConnectSimulator} sx={{ mt: 3 }} style={{ background: '#aa2' }}>
        Simulator
      </Button>
      <Button variant="contained" onClick={handleConnectWallet} sx={{ mt: 3 }}>
        Link Wallet
      </Button>
    </div>
  );

  const ifExpanded = expanded ? (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '17em', position: 'relative', background: 'white', padding: '1em' }}>
      {ifSession}
      <Debug connectString={wcInfo} setConnectString={setWcInfo} />
    </div>
  ) : (
    <div style={{ display: 'flex', width: '100%', height: 0 }}></div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: useHeight, width: '100vw' }}>
      <div style={{ display: 'flex', flexDirection: 'row', height: '3em' }}>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, height: '100%', padding: '1em' }}>
          Chia Gaming - WalletConnect {sessionConnected}
        </div>
        <div style={{ display: 'flex', flexGrow: 1 }}> </div>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, width: '3em', height: '3em', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={toggleExpanded} aria-label='control-menu'>☰</div>
      </div>
      {ifExpanded}
    </div>
  );
};

export default WalletConnectHeading;
