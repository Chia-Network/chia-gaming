import { WasmConnection, ChiaGame, CalpokerOutcome, WatchReport, InternalBlockchainInterface, WasmBlobParams, GameInitParams, JsCoinSetSpend } from '../types/ChiaGaming';
import { spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount, empty } from '../util';
import { Subject, NextObserver } from 'rxjs';

async function anempty(id: number) { return { "EMPTY": id }; }

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

export function getNewChiaGameCradle(wasmConnection: WasmConnection, params: GameInitParams) : ChiaGame {
    let cradleId = wasmConnection.create_game_cradle({
        // This is a JsGameCradleConfig, GameCradleConfig
        rng_id: params.rng.getId(),
        game_types: params.env.game_types,
        identity: params.chiaIdentity.private_key,
        have_potato: params.iStarted,
        my_contribution: {amt: params.myContribution},
        their_contribution: {amt: params.theirContribution},
        channel_timeout: params.env.timeout,
        unroll_timeout: params.env.unroll_timeout,
        reward_puzzle_hash: params.chiaIdentity.puzzle_hash,
    });
    console.log(`constructed cradle ${params.iStarted} with id ${cradleId} and publicKey ${params.chiaIdentity.public_key}`);

    let cradle = new ChiaGame(wasmConnection, cradleId);
    return cradle;
}

/*



      this.storedMessages.forEach((m) => {
        this.cradle.deliver_message(m);
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

*/

export class WasmBlobWrapper {
  startAGame: boolean = false;
  wasmConnection: WasmConnection;
  sendMessage: (msg: string) => void;
  cradle: ChiaGame;
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
  cardSelections: number;
  playerHand: number[][];
  opponentHand: number[][];
  finished: boolean;
  perGameAmount: number;
  gameOutcome: CalpokerOutcome | undefined;
  fetchHex: (path: string) => Promise<string>;
  rxjsMessageSingleon: Subject<any>;
  rxjsEmitter: NextObserver<any>;
  blockchain: InternalBlockchainInterface;

  constructor(params: WasmBlobParams, wasmConnection: WasmConnection, perGameAmount: number)
  {
    const deliverMessage = (msg: string) => {
      this.deliverMessage(msg);
    };

    this.cradle = params.cradle;
    this.wasmConnection = wasmConnection;
    this.uniqueId = params.uniqueId;
    this.iStarted = params.iStarted;
    this.fetchHex = params.fetchHex;
    this.blockchain = params.blockchain;

    // ----------------------------

    this.sendMessage = params.peerconn.sendMessage;
    this.currentBlock = 0;
    this.handlingMessage = false;
    this.handshakeDone = false;

    this.gameIds = [];
    this.myTurn = false;
    this.storedMessages = [];
    this.moveNumber = 0;
    this.messageQueue = [];
    this.cardSelections = 0;
    this.playerHand = [];
    this.opponentHand = [];
    this.finished = false;
    this.perGameAmount = perGameAmount;
    this.qualifyingEvents = 0;

    this.rxjsMessageSingleon = new Subject<any>();
    this.rxjsEmitter = {next: (evt: any) => {
      if (Object.keys(evt).length > 0 && !evt.stop) {
        console.log("rxjsEmitter", evt);
      }
      this.rxjsMessageSingleon.next(evt);
    }}
  }

  getObservable() {
    return this.rxjsMessageSingleon;
  }

  getHandshakeDone(): boolean { return this.handshakeDone; }

  kickSystem(flags: number) {
    let lastQE = this.qualifyingEvents;
    this.qualifyingEvents |= flags;
    if (this.qualifyingEvents == 3) {
      this.qualifyingEvents |= 4;
      this.rxjsEmitter.next({name: "ready"});
    }
    if (this.qualifyingEvents != lastQE) {
      console.log("qualifyingEvents:", this.qualifyingEvents);
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
        this.wasmConnection.deposit_file(nameAndContent.name, nameAndContent.content);
      });
      let newGameIdentity = this.cradle.getIdentity();
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

  private internalKickIdle(): any {
    let idle_info;
    do {
      idle_info = this.idle();
      if (!idle_info) {
        return idle_info;
      }
      this.rxjsEmitter.next(idle_info);
    } while (!idle_info.stop);
    return idle_info;
  }

  pushEvent(msg: any): any {
    if (this.finished) {
      return;
    }
    this.messageQueue.push(msg);
    return this.kickMessageHandling();
  }

