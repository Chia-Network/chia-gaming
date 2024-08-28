use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::stdin;
use std::mem::swap;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::thread;

use num_bigint::{BigInt, Sign, ToBigInt};
use num_traits::cast::ToPrimitive;

use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_tools_rs::compiler::sexp::decode_string;
use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::serde::node_to_bytes;
use clvmr::NodePtr;

use lazy_static::lazy_static;
use log::debug;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use salvo::http::ResBody;
use salvo::hyper::body::Bytes;
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use chia_gaming::channel_handler::types::ReadableMove;
use chia_gaming::common::standard_coin::ChiaIdentity;
use chia_gaming::common::types::{
    atom_from_clvm, divmod, i32_from_atom, usize_from_atom, AllocEncoder, Amount, CoinString,
    Error, GameID, Hash, PrivateKey, Program, Sha256Input, Timeout,
};
use chia_gaming::games::poker_collection;
use chia_gaming::games::calpoker::{CalpokerResult, make_cards, decode_calpoker_readable};
use chia_gaming::outside::{GameStart, GameType, ToLocalUI};
use chia_gaming::peer_container::{
    FullCoinSetAdapter, GameCradle, SynchronousGameCradle, SynchronousGameCradleConfig,
};
use chia_gaming::simulator::Simulator;

struct UIReceiver {
    received_moves: usize,
    our_readable_move: Vec<u8>,
    remote_message: Vec<u8>,
    opponent_readable_move: ReadableMove,
}

impl UIReceiver {
    fn new(allocator: &mut AllocEncoder) -> Self {
        UIReceiver {
            received_moves: 0,
            our_readable_move: Vec::default(),
            remote_message: Vec::default(),
            opponent_readable_move: ReadableMove::from_nodeptr(allocator.encode_atom(&[]).unwrap()),
        }
    }
}

impl ToLocalUI for UIReceiver {
    fn self_move(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.our_readable_move = readable.to_vec();
        Ok(())
    }

    fn opponent_moved(&mut self, _id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        self.received_moves += 1;
        self.our_readable_move = Vec::default();
        self.opponent_readable_move = readable;
        Ok(())
    }

    fn game_message(&mut self, _id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.remote_message = readable.to_vec();
        Ok(())
    }

    fn game_finished(&mut self, _id: &GameID, _my_share: Amount) -> Result<(), Error> {
        Ok(())
    }

    fn game_cancelled(&mut self, _id: &GameID) -> Result<(), Error> {
        todo!();
    }

    fn shutdown_complete(&mut self, _reward_coin_string: &CoinString) -> Result<(), Error> {
        todo!();
    }

    fn going_on_chain(&mut self) -> Result<(), Error> {
        todo!();
    }
}

#[derive(Debug, Clone, Serialize)]
enum PlayState {
    BeforeAliceWord,
    BeforeAlicePicks,
    BeforeFinish,
    AliceFinish1,
    AliceEnd,

    BobWaiting,
    WaitingForAliceWord,
    WaitingForAlicePicks,
    BobFinish1,
    BobEnd,
}

struct CardsDescription {
    state: usize,
    cards: Vec<(usize, usize)>,
}

#[allow(dead_code)]
struct GameRunner {
    allocator: AllocEncoder,
    rng: ChaCha8Rng,

    game_type_map: BTreeMap<GameType, Program>,

    neutral_identity: ChiaIdentity,
    identities: [ChiaIdentity; 2],
    coinset_adapter: FullCoinSetAdapter,
    local_uis: [UIReceiver; 2],

    simulator: Simulator,
    cradles: [SynchronousGameCradle; 2],
    play_states: [PlayState; 2],
    game_ids: Vec<GameID>,

    fund_coins: [CoinString; 2],
    preimage: [Vec<u8>; 2],
    bob_word: [Vec<u8>; 2],
    picks: [Vec<bool>; 2],
    finish_move: [bool; 2],
    game_outcomes: [CalpokerResult; 2],
    handshake_done: bool,
    can_move: bool,
    funded: bool,

