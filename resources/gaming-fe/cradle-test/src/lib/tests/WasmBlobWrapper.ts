import { WasmConnection, GameCradleConfig, IChiaIdentity, GameConnectionState, ExternalBlockchainInterface, ChiaGame, CalpokerOutcome, PeerConnectionResult } from '../../types/ChiaGaming';
import { getSearchParams, spend_bundle_to_clvm, decode_sexp_hex, proper_list, popcount } from '../../util';
import { v4 as uuidv4 } from 'uuid';


function stateChanger(state_info: any) {}
async function empty() {
  return {};
}

export class WasmBlobWrapper {
    amount: number;
    iStarted: boolean;
    cradle: ChiaGame | undefined;
    wc: WasmConnection | undefined;
    //sendMessage: (msg: string) => void;
    //gameOutcome: CalpokerOutcome | undefined;
    handlingMessage: boolean;
    // deliverMessage:
    //currentBlock: number;
    messageQueue: any[];
    doInternalLoadWasm: () => any;
    identity: IChiaIdentity | undefined;
    finished: boolean;
    qualifyingEvents: number;
    stateChanger: (state_info: any) => void;
    rngSeed: string;
    loadWasmEvent: any | undefined;

    constructor (blockchain:  ExternalBlockchainInterface, uniqueId: string, amount: number, iStarted: boolean,
        doInternalLoadWasm: () => ArrayBuffer, stateChanger: (state_info: any) => void
    ) {
        this.amount = amount;
        // this.uniqueId = uniqueId; Needed yet?
        this.iStarted = iStarted;
        this.handlingMessage = false;
        this.messageQueue = [];
        this.doInternalLoadWasm = doInternalLoadWasm;
        this.finished = false;
        this.qualifyingEvents = 0;
        this.stateChanger = stateChanger;
        this.rngSeed = "";
    }
    internalLoadWasm(chia_gaming_init: any, cg: WasmConnection): any {
        // const modData = doInternalLoadWasm();
    }

    kickMessageHandling(): any {
        if (this.messageQueue.length == 0 || this.handlingMessage) {
            return empty();
        }
    }

    kickSystem(flags: number) {
        this.qualifyingEvents |= flags;
        if (this.qualifyingEvents == 3) {
            this.qualifyingEvents |= 4;
            this.pushEvent(this.loadWasmEvent);
        }
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

    loadWasm(chia_gaming_init: any, cg: WasmConnection): any {
        this.loadWasmEvent = { loadWasmEvent: { chia_gaming_init, cg } };
        this.kickSystem(1);
        return empty();
    }
//   handleOneMessage(msg: any): any {
//   }

  // load chia .hex files
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
        }
    }

    idle(): any {
    //     const result: any = {};
    //     const idle = this.cradle?.idle({
    //     // Local ui callbacks.
    //     opponent_moved: (game_id, readable_move_hex) => {
    //         console.error('got opponent move', game_id, readable_move_hex);
    //         this.messageQueue.push({ takeOpponentMove: { game_id, readable_move_hex, moveNumber: this.moveNumber } });
    //     },
    //     game_message: (game_id, readable_hex) => {
    //         console.error('got opponent msg', game_id, readable_hex);
    //         this.messageQueue.push({ takeGameMessage: { game_id, readable_hex, moveNumber: this.moveNumber } });
    //     },
    //     game_finished: (game_id, amount) => {
    //         // Signals accept.
    //         this.gameIds.pop();
    //         console.log('got accept', this.iStarted);

    //         this.myTurn = false;
    //         this.cardSelections = 0;
    //         this.moveNumber = 0;
    //         this.playerHand = [];
    //         this.opponentHand = [];

    //         result.setCardSelections = 0;
    //         result.setMoveNumber = 0;
    //         result.setPlayerHand = [];
    //         result.setOpponentHand = [];
    //         result.setOutcome = undefined;
    //         result.setGameConnectionState = {
    //         stateIdentifier: "running",
    //         stateDetail: []
    //         };

    //         result.setMyTurn = false;
    //         this.messageQueue.push({ startGame: true });
    //     }
    // });

    // if (!idle || this.finished) {
    //   return { stop: true };
    // }

    // if (idle.finished && !this.finished) {
    //   console.error('we shut down');
    //   this.finished = true;
    //   this.stateChanger({
    //     setGameConnectionState: {
    //       stateIdentifier: "shutdown",
    //       stateDetail: []
    //     },
    //     outcome: undefined
    //   });
    //   this.messageQueue.push({ receivedShutdown: true });
    //   return result;
    // }

    // result.stop = !idle.continue_on;

    // result.setError = idle.receive_error;
    // console.log('idle1', idle.action_queue);
    // if (idle.handshake_done && !this.handshakeDone) {
    //   console.warn("HANDSHAKE DONE");
    //   this.handshakeDone = true;
    //   result.setGameConnectionState = {
    //     stateIdentifier: "running",
    //     stateDetail: []
    //   };
    //   console.log("starting games", this.iStarted);
    //   this.pushEvent({ startGame: true });
    // }

    // console.log('idle2', idle.incoming_messages);
    // for (let i = 0; i < idle.outbound_messages.length; i++) {
    //   console.log('send message to remote');
    //   this.sendMessage(idle.outbound_messages[i]);
    // }

    // for (let i = 0; i < idle.outbound_transactions.length; i++) {
    //   const tx = idle.outbound_transactions[i];
    //   console.log('send transaction', tx);
    //   // Compose blob to spend
    //   let blob = spend_bundle_to_clvm(tx);
    //   this.blockchain.spend(blob).then(res => {
    //     console.log('spend res', res);
    //   });
    // }

    // return result;
  }

}