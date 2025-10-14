// A local walletconnect stub.
// @ts-ignore
import fetch from 'node-fetch';
// @ts-ignore
import * as bech32 from 'bech32-buffer';
// @ts-ignore
import Client from '@walletconnect/sign-client';
import { Pair } from './util/Pair';
import useWalletConnectPreferences from './hooks/useWalletConnectPreferences';
import {
  defaultMetadata,
  WalletConnectChiaProjectId,
  UseWalletConnectConfig,
  useWalletConnectClient,
} from './hooks/useWalletConnectClient';
import {
  UseWalletConnectResult,
  useWalletConnect,
} from './hooks/useWalletConnect';
import {
  Pairs,
  parseWcLink,
  useWalletConnectPairs,
} from './hooks/useWalletConnectPairs';
import { disconnectPair, bindEvents } from './util/walletConnect';
import Daemon from './rpc/Daemon';
import express, { Application } from 'express';
import { blockchainUpdate } from './blockchain';
import { bindBlockchain } from './coinset';
import cors from 'cors';

import 'fake-indexeddb/auto';

const app: Application = express();
var expressWs = require('express-ws')(app);
app.use(express.json());

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  }),
);
app.use(express.json());

const PORT: number = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;
let client_id = 1;
const pairs = useWalletConnectPairs();
let wc_client: UseWalletConnectResult | undefined = undefined;
let cleanupBindings: any | undefined = undefined;

// Thanks: https://stackoverflow.com/questions/34309988/byte-array-to-hex-string-conversion-in-javascript
export function toHexString(byteArray: number[]) {
  return Array.from(byteArray, function (byte) {
    return ('0' + (byte & 0xff).toString(16)).slice(-2);
  }).join('');
}

export function toUint8(s: string) {
  if (s.length % 2 != 0) {
    throw 'Odd length hex string';
  }
  const result = new Uint8Array(s.length >> 1);
  for (let i = 0; i < s.length; i += 2) {
    let sub = s.slice(i, i + 2);
    let val = parseInt(sub, 16);
    result[i >> 1] = val;
  }
  return result;
}

function processRequest(
  id: number,
  address: string,
  topic: string,
  command: string,
  params: any,
) {
  console.log('process', topic, command, params);
  let time = new Date().getTime();
  let result: any = {
    startedTimeStamp: time,
    fulfilledTimeStamp: time,
    isSuccess: true,
    isError: false,
    isLoading: false,
    isUninitialized: false,
    originalArgs: params,
    requestId: `${time}-utc`,
    status: 'fulfilled',
  };

  if (command === 'chia_getCurrentAddress') {
    result.endpointName = 'getCurrentAddress';
    return fetch(`http://localhost:5800/register?name=${topic}`, {
      method: 'POST',
    })
      .then((res: any) => res.json())
      .then((address: string) => {
        console.error(`try to encode ${address}`);
        result.data = bech32.encode('xch', toUint8(address), 'bech32m');
        return result;
      });
  } else if (command === 'chia_sendTransaction') {
    console.error(params);
    const hexTarget = toHexString(bech32.decode(params.address).data as any);
    return fetch(
      `http://localhost:5800/create_spendable?who=${topic}&target=${hexTarget}&amount=${params.amount}`,
      {
        method: 'POST',
      },
    )
      .then((res: any) => res.json())
      .then((coin: string) => {
        result.endpointName = 'sendTransaction';
        result.data = { coin, fromPuzzleHash: address };
        return result;
      });
  } else if (command === 'chia_getBalance') {
    console.error(params);
    return fetch(`http://localhost:5800/get_balance?user=${topic}`, {
      method: 'POST',
    })
      .then((res: any) => res.json())
      .then((balance: number) => {
        result.endpointName = 'getBalance';
        result.data = { confirmedWalletBalance: balance };
        return result;
      });
  }

  console.log('unknown rpc', command, params);
  return Promise.all([]).then(() => {});
}

const handlePair = async (
  client: Client,
  uri: string,
  fingerprints: number[],
  mainnet: boolean = false,
) => {
  const { topic } = await (client as any).core.pairing.pair({ uri });
  if (!topic) {
    throw new Error('Pairing failed');
  }

  return topic;
};

const handleDisconnect = (client: Client, topic: string) => {
  if (!client) {
    throw new Error('Client is not defined');
  }

  return disconnectPair(client, pairs, topic);
};

async function doWalletConnect(in_pairs: Pair[]) {
  let this_client_id = client_id++;

  console.log('doWalletConnect', pairs);
  const address = await fetch(
    `http://localhost:5800/register?name=${this_client_id}`,
    {
      method: 'POST',
    },
  ).then((res: any) => res.json());
  if (!wc_client) {
    let the_wc_client = await useWalletConnect({
      projectId: WalletConnectChiaProjectId,
      debug: true,
      metadata: defaultMetadata,
    });
    wc_client = the_wc_client;
  }

  let client = wc_client?.client;
  if (client) {
    if (cleanupBindings) {
      cleanupBindings();
    }

    for (var p = 0; p < in_pairs.length; p++) {
      pairs.addPair(in_pairs[p]);
      await handlePair(
        client,
        (in_pairs[p] as any).uri,
        in_pairs[p].fingerprints,
        in_pairs[p].mainnet,
      );
    }

    cleanupBindings = bindEvents(client, pairs, () => {
      return (topic, command, params) =>
        processRequest(this_client_id, address, topic, command, params);
    });
  }
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
  if (parsed) {
    pairs.push(parsed as Pair);
  }

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
