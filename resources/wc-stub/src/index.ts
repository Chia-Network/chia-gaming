// A local walletconnect stub.
// @ts-ignore
import fetch from 'node-fetch';
// @ts-ignore
import bech32 from 'bech32-buffer';
// @ts-ignore
import Client from '@walletconnect/sign-client';
import { Pair } from './util/Pair';
import useWalletConnectPreferences from './hooks/useWalletConnectPreferences';
import { defaultMetadata, WalletConnectChiaProjectId, UseWalletConnectConfig, useWalletConnectClient } from './hooks/useWalletConnectClient';
import useWalletConnect from './hooks/useWalletConnect';
import { parseWcLink } from './hooks/useWalletConnectPairs';
import { bindEvents } from './util/walletConnect';
import Daemon from './rpc/Daemon';
import express, { Application } from "express";
import { blockchainUpdate, bindBlockchain } from './coinset';

import 'fake-indexeddb/auto';

const app: Application = express();
var expressWs = require('express-ws')(app);
app.use(express.json());

const PORT: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
let client_id = 1;

// Thanks: https://stackoverflow.com/questions/34309988/byte-array-to-hex-string-conversion-in-javascript
export function toHexString(byteArray: number[]) {
  return Array.from(byteArray, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function processRequest(id: number, address: string, topic: string, command: string, params: any) {
  console.log('process', topic, command, params);
  let time = new Date().getTime();
  let result: any = {
    endpointName: 'getCurrentAddress',
    startedTimeStamp: time,
    fulfilledTimeStamp: time,
    isSuccess: true,
    isError: false,
    isLoading: false,
    isUninitialized: false,
    originalArgs: params,
    requestId: `${time}-utc`,
    status: 'fulfilled'
  };

  if (command === 'chia_getCurrentAddress') {
    result.data = address;
    return result;
  } else if (command === 'chia_sendTransaction') {
    const hexTarget = toHexString(bech32.decode(params.address).data as any);
    return fetch(`http://localhost:5800/create_spendable?who=${id}&target=${hexTarget}&amount=${params.amount}`, {
      "method": "POST"
    }).then((res: any) => res.json()).then((coin: string) => {
      result.data = { coin, fromPuzzleHash: address };
      return result;
    });
  }

  console.log('unknown rpc', command, params);
  return Promise.all([]).then(() => {});
}

function doWalletConnect(pairs: Pair[]) {
  let this_client_id = client_id++;

  fetch(`http://localhost:5800/register?name=${this_client_id}`, {
    method: "POST"
  }).then((res: any) => res.json()).then((address: any) => {
    return useWalletConnect({
      projectId: WalletConnectChiaProjectId,
      debug: true,
      metadata: defaultMetadata
    }, pairs).then(({ client, error, pair, pairs }) => {
      if (client) {
        bindEvents(client, pairs, () => {
          return (topic, command, params) => processRequest(
            this_client_id,
            address,
            topic,
            command,
            params
          );
        });
      } else {
        console.log('skipped bind events?');
      }
      return pair;
    });
  });
}

/*

  Real result object:

  data: "xch1pfd424ap35389nwyezaczal46zte7c8t4zdtg9ndjrkzupg5lpxsxddqlq"
  ​​
  endpointName: "getCurrentAddress"
  ​​
  fulfilledTimeStamp: 1755781431676
  ​​
  isError: false
  ​​
  isLoading: false
  ​​
  isSuccess: true
  ​​
  isUninitialized: false
  ​​
  originalArgs: Object { walletId: 1 }
  ​​
  requestId: "1Br6QTjPiM5LIgA4B-utc"
  ​​
  startedTimeStamp: 1755781431359
  ​​
  status: "fulfilled"

*/
function create_paired_connection(pairData: any, fingerprints: number[]) {
  const parsed = parseWcLink(pairData, fingerprints);
  const pairs: Pair[] = [];
  if (parsed) { pairs.push(parsed); }

  return doWalletConnect(pairs);
}

app.post('/pair', async (req: any, res: any) => {
  const { pairdata, fingerprints } = req.body;
  console.log('pair', pairdata, fingerprints);
  let pair = await create_paired_connection(pairdata, fingerprints);
  res.json({ pair });
});

blockchainUpdate();
bindBlockchain(app);

app.listen(PORT);
