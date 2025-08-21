// A local walletconnect stub.
// @ts-ignore
import fetch from 'node-fetch';
// @ts-ignore
import Client from '@walletconnect/sign-client';
import { Pair } from './util/Pair';
import useWalletConnectPreferences from './hooks/useWalletConnectPreferences';
import { defaultMetadata, WalletConnectChiaProjectId, UseWalletConnectConfig, useWalletConnectClient } from './hooks/useWalletConnectClient';
import useWalletConnect from './hooks/useWalletConnect';
import { parseWcLink } from './hooks/useWalletConnectPairs';
import { bindEvents } from './util/walletConnect';
import Daemon from './rpc/Daemon';

import 'fake-indexeddb/auto';

const args = process.argv;
if (args.length < 3) {
  console.warn('usage: wc-stub wc:...');
  process.exit(1);
}

const pair_data = args[2];
const fingerprints: number[] = [];
for (var i = 3; i < args.length; i++) {
  fingerprints.push(parseInt(args[i]));
}
console.log('start paired with', pair_data);
const parsed = parseWcLink(pair_data, fingerprints);
const pairs: Pair[] = [];
if (parsed) { pairs.push(parsed); }

async function pause(n: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, n);
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

useWalletConnect({
  projectId: WalletConnectChiaProjectId,
  debug: true,
  metadata: defaultMetadata
}, pairs).then(({ client, error, pair, pairs }) => {
  console.log('bind events');
  const process = (topic: string, command: string, params: any) => {
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
      return fetch('http://localhost:3002/get_current_address', {
        "method": "POST"
      }).then((res: any) => res.json()).then((address: string) => {
        result.data = address;
        return result;
      });
    } else if (command === 'chia_sendTransaction') {
      return fetch('http://localhost:3002/get_current_address', {
        "method": "POST"
      }).then((res: any) => res.json()).then((address: string) => {
        return fetch('http://localhost:3002/send_transaction?who=${address}&target=${params.address}&amount=${params.amount}', {
          "method": "POST"
        }).then((res: any) => res.json()).then((res: any) => {
          result.data = address;
          return result;
        });
      });
    }
    
    console.log('unknown rpc', command, params);
    return Promise.all([]).then(() => {});
  }

  if (client) {
    console.log('bindEvents happening');
    bindEvents(client, pairs, () => process);
  } else {
    console.log('skipped bind events?');
  }

  console.log('snooze for an hour');
  return pause(60 * 60 * 1000);
});