    auto: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UpdateResult {
    info: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlayerResult {
    can_move: bool,
    state: String,
    auto: bool,
    our_move: Vec<u8>,
    opponent_message: Vec<u8>,
    readable: Value,
}

#[derive(Debug, Clone)]
enum WebRequest {
    Idle,
    Reset,
    Player(bool),
    AliceWordHash(Vec<u8>),
    BobWord(Vec<u8>),
    AlicePicks(Vec<bool>),
    BobPicks(Vec<bool>),
    FinishMove(bool),
}

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new().unwrap());
    static ref TO_WEB: (Mutex<Sender<WebRequest>>, Mutex<Receiver<WebRequest>>) = {
        let (tx, rx) = mpsc::channel();
        (tx.into(), rx.into())
    };
    static ref FROM_WEB: (
        Mutex<Sender<Result<String, String>>>,
        Mutex<Receiver<Result<String, String>>>
    ) = {
        let (tx, rx) = mpsc::channel();
        (tx.into(), rx.into())
    };
}

impl GameRunner {
    fn new() -> Result<Self, Error> {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);
        let game_type_map = poker_collection(&mut allocator);

        let neutral_pk: PrivateKey = rng.gen();
        let neutral_identity = ChiaIdentity::new(&mut allocator, neutral_pk).expect("should work");

        let pk1: PrivateKey = rng.gen();
        let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("should work");
        let pk2: PrivateKey = rng.gen();
        let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("should work");

        let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
        let coinset_adapter = FullCoinSetAdapter::default();
        let ui1 = UIReceiver::new(&mut allocator);
        let ui2 = UIReceiver::new(&mut allocator);
        let local_uis = [ui1, ui2];
        let simulator = Simulator::default();

        // Give some money to the users.
        simulator.farm_block(&identities[0].puzzle_hash);
        simulator.farm_block(&identities[1].puzzle_hash);

        let coins0 = simulator
            .get_my_coins(&identities[0].puzzle_hash)
            .expect("should work");
        let coins1 = simulator
            .get_my_coins(&identities[1].puzzle_hash)
            .expect("should work");

        // Make a 100 coin for each player (and test the deleted and created events).
        let (parent_coin_0, _rest_0) = simulator
            .transfer_coin_amount(
                &mut allocator,
                &identities[0],
                &identities[0],
                &coins0[0],
                Amount::new(100),
            )
            .expect("should work");
        let (parent_coin_1, _rest_1) = simulator
            .transfer_coin_amount(
                &mut allocator,
                &identities[1],
                &identities[1],
                &coins1[0],
                Amount::new(100),
            )
            .expect("should work");

        simulator.farm_block(&neutral_identity.puzzle_hash);

        let cradle1 = SynchronousGameCradle::new(
            &mut rng,
            SynchronousGameCradleConfig {
                game_types: game_type_map.clone(),
                have_potato: true,
                identity: &identities[0],
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(100),
                reward_puzzle_hash: id1.puzzle_hash.clone(),
            },
        );
        let cradle2 = SynchronousGameCradle::new(
            &mut rng,
            SynchronousGameCradleConfig {
                game_types: game_type_map.clone(),
                have_potato: false,
                identity: &identities[1],
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(100),
                reward_puzzle_hash: id2.puzzle_hash.clone(),
            },
        );
        let cradles = [cradle1, cradle2];
        let game_ids = Vec::default();
        let handshake_done = false;
        let can_move = false;

