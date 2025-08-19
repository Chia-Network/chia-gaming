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
import {
  connectRealBlockchain,
  getBlockchainInterfaceSingleton
} from '../hooks/useFullNode';
import Debug from "./Debug";
// @ts-ignore
import { bech32m } from 'bech32m-chia';
import { useWalletConnect } from "../hooks/WalletConnectContext";
import { CoinOutput } from '../types/ChiaGaming';
import { generateOrRetrieveUniqueId } from '../util';

const WalletConnectHeading: React.FC<any> = (args: any) => {
  const { client, session, pairings, connect, disconnect } = args;
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

  // Everything we do is ok to retry since none actually spend.
  // We use push_tx from coinset.org for everything.
  function getWallets() {
    return callRpcWithRetry('getWallets', {includeData: true}, 1000);
  }

  function getWalletAddresses() {
    return callRpcWithRetry('getWalletAddresses', {}, 1000);
  }

  function getCurrentAddress() {
    return callRpcWithRetry('getCurrentAddress', {}, 1000);
  }

  function sendTransaction(data: any) {
    return callRpcWithRetry('sendTransaction', data, 1000);
  }

  function returnMessage(requestId: string, result: any) {
    const subframe = document.getElementById('subframe');
    if (!subframe) {
      console.error('no element named subframe');
      return;
    }
    (subframe as any).contentWindow.postMessage({
      name: 'blockchain_reply',
      requestId,
      result
    }, '*');
  }

  function receivedWindowMessageData(data: any, origin: string) {
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }

    if (data.type === 'verify_attestation') {
      console.warn('attestation?', data);
      return;
      // const attestationId = event.data
      // const origin = event.origin
      // fetch("<Verify_Server_URL>", { method: "POST", body: { attestationId, origin }})
    };

    const subframe = document.getElementById('subframe');
    if (data.name === 'lobby' && subframe) {
      (subframe as any).contentWindow.postMessage({
        name: 'walletconnect_up',
        fakeAddress: fakeAddress
      }, '*');
    }

    if (data.name !== 'blockchain') {
      return;
    }

    if (data.method === 'create_spendable') {
      setWantSpendable(data);
      getCurrentAddress().then((ca: any) => {
        console.warn('about to send transaction');
        const fromPuzzleHash = bech32m.decode(ca);
        return sendTransaction({
          walletId,
          amount: data.amt,
          fee: 0,
          address: ca.targetXch,
          waitForConfirmation: false
        }).then((tx: any) => {
          setWantSpendable(undefined);
          console.warn('create_spendable result', tx);
          if (!subframe) {
            console.error('no element named subframe');
            return;
          }
          (subframe as any).contentWindow.postMessage({
            name: 'blockchain_reply',
            requestId: data.requestId,
            result: { tx, fromPuzzleHash }
          }, '*');
        });
      });
      return;
    }
  }

  function retryCreateSpendable() {
    receivedWindowMessageData(wantSpendable, '*');
  }

  useEffect(() => {
    function receivedWindowMessage(evt: any) {
      console.log('parent window received message', evt);
      const key = evt.message ? 'message' : 'data';
      // Not decoded, despite how it's displayed in console.log.
      let data = evt[key];
      receivedWindowMessageData(data, evt.origin);
    }

    window.addEventListener("message", receivedWindowMessage);

    return function () {
      window.removeEventListener("message", receivedWindowMessage);
    };
  });

  const useHeight = expanded ? '3em' : '20em';
  const handleConnectWallet = () => {
    if (!client) throw new Error("WalletConnect is not initialized.");

    connectRealBlockchain();

    if (pairings.length === 1) {
      connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
      console.log("The pairing modal is not implemented.", pairings);
    } else {
      connect();
    }
  };

  const handleConnectSimulator = () => {
    const uniqueId = generateOrRetrieveUniqueId();
    const baseUrl = 'http://localhost:5800';

    fetch(`${baseUrl}/register?name=${uniqueId}`, {
      method: "POST"
    }).then(res => {
      return res.json();
    }).then(res => {
      // Trigger fake connect if not connected.
      console.warn('fake address is', res);
      setFakeAddress(res);
      getBlockchainInterfaceSingleton();
    });
  };

  if (!alreadyConnected && (session || args.simulatorActive)) {
    setAlreadyConnected(true);
    setExpanded(false);
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
