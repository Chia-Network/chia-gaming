import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, useInterval, spend_bundle_to_clvm } from '../util';
import { v4 as uuidv4 } from 'uuid';

async function empty() {
  return {};
}

let blobSingleton: any = null;
class WasmBlobWrapper {
  amount: number;
  walletToken: string;
  wc: WasmConnection | undefined;
  rngSeed: string;
  sendMessage: (msg: string) => void;
  blockchain: ExternalBlockchainInterface;
  identity: IChiaIdentity | undefined;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  calpokerHex: string | undefined;
  handshakeDone: boolean;
  handlingMessage: boolean;
  currentBlock: number;
  messageQueue: any[];
  iStarted: boolean;
  gameIds: string[];
  storedMessages: string[];
  myTurn: boolean;
  moveNumber: number;
  stateChanger: (stateSettings: any) => void;

  constructor(stateChanger: (stateSettings: any) => void, blockchain: ExternalBlockchainInterface, walletToken: string, uniqueId: string, amount: number, iStarted: boolean) {
    const deliverMessage = useCallback((msg: string) => {
      this.deliverMessage(msg);
    }, []);

    const { sendMessage } = useGameSocket(deliverMessage);

    this.stateChanger = stateChanger;
    this.uniqueId = uniqueId;
    this.rngSeed = this.uniqueId.substr(0, 8);
    this.sendMessage = sendMessage;
    this.walletToken = walletToken;
    this.amount = amount;
    this.currentBlock = 0;
    this.blockchain = blockchain;
    this.handlingMessage = false;
    this.handshakeDone = false;
    this.iStarted = iStarted;
    this.gameIds = [];
    this.myTurn = false;
    this.storedMessages = [];
    this.moveNumber = 0;
    this.messageQueue = [{ getPeak: true }];
  }

  loadPresets(presetFiles: string[]) {
    const presetFetches = presetFiles.map((partialUrl) => {
      return fetch(partialUrl).then((fetched) => fetched.text()).then((text) => {
        return {
          name: partialUrl,
          content: text
        };
      });
    });
    return Promise.all(presetFetches).then(presets => {
      presets.forEach((nameAndContent) => {
        console.log(`preset load ${nameAndContent.name} ${nameAndContent.content.length}`);
        this.wc?.deposit_file(nameAndContent.name, nameAndContent.content);
      });
      let newGameIdentity = this.wc?.chia_identity(this.rngSeed);
      this.identity = newGameIdentity;
      this.pushEvent({ loadCalpoker: true });
      return {
        'setGameConnectionState': {
          stateIdentifier: "starting",
          stateDetail: ["loaded preset files"]
        },
        'setGameIdentity': newGameIdentity
      };
    });
  };

  getInitialBlock(): any {
    return this.blockchain.getPeak().then(new_block_number => {
      this.currentBlock = new_block_number;
      return {};
    });
  }

  haveEvents(): boolean {
    return this.messageQueue.length > 0;
  }

  pushEvent(msg: any): any {
    this.messageQueue.push(msg);
    this.kickMessageHandling().then((res: any) => {
      let idle_info;
      do {
        idle_info = this.idle();
        this.stateChanger(idle_info);
      } while (!idle_info.stop);
      return res;
    });
  }

  handleOneMessage(msg: any): any {
    console.log('handleOneMessage', Object.keys(msg));
    if (msg.loadWasmEvent) {
      return this.internalLoadWasm(
        msg.loadWasmEvent.chia_gaming_init,
        msg.loadWasmEvent.cg
      );
    } else if (msg.loadPresets) {
      return this.loadPresets(msg.loadPresets);
    } else if (msg.createStartCoin) {
      return this.createStartCoin();
    } else if (msg.loadCalpoker) {
      return this.loadCalpoker();
    } else if (msg.waitBlock) {
      return this.internalWaitBlock(msg.waitBlock);
    } else if (msg.deliverMessage) {
      return this.internalDeliverMessage(msg.deliverMessage);
    } else if (msg.getPeak) {
      return this.getInitialBlock();
    } else if (msg.move) {
      return this.internalMakeMove(msg.move);
    }

    console.error("Unknown event:", msg);
    return empty();
  }

  kickMessageHandling(): any {
    if (this.messageQueue.length == 0 || this.handlingMessage) {
      return empty();
    }

    const msg = this.messageQueue.shift();

    this.handlingMessage = true;
    let result = null;
    return this.handleOneMessage(msg).then((result: any) => {
      this.stateChanger(result);
      this.handlingMessage = false;
      if (this.messageQueue.length != 0) {
        return this.kickMessageHandling();
      }
      return result;
    }).catch((e: any) => {
      console.error(e);
      this.handlingMessage = false;
      throw e;
    });
  }