        Ok(GameRunner {
            allocator,
            rng,
            game_type_map,
            neutral_identity,
            identities,
            coinset_adapter,
            local_uis,
            simulator,
            cradles,
            game_ids,
            handshake_done,
            can_move,
            funded: false,
            fund_coins: [parent_coin_0.clone(), parent_coin_1.clone()],
            play_states: [PlayState::BeforeAliceWord, PlayState::BobWaiting],
            preimage: [vec![], vec![]],
            bob_word: [vec![], vec![]],
            picks: [vec![], vec![]],
            game_outcomes: [CalpokerResult::default(), CalpokerResult::default()],
            finish_move: [false, false],
            auto: false,
        })
    }

    fn set_auto(&mut self, new_auto: bool) {
        self.auto = new_auto;
    }

    fn info(&self) -> Value {
        let mut r = Map::default();
        r.insert(
            "block_height".to_string(),
            serde_json::to_value(self.coinset_adapter.current_height).unwrap(),
        );
        r.insert(
            "handshake_done".to_string(),
            serde_json::to_value(self.handshake_done).unwrap(),
        );
        r.insert(
            "can_move".to_string(),
            serde_json::to_value(self.can_move).unwrap(),
        );
        r.insert(
            "alice_state".to_string(),
            serde_json::to_value(&self.play_states[0]).unwrap(),
        );
        r.insert(
            "bob_state".to_string(),
            serde_json::to_value(&self.play_states[1]).unwrap(),
        );
        Value::Object(r)
    }

    fn convert_cards(&mut self, card_list: NodePtr) -> Vec<(usize, usize)> {
        if let Some(cards_nodeptrs) = proper_list(self.allocator.allocator(), card_list, true) {
            return cards_nodeptrs
                .iter()
                .filter_map(|elt| {
                    proper_list(self.allocator.allocator(), *elt, true).map(|card| {
                        let rank: usize = atom_from_clvm(&mut self.allocator, card[0])
                            .and_then(usize_from_atom)
                            .unwrap_or_default();
                        let suit: usize = atom_from_clvm(&mut self.allocator, card[1])
                            .and_then(usize_from_atom)
                            .unwrap_or_default();
                        (rank, suit)
                    })
                })
                .collect();
        }

        Vec::new()
    }

    // Produce the state result for when a move is possible.
    fn move_state(&self) -> String {
        serde_json::to_string(&UpdateResult { info: self.info() }).unwrap()
    }

    fn bob_readable(&mut self, id: bool) -> Result<Value, String> {
        // See if we have enough info to get the cardlists.
        if !self.local_uis[id as usize].remote_message.is_empty() {
            // make_cards
            serde_json::to_value(make_cards(
                &self.local_uis[id as usize].remote_message,
                &self.preimage[id as usize],
                self.cradles[id as usize].amount(),
            ))
            .map_err(|e| format!("failed make cards: {:?}", e))
        } else {
            let empty_vec: Vec<(usize, usize)> = vec![];
            serde_json::to_value(
                // (
                // self.convert_cards(
                //     self.local_uis[id as usize]
                //         .opponent_readable_move
                //         .to_nodeptr(),
                // ),
                // empty_vec.clone(),
                // empty_vec,
                // )
                empty_vec,
            )
            .map_err(|e| format!("couldn't make basic bob result: {e:?}"))
        }
    }

    fn player_readable(&mut self, id: bool) -> Result<Value, String> {
        match &self.play_states[id as usize] {
            PlayState::BeforeAlicePicks => {
                let cardlist: Vec<Vec<(usize, usize)>> = if let Some(cardlist) = proper_list(
                    self.allocator.allocator(),
                    self.local_uis[id as usize]
                        .opponent_readable_move
                        .to_nodeptr(),
                    true,
                ) {
                    cardlist.iter().map(|c| self.convert_cards(*c)).collect()
                } else {
                    return Err("wrong decode of two card sets".to_string());
                };

                serde_json::to_value(cardlist).map_err(|e| format!("couldn't make json: {e:?}"))
            }
            PlayState::WaitingForAlicePicks => self.bob_readable(id),
            PlayState::AliceFinish1 => {
                serde_json::to_value(&self.game_outcomes[id as usize]).map_err(|e| format!("couldn't make json: {e:?}"))
            },
            PlayState::AliceEnd => {
                serde_json::to_value(&self.game_outcomes[id as usize]).map_err(|e| format!("couldn't make json: {e:?}"))
            },
            PlayState::BobEnd => {
                serde_json::to_value(&self.game_outcomes[id as usize]).map_err(|e| format!("couldn't make json: {e:?}"))
            },
            _ => Ok(Value::String(disassemble(
                self.allocator.allocator(),
                self.local_uis[id as usize]
                    .opponent_readable_move
                    .to_nodeptr(),
                None,
            ))),
        }
    }

    fn player(&mut self, id: bool) -> Result<String, String> {
        let player_readable = self.player_readable(id)?;
        serde_json::to_string(&PlayerResult {
            can_move: self.can_move,
            state: format!("{:?}", self.play_states[id as usize]),
            our_move: self.local_uis[id as usize].our_readable_move.to_vec(),
            auto: self.auto,
            opponent_message: self.local_uis[id as usize].remote_message.clone(),
            readable: player_readable,
        })
        .map_err(|e| format!("error serializing player state: {e:?}"))
    }

    fn alice_word_hash(&mut self, hash: &[u8]) -> String {
        self.play_states[0] = PlayState::BeforeAlicePicks;

        let encoded_node = self.allocator.encode_atom(hash).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        eprintln!("alice word hash {hash:?}");
        self.cradles[0]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
                Hash::from_slice(hash),
            )
            .unwrap();

        self.move_state()
    }

    fn enact_bob_word(&mut self) {
        if !self.bob_word[1].is_empty() {
            let encoded_node = self.allocator.encode_atom(&self.bob_word[1]).unwrap();
            let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
            let new_entropy = Hash::from_slice(&self.bob_word[1]);
            self.bob_word[1].clear();
            eprintln!("enact_bob_word {:?}", new_entropy);
            self.cradles[1]
                .make_move(
                    &mut self.allocator,
                    &mut self.rng,
                    &self.game_ids[0],
                    encoded,
                    new_entropy,
                )
                .unwrap();
        }
    }

    fn bob_word_hash(&mut self, word: &[u8]) -> String {
        self.preimage[1] = word.to_vec();
        self.bob_word[1] = word.to_vec();

        self.enact_bob_word();

        self.move_state()
    }

    fn alice_picks(&mut self, picks: &[bool]) -> String {
        let encoded_node = picks.to_clvm(&mut self.allocator).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        let new_entropy = self.rng.gen();
        eprintln!("alice picks");
        self.cradles[0]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
                new_entropy,
            )
            .unwrap();

        self.move_state()
    }

    fn enact_bob_picks(&mut self) {
        if !self.picks[1].is_empty() && matches!(self.play_states[1], PlayState::BobFinish1) {
            let encoded_node = self.picks[1].to_clvm(&mut self.allocator).unwrap();
            let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
            let mut work: Vec<bool> = vec![];
            swap(&mut work, &mut self.picks[1]);
            let new_entropy = self.rng.gen();
            eprintln!("enact_bob_picks");
            self.cradles[1]
                .make_move(
                    &mut self.allocator,
                    &mut self.rng,
                    &self.game_ids[0],
                    encoded,
                    new_entropy,
                )
                .unwrap();
        }
    }

    fn bob_picks(&mut self, picks: &[bool]) -> String {
        self.picks[1] = picks.to_vec();
        self.enact_bob_picks();
        "{}".to_string()
    }

    fn finish_move(&mut self, pid: bool) -> String {
        eprintln!("enable finish move {pid}");
        self.finish_move[pid as usize] = true;
        "{}".to_string()
    }

    fn idle(&mut self) -> Result<String, String> {
        self.simulator
            .farm_block(&self.neutral_identity.puzzle_hash);

        let current_height = self.simulator.get_current_height();
        let current_coins = self.simulator.get_all_coins().expect("should work");
        let watch_report = self
            .coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)
            .expect("should work");

        for i in 0..=1 {
            self.cradles[i]
                .new_block(
                    &mut self.allocator,
                    &mut self.rng,
                    current_height,
                    &watch_report,
                )
                .expect("should work");

            loop {
                let result = self.cradles[i]
                    .idle(&mut self.allocator, &mut self.rng, &mut self.local_uis[i])
                    .map_err(|e| format!("{e:?}"))?;
                debug!(
                    "cradle {i}: continue_on {} outbound {}",
                    result.continue_on,
                    result.outbound_messages.len()
                );

                for tx in result.outbound_transactions.iter() {
                    let included_result = self
                        .simulator
                        .push_tx(&mut self.allocator, &tx.spends)
                        .expect("should work");
                    debug!("included_result {included_result:?}");
                    assert_eq!(included_result.code, 1);
                }

                for msg in result.outbound_messages.iter() {
                    self.cradles[i ^ 1]
                        .deliver_message(&msg)
                        .expect("should work");
                }

                if !result.continue_on {
                    break;
                }
            }
        }

        if !self.funded {
            // Give coins to the cradles.
            self.cradles[0]
                .opening_coin(
                    &mut self.allocator,
                    &mut self.rng,
                    self.fund_coins[0].clone(),
                )
                .expect("should work");
            self.cradles[1]
                .opening_coin(
                    &mut self.allocator,
                    &mut self.rng,
                    self.fund_coins[1].clone(),
                )
                .expect("should work");

            self.funded = true;

            return serde_json::to_string(&UpdateResult { info: self.info() })
                .map_err(|e| format!("{e:?}"));
        }

        if self.can_move {
            for i in 0..=1 {
                debug!(
                    "{i} play state {:?} received_moves {:?} our_move {:?} opponent_message {:?}",
                    self.play_states[i],
                    self.local_uis[i].received_moves,
                    self.local_uis[i].our_readable_move,
                    self.local_uis[i].remote_message
                );

                if self.local_uis[i].received_moves == 0 {
                    continue;
                } else if i == 0 && self.local_uis[i].received_moves == 1 {
                    self.play_states[i] = PlayState::BeforeAlicePicks;
                } else if i == 1 && self.local_uis[i].received_moves == 1 {
                    self.play_states[i] = PlayState::WaitingForAlicePicks;
                } else if i == 0 && self.local_uis[i].received_moves == 2 {
                    self.play_states[i] = PlayState::AliceFinish1;
                    // Decode our win state.
                    self.game_outcomes[i] = decode_calpoker_readable(&mut self.allocator, self.local_uis[i].opponent_readable_move.to_nodeptr(), self.cradles[i].amount(), i == 0).unwrap();
                    if self.finish_move[i] {
                        eprintln!("enacting alice finish move");
                        self.finish_move[i] = false;
                        let new_entropy = self.rng.gen();
                        self.cradles[i]
                            .make_move(
                                &mut self.allocator,
                                &mut self.rng,
                                &self.game_ids[0],
                                vec![0x80],
                                new_entropy,
                            )
                            .unwrap();
                    }
                } else if i == 1 && self.local_uis[i].received_moves == 2 {
                    self.play_states[i] = PlayState::BobFinish1;
                } else if i == 0 && self.local_uis[i].received_moves == 3 {
                    self.play_states[i] = PlayState::AliceEnd;
                    // Decode our win state.
                } else if i == 1 && self.local_uis[i].received_moves == 3 {
                    self.play_states[i] = PlayState::BobEnd;
                    if let Some(res) = decode_calpoker_readable(&mut self.allocator, self.local_uis[i].opponent_readable_move.to_nodeptr(), self.cradles[i].amount(), i == 0).ok() {
                        if res.raw_alice_selects != 0 {
                            self.game_outcomes[i] = res;
                        }
                    }
                } else {
                    debug!("unknown state?");
                }
            }

            // Release bob word if we're at the right state.
            if matches!(self.play_states[1], PlayState::WaitingForAlicePicks)
                && self.cradles[1].has_potato()
            {
                self.enact_bob_word();
            }

            return Ok(self.move_state());
        }

        if !self.handshake_done
            && self.cradles[0].handshake_finished()
            && self.cradles[1].handshake_finished()
        {
            self.game_ids = self.cradles[0]
                .start_games(
                    &mut self.allocator,
                    &mut self.rng,
                    true,
                    &GameStart {
                        amount: Amount::new(200),
                        my_contribution: Amount::new(100),
                        game_type: GameType(b"calpoker".to_vec()),
                        timeout: Timeout::new(10),
                        my_turn: true,
                        parameters: vec![0x80],
                    },
                )
                .expect("should run");

            self.cradles[1]
                .start_games(
                    &mut self.allocator,
                    &mut self.rng,
                    false,
                    &GameStart {
                        amount: Amount::new(200),
                        my_contribution: Amount::new(100),
                        game_type: GameType(b"calpoker".to_vec()),
                        timeout: Timeout::new(10),
                        my_turn: false,
                        parameters: vec![0x80],
                    },
                )
                .expect("should run");

            self.can_move = true;
            self.handshake_done = true;
        }

        serde_json::to_string(&UpdateResult { info: self.info() }).map_err(|e| format!("{e:?}"))
    }
}

