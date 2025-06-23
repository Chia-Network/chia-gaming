import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, useInterval } from '../util';
import { v4 as uuidv4 } from 'uuid';

export function useWasmBlob() {
  const fetchUrl = process.env.REACT_APP_WASM_URL || 'http://localhost:3001/chia_gaming_wasm_bg.wasm';
  const BLOCKCHAIN_SERVICE_URL = process.env.REACT_APP_BLOCKCHAIN_SERVICE_URL || 'http://localhost:5800';

  const presetFiles = [
    "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex",
    "clsp/unroll/unroll_meta_puzzle.hex",
    "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
    "clsp/referee/onchain/referee.hex",
    "clsp/referee/onchain/referee-v1.hex"
  ];
  const [wasmConnection, setWasmConnection] = useState<WasmConnection | undefined>(undefined);
  const { sendMessage, incomingMessages, setIncomingMessages } = useGameSocket();
  const [cradleId, setCradleId] = useState<number | undefined>(undefined);
  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
  const [uniqueWalletConnectionId, setUniqueWalletConnectionId] = useState(uuidv4());
  const [gameStartCoin, setGameStartCoin] = useState<string | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] = useState<GameConnectionState>({ stateIdentifier: "starting", stateDetail: ["before handshake"] });
  const [game, setGame] = useState<ChiaGame | undefined>(undefined);

  const searchParams = getSearchParams();
  const token = searchParams.token;
  const uniqueId = searchParams.uniqueId;
  const iStarted = searchParams.iStarted !== 'false';
  const amount = parseInt(searchParams.amount);
  const rngSeed = uniqueId ? uniqueId.substr(0, 8) : '00';

  function loadPresets() {
    const presetFetches = presetFiles.map((partialUrl) => {
      return fetch(partialUrl).then((fetched) => fetched.text()).then((text) => {
        return {
          name: partialUrl,
          content: text
        };
      });
    });
    return Promise.all(presetFetches);
  };

  function loadWasm(chia_gaming_init: any, cg: WasmConnection) {
    console.log('wasm detected');
    fetch(fetchUrl).then(wasm => wasm.blob()).then(blob => {
      return blob.arrayBuffer();
    }).then(modData => {
      chia_gaming_init(modData);
      setWasmConnection(cg);
      cg.init((msg: string) => console.warn('wasm', msg));
      return loadPresets();
    }).then(presets => {
      presets.forEach((nameAndContent) => {
        console.log(`preset load ${nameAndContent.name} ${nameAndContent.content.length}`);
        cg.deposit_file(nameAndContent.name, nameAndContent.content);
      });
      setGameConnectionState({
        stateIdentifier: "satarting",
        stateDetail: ["loaded preset files"]
      });
      let newGameIdentity = cg.chia_identity(rngSeed);
      console.log('gameIdentity', newGameIdentity);
      setGameIdentity(newGameIdentity);
      return fetch("clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex").then(calpoker => {
        return { calpoker, identity: newGameIdentity };
      });
    }).then(({ calpoker, identity }) => {
      return calpoker.text().then(calpoker_hex => {
        return { calpoker_hex, identity };
      });
    }).then(({ calpoker_hex, identity }) => {
      // Request a spendable coin from the wallet.
      setGameConnectionState({
        stateIdentifier: "starting",
        stateDetail: ["loaded calpoker"]
      });
      let walletObject = new ExternalBlockchainInterface(BLOCKCHAIN_SERVICE_URL, searchParams.walletToken);
      let amount = parseInt(searchParams.amount);
      console.log(`create coin spendable by ${identity.puzzle_hash} for ${amount}`);
      return walletObject.
        createSpendable(identity.puzzle_hash, amount).then((coin : any) => {
          console.log(`spendable coin ${coin}`);
          return { coin, calpoker_hex, identity };
        });
    }).then(({ coin, calpoker_hex, identity }) => {
      setGameConnectionState({
        stateIdentifier: "starting",
        stateDetail: [coin]
      });
      const env = {
        game_types: {
          "calpoker": {
            version: 1,
            hex: calpoker_hex
          }
        },
        timeout: 20,
        unroll_timeout: 5
      };
      const cradle = new ChiaGame(cg, env, rngSeed, identity, iStarted, amount, amount);
      cradle.opening_coin(coin);
      setGame(cradle);
      setGameConnectionState({
        stateIdentifier: "starting",
        stateDetail: ["doing handshake"]
      });
    });
  }

  if (game && incomingMessages.length) {
    let haveMessages = [...incomingMessages];
    setIncomingMessages([]);
    for (let i = 0; i < haveMessages.length; i++) {
      console.log('deliver message', haveMessages[i]);
      game.deliver_message(haveMessages[i]);
    }
  }

  useInterval(() => {
    if (game === undefined || wasmConnection === undefined) {
      return;
    }

    const idle = game.idle({
      // Local ui callbacks.
    });
    for (let i = 0; i < idle.outbound_messages.length; i++) {
      console.log('send message to remote');
      sendMessage({
        party: iStarted,
        token: token,
        msg: idle.outbound_messages[i]
      });
    }
  }, 100);

  (window as any).loadWasm = loadWasm;

  return {
    wasmConnection,
    gameIdentity,
    gameConnectionState,
    uniqueWalletConnectionId,
    realPublicKey,
    game
  };
}