  private handleOneMessage(msg: any): any {
    console.log('handleOneMessage', Object.keys(msg));
    if (msg.deliverMessage) {
      return this.internalDeliverMessage(msg.deliverMessage);
    } else if (msg.move) {
      return this.makeMove(msg.move);
    } else if (msg.takeOpponentMove) {
      let data = msg.takeOpponentMove;
      return this.takeOpponentMove(data.moveNumber, data.game_id, data.readable_move_hex);
    } else if (msg.takeGameMessage) {
      let data = msg.takeGameMessage;
      return this.takeGameMessage(data.moveNumber, data.game_id, data.readable_hex);
    } else if (msg.setCardSelections !== undefined) {
      return this.internalSetCardSelections(msg.setCardSelections);
    } else if (msg.startGame) {
      return this.internalStartGame();
    } else if (msg.shutDown) {
      return this.internalShutdown(msg.condition);
    } else if (msg.receivedShutdown) {
      return this.internalReceivedShutdown();
    } else if (msg.takeBlockData) {
      return this.internalTakeBlock(msg.takeBlockData.peak, msg.takeBlockData.block_report);
    }

    console.error("Unknown event:", msg);
    return anempty(218);
  }

  // TODO: Separate CalPoker method from Wasm code
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
      this.cradle.accept(this.gameIds[0]);
      console.log('did accept', this.iStarted);
      this.gameIds.pop();
    }

    result.setMoveNumber = this.moveNumber;
    return anempty(278).then(() => result);
  }

  takeGameMessage(moveNumber: number, game_id: string, readable_move_hex: string): any {
    const result = { };
    console.log('takeGameMessage', moveNumber, game_id, readable_move_hex);
    let p = decode_sexp_hex(readable_move_hex);
    this.updateCards(p, result);
    return anempty(286).then(() => result);
  }

  // TODO: fix me next
  kickMessageHandling(): any {
    if (this.messageQueue.length == 0 || this.handlingMessage) {
      return anempty(291);
    }
    this.handlingMessage = true;

    const msg = this.messageQueue.shift();

    //let result = null;
    return this.handleOneMessage(msg).then((result: any) => {
      console.log("kickMessageHandling: ", result);
      this.rxjsEmitter.next(result);

      this.internalKickIdle();

      this.handlingMessage = false;

      return this.kickMessageHandling();
    }).catch((e: any) => {
      console.error("THROWING in kickMessageHandling", e);
      this.handlingMessage = false;
      throw e;
    });
  }

  createStartCoin(): Promise<string | undefined> {
    const amount = this.cradle.getAmount();
    const identity = this.cradle.getIdentity();

    console.log(`create coin spendable by puzzle hash ${identity.puzzle_hash} for ${amount}`);
    return this
      .blockchain
      .do_initial_spend(this.uniqueId, identity.puzzle_hash, amount)
      .then(result =>
    {
        console.log("createStartCoin: result: ", result);
        let coin = result.coin;
        if (!coin) {
          throw new Error('tried to create spendable but failed');
        }

        // Handle data conversion back when Coin object was received.
        if (typeof coin !== 'string') {
          const coinset_coin = coin as any;
          console.log("createStartCoin coin: ", coin);
          console.log("createStartCoin coinset_coin: ", coinset_coin);
          const new_coin_string = this.wasmConnection.
            convert_coinset_to_coin_string(coinset_coin.parentCoinInfo, coinset_coin.puzzleHash, coinset_coin.amount.toString());
          if (!new_coin_string) {
            throw new Error(`Coin could not be converted to coinstring: ${JSON.stringify(coinset_coin)}`);
          }

          coin = new_coin_string;
        }
/*
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
        this.cradle = new ChiaGame(wc, env, this.rngSeed, identity, this.iStarted, this.amount, this.amount, result.fromPuzzleHash);
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
      */
        return coin;
    });
  }

  setStartCoin(coin: string) {
    this.cradle.opening_coin(coin);
  }

  deliverMessage(msg: string) {
    this.pushEvent({ deliverMessage: msg });
  }

  getStoredMessages() {
    return this.storedMessages;
  }

  internalDeliverMessage(msg: string): any {
    if (!this.cradle) {
      this.storedMessages.push(msg);
      return anempty(390);
    }
    console.log('deliver message', msg);
    this.cradle.deliver_message(msg);
    return anempty(394);
  }

  startGame(): void {
    this.startAGame = true;
    if (this.handshakeDone) {
      this.pushEvent({startGame: true});
    }
  }

  private internalStartGame(): any {
    let result: any = {};
    let amount = this.cradle.getAmount();
    let gids = this.cradle.start_games(!this.iStarted, {
      game_type: "63616c706f6b6572",
      timeout: 100,
      amount: this.perGameAmount,
      my_contribution: this.perGameAmount / 2,
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
    return anempty(423).then(() => result);
  }

  idle(): any {
    const result: any = {};
    const idle = this.cradle.idle({
      // Local ui callbacks.
      opponent_moved: (game_id, readable_move_hex) => {
        console.error('got opponent move', game_id, readable_move_hex);
        this.messageQueue.push({ takeOpponentMove: { game_id, readable_move_hex, moveNumber: this.moveNumber } });
      },
      game_message: (game_id, readable_hex) => {
        console.error('got opponent msg', game_id, readable_hex);
        this.messageQueue.push({ takeGameMessage: { game_id, readable_hex, moveNumber: this.moveNumber } });
      },
      game_started: (game_ids, failed) => {
        console.log('got game start', game_ids, failed);

        if (failed) {
          console.log('game start failed', failed);
          this.messageQueue.push({ shutDown: true, condition: failed });
        }
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
      return { stop: true }; // TODO msg type (if possible)
    }

    if (idle.finished && !this.finished) {
      console.error('we shut down');
      this.finished = true;
      this.rxjsEmitter.next({
        setGameConnectionState: {
          stateIdentifier: "shutdown",
          stateDetail: []
        },
        outcome: undefined
      });
      this.messageQueue.push({ receivedShutdown: true });  // TODO msg type (if possible)
      return result;
    }

    result.stop = !idle.continue_on;

    if (result.setError) {
      return result;
    }

    result.setError = idle.receive_error;
    // console.log('idle1', idle.action_queue);
    if (idle.handshake_done && !this.handshakeDone) {
      console.warn("HANDSHAKE DONE");
      this.handshakeDone = true;
      result.setGameConnectionState = {
        stateIdentifier: "running",
        stateDetail: []
      };
      console.log("starting games", this.iStarted);
      if (this.startAGame) {
        this.pushEvent({ startGame: true });
      }
    }

    // console.log('idle2', idle.incoming_messages);
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
        return this.wasmConnection.convert_spend_to_coinset_org(blob);
      };
      this.blockchain.spend(cvt, blob).then(res => {
        console.log('spend res', res);
      });
    }

    return result;
  }

  generateEntropy() {
    let hexDigits = [];
    for (let i = 0; i < 16; i++) {
      hexDigits.push(Math.floor(Math.random() * 16)).toString(16);
    }
    let entropy = this.wasmConnection.sha256bytes(hexDigits.join(""));
    if (!entropy) {
      throw 'tried to make entropy without a wasm connection';
    }
    return entropy;
  }

  isHandshakeDone(): boolean { return this.handshakeDone; }

  async makeMove(move: any): Promise<any> {
    if (!this.handshakeDone) {
      // TODO: Let's return more status info here
      console.log("makeMove: this.handshakeDone=",this.handshakeDone)
      return {handshakeDone: true};
    } else if (this.moveNumber === 0) {
      let entropy = this.generateEntropy();
      console.log('move 0 with entropy', entropy);
      this.cradle.make_move_entropy(this.gameIds[0], "80", entropy);
      console.log("finished call to this.cradle.make_move_entropy");
      this.moveNumber += 1;
      return {
        setMyTurn: false,
        setMoveNumber: this.moveNumber
      };
    } else if (this.moveNumber === 1) {
      if (popcount(this.cardSelections) != 4) {
        return anempty(564);
      }
      this.moveNumber += 1;
      let entropy = this.generateEntropy();
      const encoded = (this.cardSelections | 0x8100).toString(16);
      this.cradle.make_move_entropy(this.gameIds[0], encoded, entropy);
      return {
        setMyTurn: false,
        setMoveNumber: this.moveNumber
      };
    } else if (this.moveNumber === 2) {
      this.moveNumber += 1;
      let entropy = this.generateEntropy();
      this.cradle.make_move_entropy(this.gameIds[0], '80', entropy);
      return {
        setMyTurn: false,
        setMoveNumber: this.moveNumber,
        setGameConnectionState: {
          stateIdentifier: "end",
          stateDetail: []
        }
      };
    }

    throw `Don't yet know what to do for move ${this.moveNumber}`;
  }

  //makeMoveImmediate
  internalMakeMove(move: any) {
    this.pushEvent({ move });
  }

  setCardSelections(mask: number) {
    this.pushEvent({ setCardSelections: mask });
  }

  internalSetCardSelections(mask: number): any {
    const result = { setCardSelections: mask };
    this.cardSelections = mask;
    return anempty(603).then(() => result);
  }

  shutDown(condition: string | undefined) {
    this.pushEvent({ shutDown: true, condition });
  }

  internalShutdown(condition: string) {
    const details: string[] = [];
    if (condition) {
      details.push(condition);
    }
    const result: any = {
      setGameConnectionState: {
        stateIdentifier: "shutdown",
        stateDetail: details
      },
      outcome: undefined
    };
    console.log('shutting down cradle');
    this.cradle?.shut_down();
    return anempty(624).then(() => result);
  }

  internalTakeBlock(peak: number, block_report: WatchReport): any {
    // console.log('internalTakeBlock', peak, block_report);
    this.cradle.block_data(peak, block_report);
    // console.log('took block', peak);
    return anempty(631);
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
    return anempty(643).then(() => result);
  }

  blockNotification(peak: number, blocks: JsCoinSetSpend[] | undefined, block_report: any) {
    if (block_report === undefined) {
      block_report = {
        created_watched: [],
        deleted_watched: [],
        timed_out: []
      };

      if (blocks) {
        for (var b = 0; b < blocks.length; b++) {
          const block = blocks[b];
          const one_report: WatchReport = this.wasmConnection.convert_coinset_org_block_spend_to_watch_report(
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
    }
    this.kickSystem(2);
    this.pushEvent({ takeBlockData: {
      peak: peak,
      block_report: block_report
    }});
  }
}