fn get_file(name: &str, content_type: &str, response: &mut Response) -> Result<(), String> {
    let content = fs::read_to_string(name).map_err(|e| format!("{e:?}"))?;
    response
        .add_header("Content-Type", content_type, true)
        .map_err(|e| format!("{e:?}"))?;
    response.replace_body(ResBody::Once(Bytes::from(content.as_bytes().to_vec())));
    Ok(())
}

#[handler]
async fn index(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.html", "text/html", response)
}

#[handler]
async fn player_html(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/player.html", "text/html", response)
}

#[handler]
async fn index_js(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.js", "text/javascript", response)
}

#[handler]
async fn player_js(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/player.js", "text/javascript", response)
}

#[handler]
async fn index_css(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.css", "text/css", response)
}

fn pass_on_request(wr: WebRequest) -> Result<String, String> {
    {
        let to_web = TO_WEB.0.lock().unwrap();
        (*to_web).send(wr).unwrap();
    }
    let from_web = FROM_WEB.1.lock().unwrap();
    (*from_web).recv().map_err(|e| format!("{e:?}"))?
}

#[handler]
async fn idle(_req: &mut Request) -> Result<String, String> {
    pass_on_request(WebRequest::Idle)
}

fn get_arg_bytes(req: &mut Request) -> Result<Vec<u8>, String> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<u8> = uri_string.bytes().skip(found_eq + 1).collect();
        return Ok(arg);
    }

    Err("no argument".to_string())
}

