import { useState, useEffect, useRef, useCallback } from 'react';
import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome } from '../types/ChiaGaming';
import useGameSocket from './useGameSocket';
import { getSearchParams, useInterval, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../util';
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
  qualifyingEvents: number;
  loadWasmEvent: any | undefined;
  cardSelections: number;
  playerHand: number[][];
  opponentHand: number[][];
  finished: boolean;
  gameOutcome: CalpokerOutcome | undefined;
  stateChanger: (stateSettings: any) => void;

  constructor(stateChanger: (stateSettings: any) => void, blockchain: ExternalBlockchainInterface, walletToken: string, uniqueId: string, amount: number, iStarted: boolean) {
    const deliverMessage = useCallback((msg: string) => {
      this.deliverMessage(msg);
    }, []);

    const { sendMessage } = useGameSocket(deliverMessage, () => {
      this.kickSystem(2);
    });

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
    this.cardSelections = 0;
    this.playerHand = [];
    this.opponentHand = [];
    this.finished = false;
    this.qualifyingEvents = 0;
  }

  kickSystem(flags: number) {
    this.qualifyingEvents |= flags;
    if (this.qualifyingEvents == 3) {
      this.qualifyingEvents |= 4;
      this.pushEvent(this.loadWasmEvent);
    }
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

  internalKickIdle(): any {
    this.kickMessageHandling().then((res: any) => {
      let idle_info;
      do {
        idle_info = this.idle();
        if (!idle_info) {
          return res;
        }
        this.stateChanger(idle_info);
      } while (!idle_info.stop);
      return res;
    });
  }

  pushEvent(msg: any): any {
    if (this.finished) {
      return;
    }
    this.messageQueue.push(msg);
    return this.internalKickIdle();
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
    } else if (msg.takeOpponentMove) {
      let data = msg.takeOpponentMove;
      return this.takeOpponentMove(data.moveNumber, data.game_id, data.readable_move_hex);
    } else if (msg.takeGameMessage) {
      let data = msg.takeGameMessage;
      return this.takeGameMessage(data.moveNumber, data.game_id, data.readable_hex);
    } else if (msg.kickIdle) {
      return this.internalKickIdle();
    } else if (msg.setCardSelections !== undefined) {
      return this.internalSetCardSelections(msg.setCardSelections);
    } else if (msg.startGame) {
      return this.internalStartGame();
    } else if (msg.shutDown) {
      return this.internalShutdown();
    } else if (msg.receivedShutdown) {
      return this.internalReceivedShutdown();
    }

    console.error("Unknown event:", msg);
    return empty();
  }

  updateCards(readable: any, result: any) {
    let card_lists = proper_list(readable).map((l: any) => proper_list(l).map((c: any) => proper_list(c).map((v: Uint8Array) => {
      if (v.length > 0) {
        return v[0];
      }
      return 0;
    })));
    console.log('card_lists', card_lists);
    if (this.iStarted) {
      result.setPlayerHand = card_lists[1];
      result.setOpponentHand = card_lists[0];
      this.playerHand = card_lists[1];
      this.opponentHand = card_lists[0];
    } else {
      result.setPlayerHand = card_lists[0];
      result.setOpponentHand = card_lists[1];
      this.playerHand = card_lists[0];
      this.opponentHand = card_lists[1];
    }
  }

  finalOutcome(readable: any, result: any) {
    const outcome = new CalpokerOutcome(
      this.iStarted,
      this.cardSelections,
      this.iStarted ? this.opponentHand : this.playerHand,
      this.iStarted ? this.playerHand : this.opponentHand,
      readable
    );
    result.setOutcome = outcome;
  }

  takeOpponentMove(moveNumber: number, game_id: string, readable_move_hex: string): any {
    const result: any = {
      setMyTurn: true
    };
    console.log('takeOpponentMove', moveNumber, game_id, readable_move_hex);
    let p = decode_sexp_hex(readable_move_hex);
    console.log('readable move', JSON.stringify(p));
    if (moveNumber === 1) {
      this.updateCards(p, result);
    } else if (!this.iStarted && moveNumber === 2) {
      console.warn('finalOutcome:', this.iStarted, moveNumber);
      this.finalOutcome(p, result);
      this.makeMove('80');
    } else if (moveNumber > 1) {
      console.warn('finalOutcome:', this.iStarted, moveNumber);
      this.finalOutcome(p, result);
      console.warn('accept game');
      this.cradle?.accept(this.gameIds[0]);
      console.log('did accept', this.iStarted);
      this.gameIds.pop();
    }

    result.setMoveNumber = this.moveNumber;
    return empty().then(() => result);
  }

  takeGameMessage(moveNumber: number, game_id: string, readable_move_hex: string): any {
    const result = { };
    console.log('takeGameMessage', moveNumber, game_id, readable_move_hex);
    let p = decode_sexp_hex(readable_move_hex);
    this.updateCards(p, result);
    return empty().then(() => result);
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
    this.loadWasmEvent = { loadWasmEvent: { chia_gaming_init, cg } };
    this.kickSystem(1);
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

  internalStartGame(): any {
    let result: any = {};
    let gids = this.cradle?.start_games(!this.iStarted, {
      game_type: "63616c706f6b6572",
      timeout: 100,
      amount: this.amount * 2 / 10,
      my_contribution: this.amount / 10,
      my_turn: !this.iStarted,
      parameters: "80"
    });
    console.log("gameIds", gids);
    if (gids) {
      gids.forEach((g) => {
        this.gameIds.push(g);
      });
      result.setGameIds = this.gameIds;
    }
    result.setMyTurn = !this.iStarted;
    return empty().then(() => result);
  }

  idle(): any {
    const result: any = {};
    const idle = this.cradle?.idle({
      // Local ui callbacks.
      opponent_moved: (game_id, readable_move_hex) => {
        console.error('got opponent move', game_id, readable_move_hex);
        this.messageQueue.push({ takeOpponentMove: { game_id, readable_move_hex, moveNumber: this.moveNumber } });
      },
      game_message: (game_id, readable_hex) => {
        console.error('got opponent msg', game_id, readable_hex);
        this.messageQueue.push({ takeGameMessage: { game_id, readable_hex, moveNumber: this.moveNumber } });
      },
      game_finished: (game_id, amount) => {
        // Signals accept.
        this.gameIds.pop();
        console.log('got accept', this.iStarted);

        this.myTurn = false;
        this.cardSelections = 0;
        this.moveNumber = 0;
        this.playerHand = [];
        this.opponentHand = [];

        result.setCardSelections = 0;
        result.setMoveNumber = 0;
        result.setPlayerHand = [];
        result.setOpponentHand = [];
        result.setOutcome = undefined;
        result.setGameConnectionState = {
          stateIdentifier: "running",
          stateDetail: []
        };

        result.setMyTurn = false;
        this.messageQueue.push({ startGame: true });
      }
    });

    if (!idle || this.finished) {
      return { stop: true };
    }

    if (idle.finished && !this.finished) {
      console.error('we shut down');
      this.finished = true;
      this.stateChanger({
        setGameConnectionState: {
          stateIdentifier: "shutdown",
          stateDetail: []
        },
        outcome: undefined
      });
      this.messageQueue.push({ receivedShutdown: true });
      return result;
    }

    result.stop = !idle.continue_on;

    result.setError = idle.receive_error;
    console.log('idle1', idle.action_queue);
    if (idle.handshake_done && !this.handshakeDone) {
      console.warn("HANDSHAKE DONE");
      this.handshakeDone = true;
      result.setGameConnectionState = {
        stateIdentifier: "running",
        stateDetail: []
      };
      console.log("starting games", this.iStarted);
      this.pushEvent({ startGame: true });
    }

    console.log('idle2', idle.incoming_messages);
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

  kickIdle() {
    this.pushEvent({ kickIdle: true });
    return empty();
  }

  generateEntropy() {
    let hexDigits = [];
    for (let i = 0; i < 16; i++) {
      hexDigits.push(Math.floor(Math.random() * 16)).toString(16);
    }
    let entropy = this.wc?.sha256bytes(hexDigits.join(""));
    if (!entropy) {
      throw 'tried to make entropy without a wasm connection';
    }
    return entropy;
  }


  internalMakeMove(move: any): any {
    if (!this.handshakeDone || !this.wc || !this.cradle) {
      return empty();
    }

    if (this.moveNumber === 0) {
      let entropy = this.generateEntropy();
      console.log('move 0 with entropy', entropy);
      this.cradle?.make_move_entropy(this.gameIds[0], "80", entropy);
      this.moveNumber += 1;
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.moveNumber
        };
      })
    } else if (this.moveNumber === 1) {
      if (popcount(this.cardSelections) != 4) {
        return empty();
      }
      this.moveNumber += 1;
      let entropy = this.generateEntropy();
      const encoded = (this.cardSelections | 0x8100).toString(16);
      this.cradle?.make_move_entropy(this.gameIds[0], encoded, entropy);
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.moveNumber
        };
      })
    } else if (this.moveNumber === 2) {
      this.moveNumber += 1;
      let entropy = this.generateEntropy();
      this.cradle?.make_move_entropy(this.gameIds[0], '80', entropy);
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.moveNumber,
          setGameConnectionState: {
            stateIdentifier: "end",
            stateDetail: []
          }
        };
      })
    }

    throw `Don't yet know what to do for move ${this.moveNumber}`;
  }

  makeMove(move: any) {
    this.pushEvent({ move });
  }

  setCardSelections(mask: number) {
    this.pushEvent({ setCardSelections: mask });
  }

  internalSetCardSelections(mask: number): any {
    const result = { setCardSelections: mask };
    this.cardSelections = mask;
    return empty().then(() => result);
  }

  shutDown() {
    this.pushEvent({ shutDown: true });
  }

  internalShutdown() {
    const result = {
      setGameConnectionState: {
        stateIdentifier: "shutdown",
        stateDetail: []
      },
      outcome: undefined
    };
    this.cradle?.shut_down();
    return empty().then(() => result);
  }

  internalReceivedShutdown() {
    const result: any = {};
    console.warn('internalReceivedShutdown', this.finished);
    console.warn('setting shutdown state in ui');
    result.setGameConnectionState = {
      stateIdentifier: "shutdown",
      stateDetail: []
    };
    result.outcome = undefined;
    return empty().then(() => result);
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
  const [playerHand, setPlayerHand] = useState<number[][]>([]);
  const [opponentHand, setOpponentHand] = useState<number[][]>([]);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [finalPlayerHand, setFinalPlayerHand] = useState<string[]>([]);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(false);
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const [error, setRealError] = useState<string | undefined>(undefined);
  const [cardSelections, setOurCardSelections] = useState<number>(0);
  const amount = parseInt(searchParams.amount);
  const setError = (e: any) => {
    if (e !== undefined && error === undefined) {
      setRealError(e);
    }
  };
  const settable: any = {
    'setGameConnectionState': setGameConnectionState,
    'setPlayerHand': setPlayerHand,
    'setOpponentHand': setOpponentHand,
    'setMyTurn': setMyTurn,
    'setMoveNumber': setMoveNumber,
    'setError': setError,
    'setCardSelections': setOurCardSelections,
    'setOutcome': setOutcome
  };

  let setCardSelections = useCallback((mask: number) => {
    gameObject?.setCardSelections(mask);
  }, []);
  let messageSender = useCallback((msg: string) => {
    console.error('send message with no sender defined', msg);
  }, []);
  let stopPlaying = useCallback(() => {
    gameObject?.shutDown();
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
    error,
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
    cardSelections,
    setCardSelections,
    stopPlaying,
    outcome
  };
}
