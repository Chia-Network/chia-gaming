import { PeerConnectionResult, WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, WatchReport, BlockchainReport, InternalBlockchainInterface, ChiaGameConfig } from '../types/ChiaGaming';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount, empty } from '../util';
import { Subject, Observable, NextObserver } from 'rxjs';

function combine_reports(old_report: WatchReport, new_report: WatchReport) {
  for (var i = 0; i < new_report.created_watched.length; i++) {
    old_report.created_watched.push(new_report.created_watched[i]);
  }
  for (var i = 0; i < new_report.deleted_watched.length; i++) {
    old_report.deleted_watched.push(new_report.deleted_watched[i]);
  }
  for (var i = 0; i < new_report.timed_out.length; i++) {
    old_report.timed_out.push(new_report.timed_out[i]);
  }
}

export interface WasmBlobSerializedConfig {
  cradle: any;

  uniqueId: string;
  amount: number;
  iStarted: boolean;
}

export interface WasmBlobConfig {
  serialized?: WasmBlobSerializedConfig;
  blockchain: InternalBlockchainInterface;
  uniqueId: string;
  amount: number;
  iStarted: boolean;
  doInternalLoadWasm: () => Promise<ArrayBuffer>;
  fetchHex: (key: string) => Promise<string>;
  peer_conn: PeerConnectionResult;
}

export interface WasmBlobCanSerialize {
  amount: number;
  rngSeed: string;
  identity?: IChiaIdentity;
  uniqueId: string;
  handshakeDone: boolean;
  currentBlock: number;
  iStarted: boolean;
  gameIds: string[];
  myTurn: boolean;
  moveNumber: number;
  qualifyingEvents: number;
  cardSelections: number;
  playerHand: number[][];
  opponentHand: number[][];
  finished: boolean;
  gameOutcome?: CalpokerOutcome;
}

export class WasmBlobWrapper {
  serialized: any | undefined;
  wc: WasmConnection | undefined;
  working: WasmBlobCanSerialize;
  sendMessage: (msg: string) => void;
  cradle: ChiaGame | undefined;
  handlingMessage: boolean;
  messageQueue: any[];
  storedMessages: string[];
  loadWasmEvent: any | undefined;
  fetchHex: (path: string) => Promise<string>;
  doInternalLoadWasm: () => Promise<ArrayBuffer>;
  rxjsMessageSingleon: Subject<any>;
  rxjsEmitter: NextObserver<any>;
  blockchain: InternalBlockchainInterface;
  calpokerHex: string | undefined;

  constructor (config: WasmBlobConfig) {
    const { sendMessage } = config.peer_conn;

    this.serialized = config.serialized;
    this.working = {
      uniqueId: config.uniqueId,
      rngSeed: config.uniqueId.substr(0, 8),
      amount: config.amount,
      currentBlock: 0,
      handshakeDone: false,
      iStarted: config.iStarted,
      gameIds: [],
      myTurn: false,
      moveNumber: 0,
      cardSelections: 0,
      playerHand: [],
      opponentHand: [],
      finished: false,
      qualifyingEvents: 0
    };
    this.sendMessage = sendMessage;
    this.handlingMessage = false;
    this.storedMessages = [];
    this.messageQueue = [];
    this.fetchHex = config.fetchHex;
    this.doInternalLoadWasm = config.doInternalLoadWasm;
    this.blockchain = config.blockchain;
    this.rxjsMessageSingleon = new Subject<any>();
    this.rxjsEmitter = this.rxjsMessageSingleon;
  }

  serialize() {
    this.pushEvent({ serialize: true });
  }

  getObservable() {
    return this.rxjsMessageSingleon;
  }

  kickSystem(flags: number) {
    this.working.qualifyingEvents |= flags;
    if (this.working.qualifyingEvents == 7) {
      this.working.qualifyingEvents |= 8;
      this.pushEvent(this.loadWasmEvent);
    }
  }