  loadCalpoker(): any {
    return fetch("clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex").then(calpoker => calpoker.text()).then(calpoker_hex => {
      this.calpokerHex = calpoker_hex;
      this.pushEvent({ createStartCoin: true });
      return {
        'setGameConnectionState': {
          stateIdentifier: "starting",
          stateDetail: ["loaded calpoker"]
        }
      };
    });
  }

  loadWasm(chia_gaming_init: any, cg: WasmConnection): any {
    this.pushEvent({ loadWasmEvent: { chia_gaming_init, cg } });
    return empty();
  }

  createStartCoin(): any {
    const identity = this.identity;
    if (!identity) {
      console.error('create start coin with no identity');
      return empty();
    }
    const calpokerHex = this.calpokerHex;
    if (!calpokerHex) {
      console.error('create start coin with no calpoker loaded');
      return empty();
    }

    const wc = this.wc;
    if (!wc) {
      console.error('create start coin with no wasm obj?');
      return empty();
    }

    console.log(`create coin spendable by ${identity.puzzle_hash} for ${this.amount}`);
    return this.blockchain.
      createSpendable(identity.puzzle_hash, this.amount).then(coin => {
        if (!coin) {
          console.error('tried to create spendable but failed');
          return empty();
        }

        const env = {
          game_types: {
            "calpoker": {
              version: 1,
              hex: calpokerHex
            }
          },
          timeout: 100,
          unroll_timeout: 100
        };
        this.cradle = new ChiaGame(wc, env, this.rngSeed, identity, this.iStarted, this.amount, this.amount);
        this.storedMessages.forEach((m) => {
          this.cradle?.deliver_message(m);
        });
        this.cradle.opening_coin(coin);
        return {
          'setGameConnectionState': {
            stateIdentifier: "starting",
            stateDetail: ["doing handshake"]
          }
        };
      });
  }

  internalLoadWasm(chia_gaming_init: any, cg: WasmConnection): any {
    const fetchUrl = process.env.REACT_APP_WASM_URL || 'http://localhost:3001/chia_gaming_wasm_bg.wasm';

    console.log('wasm detected');
    return fetch(fetchUrl).then(wasm => wasm.blob()).then(blob => {
      return blob.arrayBuffer();
    }).then(modData => {
      chia_gaming_init(modData);
      cg.init((msg: string) => console.warn('wasm', msg));
      this.wc = cg;
      const presetFiles = [
        "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex",
        "clsp/unroll/unroll_meta_puzzle.hex",
        "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
        "clsp/referee/onchain/referee.hex",
        "clsp/referee/onchain/referee-v1.hex"
      ];
      this.pushEvent({ loadPresets: presetFiles });
      return {};
    });
  }

  waitBlock(block: number): any {
    this.pushEvent({ waitBlock: block });
    return empty();
  }

  internalWaitBlock(new_block_number: number): any {
    if (this.currentBlock == 0) {
      this.currentBlock = new_block_number;
    }
    let currentBlock = this.currentBlock;
    return this.blockchain.getBlockData(currentBlock).then(block_data => {
      if (block_data) {
        console.log(currentBlock, block_data);
        this.cradle?.block_data(currentBlock, block_data);
        this.currentBlock = this.currentBlock + 1;
        if (this.currentBlock <= new_block_number) {
          this.waitBlock(this.currentBlock);
        }
      }

      return {};
    });
  }

  deliverMessage(msg: string) {
    this.pushEvent({ deliverMessage: msg });
  }

  internalDeliverMessage(msg: string): any {
    if (!this.cradle) {
      this.storedMessages.push(msg);
      return empty();
    }
    this.cradle?.deliver_message(msg);
    return empty();
  }

  idle(): any {
    const result: any = {};
    const idle = this.cradle?.idle({
      opponent_moved: (game_id, readable_move_hex) => {
        console.error('got opponent move', game_id, readable_move_hex);
      }
      // Local ui callbacks.
    });

    if (!idle) {
      return { stop: true };
    }

    result.stop = !idle.continue_on;

    console.log('idle1');
    if (idle.handshake_done && !this.handshakeDone) {
      console.warn("HANDSHAKE DONE");
      this.handshakeDone = true;
      result.setGameConnectionState = {
        stateIdentifier: "running",
        stateDetail: []
      };
      let gids = this.cradle?.start_games(!this.iStarted, {
        game_type: "63616c706f6b6572",
        timeout: 100,
        amount: this.amount * 2,
        my_contribution: this.amount,
        my_turn: !this.iStarted,
        parameters: "80"
      });
      console.log("game_ids", gids);
      if (gids) {
        gids.forEach((g) => {
          this.gameIds.push(g);
        });
        result.setGameIds = this.gameIds;
      }
      result.setMyTurn = !this.iStarted;
    }

    console.log('idle2');
    for (let i = 0; i < idle.outbound_messages.length; i++) {
      console.log('send message to remote');
      this.sendMessage(idle.outbound_messages[i]);
    }

    for (let i = 0; i < idle.outbound_transactions.length; i++) {
      const tx = idle.outbound_transactions[i];
      console.log('send transaction', tx);
      // Compose blob to spend
      let blob = spend_bundle_to_clvm(tx);
      this.blockchain.spend(blob).then(res => {
        console.log('spend res', res);
      });
    }

    return result;
  }