#[handler]
async fn player(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    let pid = if arg.is_empty() {
        false
    } else {
        arg[0] == b'2'
    };
    pass_on_request(WebRequest::Player(pid))
}

#[handler]
async fn alice_word_hash(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    if arg.is_empty() {
        return Err("empty arg".to_string());
    }
    let player_id = arg[0] == b'2';
    let hash = Sha256Input::Bytes(&arg[1..]).hash();
    let hash_of_alice_hash = Sha256Input::Bytes(hash.bytes()).hash();
    eprintln!("alice hash is {hash:?} hash of that is {hash_of_alice_hash:?}");
    pass_on_request(WebRequest::AliceWordHash(hash.bytes().to_vec()))
}

#[handler]
async fn bob_word_hash(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    if arg.is_empty() {
        return Err("empty arg".to_string());
    }
    let player_id = arg[0] == b'2';
    let hash = Sha256Input::Bytes(&arg[1..]).hash();
    eprintln!("bob hash is {hash:?}");
    pass_on_request(WebRequest::BobWord(hash.bytes().to_vec()))
}

#[handler]
async fn alice_picks(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    let bool_arg: Vec<bool> = arg.iter()
        .skip(1)
        .map(|b| *b == b'1')
        .collect();
    pass_on_request(WebRequest::AlicePicks(bool_arg))
}