  loadPresets(presetFiles: string[]) {
    const presetFetches = presetFiles.map((partialUrl) => {
      return this.fetchHex(partialUrl).then((text) => {
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
      let newGameIdentity = this.wc?.chia_identity(this.working.rngSeed);
      this.working.identity = newGameIdentity;
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
        this.rxjsEmitter.next(idle_info);
      } while (!idle_info.stop);
      return res;
    });
  }

  pushEvent(msg: any): any {
    if (this.working.finished) {
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
    } else if (msg.deliverMessage) {
      return this.internalDeliverMessage(msg.deliverMessage);
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
    } else if (msg.takeBlockData) {
      return this.internalTakeBlock(msg.takeBlockData.peak, msg.takeBlockData.block_report);
    } else if (msg.serialize) {
      return this.internalSerialize();
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
    if (this.working.iStarted) {
      result.setPlayerHand = card_lists[1];
      result.setOpponentHand = card_lists[0];
      this.working.playerHand = card_lists[1];
      this.working.opponentHand = card_lists[0];
    } else {
      result.setPlayerHand = card_lists[0];
      result.setOpponentHand = card_lists[1];
      this.working.playerHand = card_lists[0];
      this.working.opponentHand = card_lists[1];
    }
  }

  finalOutcome(readable: any, result: any) {
    const outcome = new CalpokerOutcome(
      this.working.iStarted,
      this.working.cardSelections,
      this.working.iStarted ? this.working.opponentHand : this.working.playerHand,
      this.working.iStarted ? this.working.playerHand : this.working.opponentHand,
      readable
    );
    result.setOutcome = outcome;
  }

  takeOpponentMove(moveNumber: number, game_id: string, readable_move_hex: string): any {
    const result: any = {
      setMyTurn: true,
      setMoveNumber: this.working.moveNumber
    };
    console.log('takeOpponentMove', moveNumber, game_id, readable_move_hex);
    let p = decode_sexp_hex(readable_move_hex);
    console.log('readable move', JSON.stringify(p));
    if (moveNumber === 1) {
      this.updateCards(p, result);
    } else if (!this.working.iStarted && moveNumber === 2) {
      console.warn('finalOutcome:', this.working.iStarted, moveNumber);
      this.finalOutcome(p, result);
      this.makeMove('80');
    } else if (moveNumber > 1) {
      console.warn('finalOutcome:', this.working.iStarted, moveNumber);
      this.finalOutcome(p, result);
      console.warn('accept game');
      this.cradle?.accept(this.working.gameIds[0]);
      console.log('did accept', this.working.iStarted);
      this.working.gameIds.pop();
    }

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
    return this.handleOneMessage(msg).then((result: any) => {
      this.rxjsEmitter.next(result);
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
    return this.fetchHex("clsp/games/calpoker-v1/calpoker_include_calpoker_factory.hex").then(calpoker_hex => {
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
    const identity = this.working.identity;
    if (!identity) {
      throw new Error('create start coin with no identity');
    }
    const calpokerHex = this.calpokerHex;
    if (!calpokerHex) {
      throw new Error('create start coin with no calpoker loaded');
    }

    const wc = this.wc;
    if (!wc) {
      throw new Error('create start coin with no wasm obj?');
    }

    console.log(`create coin spendable by ${identity.puzzle_hash} for ${this.working.amount}`);
    return this.blockchain.
      do_initial_spend(this.working.uniqueId, identity.puzzle_hash, this.working.amount).then(result => {
        let coin = result.coin;
        if (!coin) {
          throw new Error('tried to create spendable but failed');
        }

        // Handle data conversion back when Coin object was received.
        if (typeof coin !== 'string') {
          const coinset_coin = coin as any;
          const new_coin_string = this.wc?.convert_coinset_to_coin_string(coinset_coin.parentCoinInfo, coinset_coin.puzzleHash, coinset_coin.amount.toString());
          if (!new_coin_string) {
            throw new Error(`Coin could not be converted to coinstring: ${JSON.stringify(coinset_coin)}`);
          }

          coin = new_coin_string;
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

        let gameConfig: ChiaGameConfig = {
          wasm: wc,
          env,
          seed: this.working.rngSeed,
          identity,
          have_potato: this.working.iStarted,
          my_contribution: this.working.amount,
          their_contribution: this.working.amount
        };

        if (this.serialized) {
          gameConfig.cradle_id = wc?.create_serialized_game(
            this.serialized.game,
            this.working.rngSeed
          );

          this.working = this.serialized.working;
        }

        this.cradle = new ChiaGame(gameConfig);
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
      }).catch((e) => {
        return {
          'setError': e.toString()
        };
      });
  }

  internalLoadWasm(chia_gaming_init: any, cg: WasmConnection): any {
    console.log('wasm detected');
    return this.doInternalLoadWasm().then(modData => {
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

  deliverMessage(msg: string) {
    this.pushEvent({ deliverMessage: msg });
  }

  internalDeliverMessage(msg: string): any {
    if (!this.cradle) {
      this.storedMessages.push(msg);
      return empty();
    }
    console.log('deliver message', msg);
    this.cradle?.deliver_message(msg);
    return empty();
  }

  internalStartGame(): any {
    let result: any = {};
    let gids = this.cradle?.start_games(!this.working.iStarted, {
      game_type: "63616c706f6b6572",
      timeout: 100,
      amount: this.working.amount * 2 / 10,
      my_contribution: this.working.amount / 10,
      my_turn: !this.working.iStarted,
      parameters: "80"
    });
    console.log("gameIds", gids);
    if (gids) {
      gids.forEach((g) => {
        this.working.gameIds.push(g);
      });
      result.setGameIds = this.working.gameIds;
    }
    result.setMyTurn = !this.working.iStarted;
    result.setGids = this.working.gameIds;
    return empty().then(() => result);
  }

  idle(): any {
    const result: any = {};
    const idle = this.cradle?.idle({
      // Local ui callbacks.
      opponent_moved: (game_id, readable_move_hex) => {
        console.error('got opponent move', game_id, readable_move_hex);
        this.messageQueue.push({ takeOpponentMove: { game_id, readable_move_hex, moveNumber: this.working.moveNumber } });
      },
      game_message: (game_id, readable_hex) => {
        console.error('got opponent msg', game_id, readable_hex);
        this.messageQueue.push({ takeGameMessage: { game_id, readable_hex, moveNumber: this.working.moveNumber } });
      },
      game_finished: (game_id, amount) => {
        // Signals accept.
        this.working.gameIds.pop();
        console.log('got accept', this.working.iStarted);

        this.working.myTurn = false;
        this.working.cardSelections = 0;
        this.working.moveNumber = 0;
        this.working.playerHand = [];
        this.working.opponentHand = [];

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

    if (!idle || this.working.finished) {
      return { stop: true };
    }

    if (idle.finished && !this.working.finished) {
      console.error('we shut down');
      this.working.finished = true;
      this.rxjsEmitter.next({
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
    if (idle.handshake_done && !this.working.handshakeDone) {
      console.warn("HANDSHAKE DONE");
      this.working.handshakeDone = true;
      result.setGameConnectionState = {
        stateIdentifier: "running",
        stateDetail: []
      };
      console.log("starting games", this.working.iStarted);
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
      const cvt = (blob: string) => {
        return this.wc?.convert_spend_to_coinset_org(blob);
      };
      this.blockchain.spend(cvt, blob).then(res => {
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

  isHandshakeDone(): boolean { return this.working.handshakeDone; }

  internalMakeMove(move: any): any {
    if (!this.working.handshakeDone || !this.wc || !this.cradle) {
      return empty();
    }

    if (this.working.moveNumber === 0) {
      let entropy = this.generateEntropy();
      console.log('move 0 with entropy', entropy);
      this.cradle?.make_move_entropy(this.working.gameIds[0], "80", entropy);
      this.working.moveNumber += 1;
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.working.moveNumber
        };
      })
    } else if (this.working.moveNumber === 1) {
      if (popcount(this.working.cardSelections) != 4) {
        return empty();
      }
      this.working.moveNumber += 1;
      let entropy = this.generateEntropy();
      const encoded = (this.working.cardSelections | 0x8100).toString(16);
      this.cradle?.make_move_entropy(this.working.gameIds[0], encoded, entropy);
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.working.moveNumber
        };
      })
    } else if (this.working.moveNumber === 2) {
      this.working.moveNumber += 1;
      let entropy = this.generateEntropy();
      this.cradle?.make_move_entropy(this.working.gameIds[0], '80', entropy);
      return empty().then(() => {
        return {
          setMyTurn: false,
          setMoveNumber: this.working.moveNumber,
          setGameConnectionState: {
            stateIdentifier: "end",
            stateDetail: []
          }
        };
      })
    }

    throw `Don't yet know what to do for move ${this.working.moveNumber}`;
  }

  makeMove(move: any) {
    this.pushEvent({ move });
  }

  setCardSelections(mask: number) {
    this.pushEvent({ setCardSelections: mask });
  }

  internalSetCardSelections(mask: number): any {
    const result = { setCardSelections: mask };
    this.working.cardSelections = mask;
    return empty().then(() => result);
  }

  shutDown() {
    this.pushEvent({ shutDown: true });
  }

  internalShutdown() {
    const result: any = {
      setGameConnectionState: {
        stateIdentifier: "shutdown",
        stateDetail: []
      },
      outcome: undefined
    };
    this.cradle?.shut_down();
    return empty().then(() => result);
  }

  internalTakeBlock(peak: number, block_report: WatchReport): any {
    console.log('internalTakeBlock', peak, block_report);
    this.cradle?.block_data(peak, block_report);
    // console.log('took block', peak);
    return empty();
  }

  internalReceivedShutdown() {
    const result: any = {};
    console.warn('internalReceivedShutdown', this.working.finished);
    console.warn('setting shutdown state in ui');
    result.setGameConnectionState = {
      stateIdentifier: "shutdown",
      stateDetail: []
    };
    result.outcome = undefined;
    return empty().then(() => result);
  }

  blockNotification(peak: number, blocks: any[], block_report: any) {
    if (block_report === undefined) {
      block_report = {
        created_watched: [],
        deleted_watched: [],
        timed_out: []
      };
      for (var b = 0; b < blocks.length; b++) {
        const block = blocks[b];
        const one_report = this.wc?.convert_coinset_org_block_spend_to_watch_report(
          block.coin.parent_coin_info,
          block.coin.puzzle_hash,
          block.coin.amount.toString(),
          block.puzzle_reveal,
          block.solution
        );
        if (one_report) {
          combine_reports(block_report, one_report);
        }
      }
    }
    this.kickSystem(4);
    this.pushEvent({ takeBlockData: {
      peak: peak,
      block_report: block_report
    }});
  }

  internalSerialize() {
    return empty().then(() => {
      return {
        serialized: {
          game: this.cradle?.serialize(),
          working: this.working
        }
      };
    });
  }
}
