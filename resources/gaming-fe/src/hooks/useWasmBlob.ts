import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, useInterval, spend_bundle_to_clvm } from '../util';
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
  const [blockNumber, setBlockNumber] = useState<number>(0);
  const [haveBlockNumber, setHaveBlockNumber] = useState<number>(0);
  const [blockReports, setBlockReports] = useState<any[]>([]);
  const [handshakeDone, setHandshakeDone] = useState<boolean>(false);

  const searchParams = getSearchParams();
  const token = searchParams.token;
  const uniqueId = searchParams.uniqueId;
  const iStarted = searchParams.iStarted !== 'false';
  const amount = parseInt(searchParams.amount);

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

  async function crawl_block(): Promise<number> {
    const useBlockNumber = blockNumber
    return fetch(`${BLOCKCHAIN_SERVICE_URL}/get_block_data?block=${blockNumber}`, {
      body: '',
      method: 'POST'
    }).then(res => res.json()).then(block_data => {
      if (block_data) {
        console.log(useBlockNumber, block_data);
        setBlockReports([...blockReports, {
          number: useBlockNumber,
          data: block_data
        }]);
      }

      return blockNumber;
    });
  }

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
      const rngSeed = uniqueId.substr(0, 8);
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
        timeout: 30,
        unroll_timeout: 30
      };
      const rngSeed = uniqueId.substr(0, 8);
      const cradle = new ChiaGame(cg, env, rngSeed, identity, iStarted, amount, amount);
      cradle.opening_coin(coin);
      setGame(cradle);
      setGameConnectionState({
        stateIdentifier: "starting",
        stateDetail: ["doing handshake"]
      });
    });
  }

  useInterval(() => {
    fetch(`${BLOCKCHAIN_SERVICE_URL}/wait_block`, {
      body: '',
      method: 'POST'
    }).then(res => res.json()).then(new_block_number => {
      setHaveBlockNumber(new_block_number);
    });
  }, 2000);

  useInterval(() => {
    if (game === undefined || wasmConnection === undefined) {
      return;
    }

    function handleGameIdle() {
      const idle = game?.idle({
        // Local ui callbacks.
      });

      if (!idle) {
        return;
      }

      if (idle.handshake_done && !handshakeDone) {
        console.warn("HANDSHAKE DONE");
        setHandshakeDone(true);
        setGameConnectionState({
          stateIdentifier: "running",
          stateDetail: []
        });
      }

      for (let i = 0; i < idle.outbound_messages.length; i++) {
        console.log('send message to remote');
        sendMessage({
          party: iStarted,
          token: token,
          msg: idle.outbound_messages[i]
        });
      }

      for (let i = 0; i < idle.outbound_transactions.length; i++) {
        const tx = idle.outbound_transactions[i];
        console.log('send transaction', tx);
        // Compose blob to spend
        let blob = spend_bundle_to_clvm(tx);
        fetch(`${BLOCKCHAIN_SERVICE_URL}/spend?blob=${blob}`, {
          body: '',
          method: 'POST'
        }).then(res => res.json()).then(res => {
          console.log('spend res', res);
        });
      }
    }

    handleGameIdle();

    if (incomingMessages.length) {
      let haveMessages = [...incomingMessages];
      setIncomingMessages([]);
      for (let i = 0; i < haveMessages.length; i++) {
        console.log('deliver message', haveMessages[i]);
        game.deliver_message(haveMessages[i]);
      }
    }

    if (haveBlockNumber > blockNumber) {
      crawl_block();
      setBlockNumber(blockNumber + 1);
    }

    let theBlockReports = blockReports;
    setBlockReports([]);
    theBlockReports.sort((a, b) => {
      return a.number - b.number;
    });
    if (theBlockReports.length !== 0) {
      let startNumber = theBlockReports[0].number;
      for (let i = 0; i < theBlockReports.length; i++) {
        let report = theBlockReports[i];
        if (report.number === startNumber) {
          startNumber += 1;
          game?.block_data(report.number, report.data);
          handleGameIdle();
          continue;
        }
      }
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
