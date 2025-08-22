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
import { useWalletConnect } from "../hooks/WalletConnectContext";
import { CoinOutput } from '../types/ChiaGaming';
import { WalletBlockchainInterface, connectSimulator, connectRealBlockchain, registerBlockchainNotifier } from '../hooks/useFullNode';
import { generateOrRetrieveUniqueId } from '../util';

const WalletConnectHeading: React.FC<any> = (args: any) => {
  const { client, session, pairings, connect, disconnect } = args;
  const { wcInfo, setWcInfo } = useDebug();
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [walletId, setWalletId] = useState(1);
  const [walletIds, setWalletIds] = useState<any[]>([]);
  const [fakeAddress, setFakeAddress] = useState<string | undefined>();
  const [wantSpendable, setWantSpendable] = useState<any | undefined>(undefined);
  const [peak, setPeak] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);
  const { rpc } = useRpcUi();
  const [blockchainInterface, setBlockchainInterface] = useState<WalletBlockchainInterface | undefined>(undefined);

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
    if ((data.name === 'lobby' || data.name === 'Game Rendered') && subframe) {
      (subframe as any).contentWindow.postMessage({
        name: 'walletconnect_up',
        fakeAddress: fakeAddress
      }, '*');
    }

    if (data.method === 'create_spendable') {
      setWantSpendable(data);
      return blockchainInterface?.do_initial_spend(data.target, data.amt).then((result: any) => {
        setWantSpendable(undefined);
        console.warn('create_spendable result', result);
        (subframe as any).contentWindow.postMessage({
          name: 'blockchain_reply',
          requestId: data.requestId,
          result: result
        }, '*');
      });
    } else if (data.method === 'spend') {
      blockchainInterface?.spend(data.spendBlob, data.spend).then((result: any) => {
        (subframe as any).contentWindow.postMessage({
          name: 'blockchain_reply',
          requestId: data.requestId,
          result,
        }, '*');
      });
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

  const registerBlockchainNotifications = () => {
    registerBlockchainNotifier((peak, block, block_report) => {
      setPeak(peak);
      const subframe = document.getElementById('subframe');
      if (!subframe) {
        return;
      }

      (subframe as any).contentWindow.postMessage({
        name: 'blockchain_peak',
        peak,
        block,
        block_report
      }, '*');
    });
  };

  const handleConnectWallet = () => {
    if (!client) throw new Error("WalletConnect is not initialized.");

    if (pairings.length === 1) {
      connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
      console.log("The pairing modal is not implemented.", pairings);
    } else {
      connect();
    }

    const initialSpend = (target: string, amt: number) => {
      return getCurrentAddress().then((ca: any) => {
        console.warn('about to send transaction from', ca);
        return sendTransaction({
          walletId,
          amount: amt,
          fee: 0,
          address: target,
          waitForConfirmation: false
        });
      });
    };
    setBlockchainInterface(connectRealBlockchain(initialSpend));
    window.postMessage({ name: 'walletconnect_up' }, '*');
    registerBlockchainNotifications();
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
      let sim = connectSimulator(res);
      setBlockchainInterface(sim);
      setExpanded(false);
      registerBlockchainNotifications();
      window.postMessage({ name: 'walletconnect_up', fakeAddress: res }, '*');
      console.log('set up simulator');
    });
  };

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
          Chia Gaming - WalletConnect {sessionConnected} peak {peak}
        </div>
        <div style={{ display: 'flex', flexGrow: 1 }}> </div>
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, width: '3em', height: '3em', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={toggleExpanded} aria-label='control-menu'>☰</div>
      </div>
      {ifExpanded}
    </div>
  );
};

export default WalletConnectHeading;
