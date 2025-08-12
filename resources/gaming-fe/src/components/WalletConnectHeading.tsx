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

const WalletConnectHeading: React.FC<any> = (args: any) => {
  const { client, session, pairings, connect, disconnect } = args;
  const { wcInfo, setWcInfo } = useDebug();
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [walletId, setWalletId] = useState(1);
  const [walletIds, setWalletIds] = useState<any[]>([]);
  const [wantSpendable, setWantSpendable] = useState<any | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);
  const { rpc } = useRpcUi();

  function getWallets() {
    return rpc.getWallets({includeData:true}).catch((e) => {
      console.error('retry getWallets', e);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          getWallets().catch(reject).then(resolve);
        }, 1000);
      });
    });
  }

  function getWalletAddresses() {
    return rpc.getWalletAddresses({}).catch((e) => {
      console.error('retry getWalletAddress', e);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          getWalletAddresses().catch(reject).then(resolve);
        }, 1000);
      });
    })
  }

  function getCurrentAddress() {
    // return rpc.getCurrentAddress({}).catch((e) => {
    //   console.error('retry getCurrentAddress', e);
    //   return new Promise((resolve, reject) => {
    //     setTimeout(() => {
    //       getCurrentAddress().catch(reject).then(resolve);
    //     }, 1000);
    //   });
    // });
    return fetch('http://localhost:3002/get_current_address', {
      method: "POST"
    }).then(res => res.json());
  }

  function sendTransaction(data: any) {
    // return rpc.sendTransaction(data).catch((e) => {
    //   console.error('retry sendTransaction', e);
    //   return new Promise((resolve, reject) => {
    //     setTimeout(() => {
    //       sendTransaction(data).catch(reject).then(resolve);
    //     }, 5000);
    //   });
    // })
    return fetch(`http://localhost:3002/send_transaction?who=${data.myAddress}&target=${data.address}&amount=${data.amount}`, {
      method: "POST"
    }).then(res => res.json());
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
    if (data.name === 'lobby') {
      (subframe as any).contentWindow.postMessage({
        name: 'walletconnect_up'
      }, '*');
    }

    if (data.name !== 'blockchain') {
      return;
    }

    if (data.method === 'create_spendable') {
      setWantSpendable(data);
      getCurrentAddress().then((ca) => {
        console.warn('currentAddress', JSON.stringify(ca));
        const targetXch = bech32m.encode(data.target, 'xch');
        const fromPuzzleHash = bech32m.decode(ca);
        console.warn('about to send transaction');
        return sendTransaction({
          walletId,
          myAddress: ca,
          amount: data.amt,
          fee: 0,
          address: targetXch,
          waitForConfirmation: false
        }).then((tx) => {
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

    if (pairings.length === 1) {
      connect({ topic: pairings[0].topic });
    } else if (pairings.length) {
      console.log("The pairing modal is not implemented.", pairings);
    } else {
      connect();
    }
  };

  if (!alreadyConnected && session) {
    setAlreadyConnected(true);
  }

  const sessionConnected = session ? "connected" : "disconnected";
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
  ) : (
    <Button variant="contained" onClick={handleConnectWallet} sx={{ mt: 3 }}>
      Link Wallet
    </Button>
  );

  const spendable = wantSpendable ? (
    <Button style={{ display: 'flex' }} onClick={retryCreateSpendable}>
      Retry create spendable
    </Button>
  ) : (<div/>);

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
        {spendable}
        <div style={{ display: 'flex', flexGrow: 0, flexShrink: 0, width: '3em', height: '3em', alignItems: 'center', justifyContent: 'center' }} onClick={toggleExpanded}>☰</div>
      </div>
      {ifExpanded}
    </div>
  );
};

export default WalletConnectHeading;
