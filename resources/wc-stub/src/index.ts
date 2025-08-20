// A local walletconnect stub.
// @ts-ignore
import Client from '@walletconnect/sign-client';
import { Pair } from './util/Pair';
import useWalletConnectPreferences from './hooks/useWalletConnectPreferences';
import { defaultMetadata, WalletConnectChiaProjectId, UseWalletConnectConfig, useWalletConnectClient } from './hooks/useWalletConnectClient';
import useWalletConnect from './hooks/useWalletConnect';
import { parseWcLink } from './hooks/useWalletConnectPairs';
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

useWalletConnect({
  projectId: WalletConnectChiaProjectId,
  debug: true,
  metadata: defaultMetadata
}, pairs).then(({ client, error, pair, pairs }) => {
  console.log('useWalletConnectClient', client, error, pair, pairs);
});