#[handler]
async fn bob_picks(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    let bool_arg: Vec<bool> = arg.iter()
        .skip(1)
        .map(|b| *b == b'1')
        .collect();
    pass_on_request(WebRequest::BobPicks(bool_arg))
}

#[handler]
async fn exit(_req: &mut Request) -> Result<String, String> {
    std::process::exit(0);
    Ok("done".to_string())
}

#[handler]
async fn reset(_req: &mut Request) -> Result<String, String> {
    return pass_on_request(WebRequest::Reset);
}

#[handler]
async fn finish(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req)?;
    let player_id =
        if arg.is_empty() {
            false
        } else {
            arg[0] == b'2'
        };
    pass_on_request(WebRequest::FinishMove(player_id))
}

fn reset_sim(sim: &mut GameRunner, auto: bool) -> Result<String, String> {
    let mut new_game = GameRunner::new().map_err(|e| format!("{e:?}"))?;
    if auto {
        new_game.set_auto(true);
    }
    swap(sim, &mut new_game);
    Ok("{}".to_string())
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args();
    let auto = args.any(|x| x == "auto");

    let router = Router::new()
        .get(index)
        .push(Router::with_path("index.css").get(index_css))
        .push(Router::with_path("index.js").get(index_js))
        .push(Router::with_path("player.html").get(player_html))
        .push(Router::with_path("player.js").get(player_js))
        .push(Router::with_path("exit").post(exit))
        .push(Router::with_path("reset").post(reset))
        .push(Router::with_path("idle.json").post(idle))
        .push(Router::with_path("player.json").post(player))
        .push(Router::with_path("alice_word_hash").post(alice_word_hash))
        .push(Router::with_path("bob_word_hash").post(bob_word_hash))
        .push(Router::with_path("alice_picks").post(alice_picks))
        .push(Router::with_path("bob_picks").post(bob_picks))
        .push(Router::with_path("finish").post(finish));
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;

    let s = std::thread::spawn(move || {
        if auto {
            let mut locked = MUTEX.lock().unwrap();
            (*locked).set_auto(true);
        }

        loop {
            let request = {
                let channel = TO_WEB.1.lock().unwrap();
                (*channel).recv().unwrap()
            };

            debug!("request {request:?}");
            let result = {
                let mut locked = MUTEX.lock().unwrap();
                match request {
                    WebRequest::Idle => (*locked).idle(),
                    WebRequest::Player(id) => (*locked).player(id),
                    WebRequest::AliceWordHash(hash) => Ok((*locked).alice_word_hash(&hash)),
                    WebRequest::BobWord(bytes) => Ok((*locked).bob_word_hash(&bytes)),
                    WebRequest::AlicePicks(picks) => Ok((*locked).alice_picks(&picks)),
                    WebRequest::BobPicks(picks) => Ok((*locked).bob_picks(&picks)),
                    WebRequest::FinishMove(id) => Ok((*locked).finish_move(id)),
                    WebRequest::Reset => reset_sim(&mut (*locked), auto),
                    _ => todo!(),
                }
            };

            {
                let channel = FROM_WEB.0.lock().unwrap();
                (*channel).send(result).unwrap();
            }
        }
    });

    println!("port 5800.  press return to exit gracefully...");
    let t = std::thread::spawn(|| {
        let mut buffer = String::default();
        stdin().read_line(&mut buffer).ok();
        std::process::exit(0);
    });

    Server::new(acceptor).serve(router).await;
    t.join().unwrap();
}
