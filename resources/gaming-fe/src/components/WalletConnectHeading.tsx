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
import useDebug from "../hooks/useDebug";
import Debug from "./Debug";
// @ts-ignore
import { bech32m } from 'bech32m-chia';
import { walletConnectState } from "../hooks/useWalletConnect";
import { blockchainConnector } from "../hooks/BlockchainConnector";
import { CoinOutput } from '../types/ChiaGaming';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { WalletConnectDialog, doConnectWallet } from './WalletConnect';
import { FAKE_BLOCKCHAIN_ID, connectSimulatorBlockchain } from '../hooks/FakeBlockchainInterface';
import { REAL_BLOCKCHAIN_ID, connectRealBlockchain } from '../hooks/RealBlockchainInterface';
import { generateOrRetrieveUniqueId } from '../util';
import { BLOCKCHAIN_SERVICE_URL } from '../settings';

const WalletConnectHeading: React.FC<any> = (args: any) => {
  const { wcInfo, setWcInfo } = useDebug();
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [walletConnectError, setWalletConnectError] = useState<string | undefined>();
  const [fakeAddress, setFakeAddress] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [showQRModal, setShowQRModal] = useState(false);
  const [connectionUri, setConnectionUri] = useState<string | undefined>();

  // Wallet connect state.
  const [stateName, setStateName] = useState("empty");
  const [initializing, setInitializing] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [connected, setConnected] = useState(false);
  const [haveClient, setHaveClient] = useState(false);
  const [haveSession, setHaveSession] = useState(false);
  const [sessions, setSessions] = useState(0);
  const [address, setAddress] = useState();

  const walletConnectStates: any = {
    "stateName": setStateName,
    "initializing": setInitializing,
    "initialized": setInitialized,
    "connecting": setConnecting,
    "waitingApproval": setWaitingApproval,
    "connected": setConnected,
    "haveClient": setHaveClient,
    "haveSession": setHaveSession,
    "sessions": setSessions,
    "address": setAddress
  };
  useEffect(() => {
    const subscription = walletConnectState.getObservable().subscribe({
      next: (evt: any) => {
        console.log('observe walletconnect', evt);
        if (evt.stateName === 'connected') {
          setExpanded(false);
          setAlreadyConnected(true);
          console.log('doing connect real blockchain');
          blockchainDataEmitter.select({
            selection: REAL_BLOCKCHAIN_ID,
            uniqueId
          });
          connectRealBlockchain("https://api.coinset.org");
        }

        const keys = Object.keys(evt);
        keys.forEach((k: string) => {
          if (walletConnectStates[k]) {
            walletConnectStates[k](evt[k]);
          }
        });
      }
    });

    return () => subscription.unsubscribe();
  });

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);

  useEffect(() => {
    if (!initializing) {
      console.log('initialzing wallet connect if needed', initializing, initialized);
      walletConnectState.init();
      setInitializing(true);
    }
  });

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

  const useHeight = expanded ? '3em' : '50em';
  const uniqueId = generateOrRetrieveUniqueId();
  const handleConnectSimulator = useCallback(() => {
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
  }, []);

  const onDoWalletConnect = useCallback(() => {
    doConnectWallet(
      setShowQRModal,
      setConnectionUri,
      () => walletConnectState.startConnect(),
      () => {
        console.warn('walletconnect should now be connected');
      },
      (e) => setWalletConnectError(e)
    )
  }, []);

  const onWalletDismiss = useCallback(() => {
    setExpanded(false);
  }, []);

  const sessionConnected = connected ? "connected" : fakeAddress ? "simulator" : "disconnected";
  const ifSession = walletConnectState.getSession() ? (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Box>
        <ButtonGroup variant="outlined" fullWidth>
          <Button variant="outlined" color="error" onClick={() => walletConnectState.disconnect()}>
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
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      <Button variant="contained" onClick={handleConnectSimulator} sx={{ mt: 3 }} style={{ background: '#aa2' }} aria-label="select-simulator">
        Simulator
      </Button>
      <WalletConnectDialog
        initialized={initialized}
        haveClient={haveClient}
        haveSession={haveSession}
        sessions={sessions}
        showQRModal={showQRModal}
        connectionUri={connectionUri}
        onConnect={onDoWalletConnect}
        dismiss={onWalletDismiss}
      ></WalletConnectDialog>
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