  internalMakeMove(move: any): any {
    if (!this.handshakeDone || !this.wc || !this.cradle) {
      return;
    }

    if (this.moveNumber === 0) {
      let entropy = this.wc?.sha256bytes(this.uniqueId.substr(0,8));
      console.log('move 0 with entropy', entropy);
      this.cradle?.make_move_entropy(this.gameIds[0], "80", entropy);
      this.moveNumber += 1;
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.moveNumber,
        };
      })
    }

    throw `Don't yet know what to do for move ${this.moveNumber}`;
  }

  makeMove(move: any) {
    this.pushEvent({ move });
  }
}

function getBlobSingleton(stateChanger: (state: any) => void, blockchain: ExternalBlockchainInterface, walletToken: string, uniqueId: string, amount: number, iStarted: boolean) {
  if (blobSingleton) {
    return blobSingleton;
  }

  blobSingleton = new WasmBlobWrapper(
    stateChanger,
    blockchain,
    walletToken,
    uniqueId,
    amount,
    iStarted
  );
  return blobSingleton;
}

export function useWasmBlob() {
  const BLOCKCHAIN_SERVICE_URL = process.env.REACT_APP_BLOCKCHAIN_SERVICE_URL || 'http://localhost:5800';

  const [realPublicKey, setRealPublicKey] = useState<string | undefined>(undefined);
  const [gameIdentity, setGameIdentity] = useState<any | undefined>(undefined);
  const [uniqueWalletConnectionId, setUniqueWalletConnectionId] = useState(uuidv4());
  const [gameStartCoin, setGameStartCoin] = useState<string | undefined>(undefined);
  const [gameConnectionState, setGameConnectionState] = useState<GameConnectionState>({ stateIdentifier: "starting", stateDetail: ["before handshake"] });
  const [handshakeDone, setHandshakeDone] = useState<boolean>(false);

  const searchParams = getSearchParams();
  const token = searchParams.token;
  const uniqueId = searchParams.uniqueId;
  const iStarted = searchParams.iStarted !== 'false';
  const playerNumber = iStarted ? 1 : 2;
  const [playerHand, setMyHand] = useState<string[]>([]);
  const [opponentHand, setTheirHand] = useState<string[]>([]);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const amount = parseInt(searchParams.amount);
  const settable: any = {
    'setGameConnectionState': setGameConnectionState,
    'setMyTurn': setMyTurn
  };

  let messageSender = useCallback((msg: string) => {
    console.error('send message with no sender defined', msg);
  }, []);

  const stateChanger = useCallback((state: any) => {
    window.postMessage({ name: 'game_state', values: state });
  }, []);

  const setState = useCallback((state: any) => {
    if (state.name != 'game_state') {
      console.error(state);
      return;
    }
    const keys = Object.keys(state.values);
    keys.forEach((k) => {
      if (settable[k]) {
        console.warn(k, state.values[k]);
        settable[k](state.values[k]);
      }
    });
  }, []);

  const walletObject = new ExternalBlockchainInterface(
    BLOCKCHAIN_SERVICE_URL,
    searchParams.walletToken
  );

  const gameObject = uniqueId ?
    getBlobSingleton(
      stateChanger,
      walletObject,
      searchParams.walletToken,
      uniqueId,
      amount,
      iStarted
    ) :
    null;

  const handleMakeMove = useCallback((move: any) => {
    gameObject?.makeMove(move);
  }, []);

  useInterval(() => {
    walletObject.waitBlock().then(new_block_number => {
      gameObject?.waitBlock(new_block_number);
    });
  }, 5000);

  (window as any).loadWasm = useCallback((chia_gaming_init: any, cg: any) => {
    console.log('start loading wasm', gameObject);
    gameObject?.loadWasm(chia_gaming_init, cg);
  }, []);

  return {
    setState,
    gameIdentity,
    gameConnectionState,
    uniqueWalletConnectionId,
    realPublicKey,
    isPlayerTurn,
    iStarted,
    playerNumber,
    handleMakeMove,
    playerHand,
    opponentHand,
    moveNumber,
  };
}
