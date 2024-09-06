use exec::execvp;
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::stdin;
use std::mem::swap;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::serde::node_to_bytes;

use lazy_static::lazy_static;
use log::debug;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use salvo::http::ResBody;
use salvo::hyper::body::Bytes;
use salvo::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use chia_gaming::channel_handler::types::ReadableMove;
use chia_gaming::common::standard_coin::ChiaIdentity;
use chia_gaming::common::types::{
    AllocEncoder, Amount, CoinString, Error, GameID, Hash,
    IntoErr, PrivateKey, Program, Sha256Input, Timeout,
};
use chia_gaming::games::calpoker::decode_readable_card_choices;
use chia_gaming::games::calpoker::{decode_calpoker_readable, CalpokerResult};
use chia_gaming::games::poker_collection;
use chia_gaming::outside::{GameStart, GameType, ToLocalUI};
use chia_gaming::peer_container::{
    FullCoinSetAdapter, GameCradle, SynchronousGameCradle, SynchronousGameCradleConfig,
};
use chia_gaming::simulator::Simulator;

struct UIReceiver {
    received_moves: usize,
    our_readable_move: Vec<u8>,
    remote_message: ReadableMove,
    opponent_readable_move: ReadableMove,
}

impl UIReceiver {
    fn new(allocator: &mut AllocEncoder) -> Self {
        let nil_readable = ReadableMove::from_nodeptr(allocator.encode_atom(&[]).unwrap());
        UIReceiver {
            received_moves: 0,
            our_readable_move: Vec::default(),
            remote_message: nil_readable.clone(),
            opponent_readable_move: nil_readable,
        }
    }
}

impl ToLocalUI for UIReceiver {
    fn self_move(&mut self, _id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.our_readable_move = readable.to_vec();
        Ok(())
    }

    fn opponent_moved(&mut self, _id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        self.received_moves += 1;
        self.our_readable_move = Vec::default();
        self.opponent_readable_move = readable;
        Ok(())
    }

    fn game_message(&mut self, _id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        self.remote_message = readable;
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

#[derive(Debug, Clone)]
enum IncomingAction {
    Word(Vec<u8>),
    Picks(Vec<bool>),
    Finish,
}

//
// player, received moves, incoming actions
//
// 0, 0, 0 -> BeforeAliceWord
// 0, 0, 1 -> AfterAliceWord
// 0, 1, 1 -> BeforeAlicePicks
// 0, 1, 2 -> AfterAlicePicks
// 0, 2, 2 -> BeforeAliceFinish
// 0, 2, 3 -> AliceEnd
// 0, 3, 3 -> AliceEnd
//
// 1, 0, 0 -> BobStart
// 1, 1, 0 -> BeforeBobWord
// 1, 1, 1 -> AfterBobWord
// 1, 2, 1 -> BeforeBobPicks
// 1, 2, 2 -> AfterBobPicks
// 1, 3, 2 -> BeforeBobFinish
// 1, 3, 3 -> BobEnd
//
// Alice:
//
// If incoming_actions goes from == received_moves to > received_moves, then release a move.
// If received_moves transitions to incoming_actions - 1, then release a move.
//
// Bob:
//
// If incoming_actions goes from < received_moves to = received_moves, then release a move.
//
#[derive(Debug, Clone, Serialize, Eq, PartialEq)]
enum PlayState {
    BeforeAliceWord,
    AfterAliceWord,
    BeforeAlicePicks,
    AfterAlicePicks,
    BeforeAliceFinish,
    AliceEnd,

    BobWaiting,
    BeforeBobWord,
    AfterBobWord,
    BeforeBobPicks,
    AfterBobPicks,
    BeforeBobFinish,
    BobEnd,
}

impl PlayState {
    fn incr(&self) -> Self {
        match self {
            PlayState::BeforeAliceWord => PlayState::AfterAliceWord,
            PlayState::AfterAliceWord => PlayState::BeforeAlicePicks,
            PlayState::BeforeAlicePicks => PlayState::AfterAlicePicks,
            PlayState::AfterAlicePicks => PlayState::BeforeAliceFinish,
            PlayState::BeforeAliceFinish => PlayState::AliceEnd,
            PlayState::AliceEnd => PlayState::AliceEnd,

            PlayState::BobWaiting => PlayState::BeforeBobWord,
            PlayState::BeforeBobWord => PlayState::AfterBobWord,
            PlayState::AfterBobWord => PlayState::BeforeBobPicks,
            PlayState::BeforeBobPicks => PlayState::AfterBobPicks,
            PlayState::AfterBobPicks => PlayState::BeforeBobFinish,
            PlayState::BeforeBobFinish => PlayState::BobEnd,
            PlayState::BobEnd => PlayState::BobEnd,
        }
    }
}

pub struct PerPlayerInfo {
    player_id: bool,
    local_ui: UIReceiver,
    cradle: SynchronousGameCradle,
    play_state: PlayState,
    fund_coin: CoinString,
    incoming_actions: VecDeque<IncomingAction>,
    num_incoming_actions: usize,
    game_outcome: CalpokerResult,
}

struct ReleaseObject<'a, T: Clone> {
    ob: T,
    released: bool,
    deq: &'a mut VecDeque<T>,
}

impl<'a, T: Clone> ReleaseObject<'a, T> {
    fn value(&self) -> T {
        self.ob.clone()
    }

    fn release(&mut self) {
        self.released = true;
    }

    fn new(deq: &'a mut VecDeque<T>) -> Option<Self> {
        deq.pop_front().map(|res| ReleaseObject {
            ob: res,
            released: false,
            deq,
        })
    }
}

impl<'a, T: Clone> Drop for ReleaseObject<'a, T> {
    fn drop(&mut self) {
        if !self.released {
            self.released = true;
            self.deq.push_front(self.ob.clone());
        }
    }
}

trait HttpError<V> {
    fn report_err(self) -> Result<V, String>;
}

impl<V> HttpError<V> for Result<V, Error> {
    fn report_err(self) -> Result<V, String> {
        match self {
            Ok(x) => Ok(x),
            Err(e) => {
                let mut error = Map::default();
                error.insert("error".to_string(), Value::String(format!("{e:?}")));
                let as_string = serde_json::to_string(&Value::Object(error))
                    .map_err(|_| "\"bad json conversion\"".to_string())?;
                Err(as_string)
            }
        }
    }
}

impl PerPlayerInfo {
    fn new(
        allocator: &mut AllocEncoder,
        player_id: bool,
        fund_coin: CoinString,
        cradle: SynchronousGameCradle,
        play_state: PlayState,
    ) -> Self {
        PerPlayerInfo {
            player_id,
            fund_coin,
            cradle,
            play_state,
            local_ui: UIReceiver::new(allocator),
            game_outcome: CalpokerResult::default(),
            incoming_actions: VecDeque::default(),
            num_incoming_actions: 0,
        }
    }

    fn enqueue_outbound_move(&mut self, incoming_action: IncomingAction) {
        eprintln!("enqueue outbound move: {incoming_action:?}");
        self.incoming_actions.push_back(incoming_action);
        self.num_incoming_actions += 1;
    }

    fn player_cards_readable(&mut self, allocator: &mut AllocEncoder) -> Result<Value, Error> {
        // See if we have enough info to get the cardlists.
        let decode_input = if self.player_id {
            // bob
            self.local_ui.remote_message.clone()
        } else {
            // alice
            self.local_ui.opponent_readable_move.clone()
        };
        let cardlist_result = decode_readable_card_choices(allocator, decode_input).ok();
        if let Some(player_hands) = cardlist_result {
            // make_cards
            serde_json::to_value(player_hands).into_gen()
        } else {
            let empty_vec: Vec<(usize, usize)> = vec![];
            serde_json::to_value(empty_vec).into_gen()
        }
    }

    fn player_readable(&mut self, allocator: &mut AllocEncoder) -> Result<Value, Error> {
        match &self.play_state {
            PlayState::BeforeAlicePicks => self.player_cards_readable(allocator),
            PlayState::AfterBobWord => self.player_cards_readable(allocator),
            PlayState::BeforeBobPicks => self.player_cards_readable(allocator),
            PlayState::AfterAlicePicks => serde_json::to_value(&self.game_outcome).into_gen(),
            PlayState::BeforeAliceFinish => serde_json::to_value(&self.game_outcome).into_gen(),
            PlayState::AliceEnd => serde_json::to_value(&self.game_outcome).into_gen(),
            PlayState::BobEnd => serde_json::to_value(&self.game_outcome).into_gen(),
            _ => Ok(Value::String(disassemble(
                allocator.allocator(),
                self.local_ui.opponent_readable_move.to_nodeptr(),
                None,
            ))),
        }
    }

    fn pass_on_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_ids: &[GameID],
    ) -> Result<(), Error> {
        let mut g = if let Some(g) = ReleaseObject::new(&mut self.incoming_actions) {
            g
        } else {
            return Ok(());
        };

        match g.value() {
            IncomingAction::Word(hash) => {
                if !matches!(
                    self.play_state,
                    PlayState::BeforeAliceWord | PlayState::BeforeBobWord
                ) {
                    return Ok(());
                }

                g.release();
                self.play_state = self.play_state.incr();

                let encoded_node = allocator.encode_atom(&hash).unwrap();
                let encoded = node_to_bytes(allocator.allocator(), encoded_node).unwrap();
                eprintln!("word hash {hash:?}");

                self.cradle.make_move(
                    allocator,
                    rng,
                    &game_ids[0],
                    encoded,
                    Hash::from_slice(&hash),
                )
            }
            IncomingAction::Picks(other_picks) => {
                if !matches!(
                    self.play_state,
                    PlayState::BeforeAlicePicks | PlayState::BeforeBobPicks
                ) {
                    return Ok(());
                }

                g.release();
                self.play_state = self.play_state.incr();

                let encoded_node = other_picks.to_clvm(allocator).unwrap();
                let encoded = node_to_bytes(allocator.allocator(), encoded_node).unwrap();
                let new_entropy = rng.gen();
                self.cradle
                    .make_move(allocator, rng, &game_ids[0], encoded, new_entropy)
            }
            IncomingAction::Finish => {
                if !matches!(
                    self.play_state,
                    PlayState::BeforeAliceFinish | PlayState::BeforeBobFinish
                ) {
                    return Ok(());
                }

                eprintln!("{} doing finish move", self.player_id);
                g.release();
                self.play_state = self.play_state.incr();
                let new_entropy = rng.gen();
                self.cradle
                    .make_move(allocator, rng, &game_ids[0], vec![0x80], new_entropy)
            }
        }
    }

    fn idle<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_ids: &[GameID],
    ) -> Result<(), Error> {
        let prev = self.play_state.clone();

        eprintln!(
            "{} idle waiting {} incoming {} state {:?}",
            self.player_id,
            self.incoming_actions.len(),
            self.local_ui.received_moves,
            self.play_state
        );

        match (self.local_ui.received_moves, &self.play_state) {
            (1, PlayState::BobWaiting) => {
                self.play_state = self.play_state.incr();
            }
            (1, PlayState::AfterAliceWord) => {
                self.play_state = self.play_state.incr();
            }
            (2, PlayState::AfterBobWord) => {
                self.play_state = self.play_state.incr();
            }
            (2, PlayState::AfterAlicePicks) => {
                self.play_state = self.play_state.incr();
            }
            (2, PlayState::AfterBobPicks) => {
                self.play_state = self.play_state.incr();
            }
            (_, PlayState::AliceEnd | PlayState::BobEnd) => {
                if let Ok(res) = decode_calpoker_readable(
                    allocator,
                    self.local_ui.opponent_readable_move.to_nodeptr(),
                    self.cradle.amount(),
                    self.player_id,
                )
                {
                    if res.raw_alice_selects != 0 {
                        self.game_outcome = res;
                    }
                }
            }
            _ => {}
        }

        if prev != self.play_state {
            eprintln!(
                "{} R {} transition {prev:?} to {:?}",
                self.player_id, self.local_ui.received_moves, self.play_state
            );
        }

        self.pass_on_move(allocator, rng, game_ids)
    }
}

#[allow(dead_code)]
struct GameRunner {
    allocator: AllocEncoder,
    rng: ChaCha8Rng,

    game_type_map: BTreeMap<GameType, Program>,

    neutral_identity: ChiaIdentity,
    coinset_adapter: FullCoinSetAdapter,

    player_info: [PerPlayerInfo; 2],

    simulator: Simulator,
    game_ids: Vec<GameID>,

    handshake_done: bool,
    can_move: bool,
    funded: bool,

    tick_count: usize,

    auto: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UpdateResult {
    info: Value,
}

// TODO: Check if still using Serialize, Deserialize
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlayerResult {
    can_move: bool,
    state: String,
    auto: bool,
    our_move: Vec<u8>,
    readable: Value,
}

#[derive(Debug, Clone)]
enum WebRequest {
    Idle,
    Reset,
    Player(bool),
    WordHash(bool, Vec<u8>),
    Picks(bool, Vec<bool>),
    FinishMove(bool),
}

type StringWithError = Result<String, Error>;

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new().unwrap());
    static ref TO_WEB: (Mutex<Sender<WebRequest>>, Mutex<Receiver<WebRequest>>) = {
        let (tx, rx) = mpsc::channel();
        (tx.into(), rx.into())
    };
    static ref FROM_WEB: (
        Mutex<Sender<StringWithError>>,
        Mutex<Receiver<StringWithError>>
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

        let coinset_adapter = FullCoinSetAdapter::default();
        let simulator = Simulator::default();

        // Give some money to the users.
        simulator.farm_block(&id1.puzzle_hash);
        simulator.farm_block(&id2.puzzle_hash);

        let coins0 = simulator
            .get_my_coins(&id1.puzzle_hash)
            .expect("should work");
        let coins1 = simulator
            .get_my_coins(&id2.puzzle_hash)
            .expect("should work");

        // Make a 100 coin for each player (and test the deleted and created events).
        let (parent_coin_0, _rest_0) = simulator
            .transfer_coin_amount(&mut allocator, &id1, &id1, &coins0[0], Amount::new(100))
            .expect("should work");
        let (parent_coin_1, _rest_1) = simulator
            .transfer_coin_amount(&mut allocator, &id2, &id2, &coins1[0], Amount::new(100))
            .expect("should work");

        simulator.farm_block(&neutral_identity.puzzle_hash);

        let cradle1 = SynchronousGameCradle::new(
            &mut rng,
            SynchronousGameCradleConfig {
                game_types: game_type_map.clone(),
                have_potato: true,
                identity: &id1,
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
                identity: &id2,
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(100),
                reward_puzzle_hash: id2.puzzle_hash.clone(),
            },
        );
        let game_ids = Vec::default();
        let handshake_done = false;
        let can_move = false;

        let player1 = PerPlayerInfo::new(
            &mut allocator,
            false,
            parent_coin_0.clone(),
            cradle1,
            PlayState::BeforeAliceWord,
        );
        let player2 = PerPlayerInfo::new(
            &mut allocator,
            true,
            parent_coin_1.clone(),
            cradle2,
            PlayState::BobWaiting,
        );

        Ok(GameRunner {
            allocator,
            rng,
            game_type_map,
            neutral_identity,
            coinset_adapter,
            simulator,
            game_ids,
            handshake_done,
            can_move,
            funded: false,
            auto: false,
            tick_count: 0,
            player_info: [player1, player2],
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
            serde_json::to_value(&self.player_info[0].play_state).unwrap(),
        );
        r.insert(
            "bob_state".to_string(),
            serde_json::to_value(&self.player_info[1].play_state).unwrap(),
        );
        Value::Object(r)
    }

    // Produce the state result for when a move is possible.
    fn move_state(&self) -> String {
        serde_json::to_string(&UpdateResult { info: self.info() }).unwrap()
    }

    fn player_readable(&mut self, id: bool) -> Result<Value, Error> {
        self.player_info[id as usize].player_readable(&mut self.allocator)
    }

    fn player(&mut self, id: bool) -> Result<String, Error> {
        let player_readable = self.player_readable(id)?;
        serde_json::to_string(&PlayerResult {
            can_move: self.can_move,
            state: format!("{:?}", self.player_info[id as usize].play_state),
            our_move: self.player_info[id as usize]
                .local_ui
                .our_readable_move
                .to_vec(),
            auto: self.auto,
            readable: player_readable,
        })
        .into_gen()
    }

    fn word_hash(&mut self, id: bool, hash: &[u8]) -> String {
        self.player_info[id as usize].enqueue_outbound_move(IncomingAction::Word(hash.to_vec()));

        self.move_state()
    }

    fn do_picks(&mut self, id: bool, picks: &[bool]) -> String {
        self.player_info[id as usize].enqueue_outbound_move(IncomingAction::Picks(picks.to_vec()));
        self.move_state()
    }

    fn finish_move(&mut self, id: bool) -> String {
        self.player_info[id as usize].enqueue_outbound_move(IncomingAction::Finish);
        self.move_state()
    }

    fn idle(&mut self) -> Result<String, Error> {
        self.tick_count += 1;

        if self.tick_count % 10 == 0 {
            self.simulator
                .farm_block(&self.neutral_identity.puzzle_hash);
        }

        let current_height = self.simulator.get_current_height();
        let current_coins = self.simulator.get_all_coins().expect("should work");
        let watch_report = self
            .coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)
            .expect("should work");

        for i in 0..=1 {
            self.player_info[i]
                .cradle
                .new_block(
                    &mut self.allocator,
                    &mut self.rng,
                    current_height,
                    &watch_report,
                )
                .expect("should work");

            loop {
                let result = self.player_info[i].cradle.idle(
                    &mut self.allocator,
                    &mut self.rng,
                    &mut self.player_info[i].local_ui,
                )?;
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
                    self.player_info[i ^ 1]
                        .cradle
                        .deliver_message(msg)
                        .expect("should work");
                }

                if !result.continue_on {
                    break;
                }
            }
        }

        if !self.funded {
            // Give coins to the cradles.
            self.player_info[0]
                .cradle
                .opening_coin(
                    &mut self.allocator,
                    &mut self.rng,
                    self.player_info[0].fund_coin.clone(),
                )
                .expect("should work");
            self.player_info[1]
                .cradle
                .opening_coin(
                    &mut self.allocator,
                    &mut self.rng,
                    self.player_info[1].fund_coin.clone(),
                )
                .expect("should work");

            self.funded = true;

            return serde_json::to_string(&UpdateResult { info: self.info() }).into_gen();
        }

        if self.can_move {
            for i in 0..=1 {
                self.player_info[i].idle(&mut self.allocator, &mut self.rng, &self.game_ids)?;
            }

            return Ok(self.move_state());
        }

        if !self.handshake_done
            && self.player_info[0].cradle.handshake_finished()
            && self.player_info[1].cradle.handshake_finished()
        {
            self.game_ids = self.player_info[0]
                .cradle
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

            self.player_info[1]
                .cradle
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

        serde_json::to_string(&UpdateResult { info: self.info() }).into_gen()
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

fn pass_on_request(wr: WebRequest) -> Result<String, Error> {
    {
        let to_web = TO_WEB.0.lock().unwrap();
        (*to_web).send(wr).unwrap();
    }
    let from_web = FROM_WEB.1.lock().unwrap();
    (*from_web).recv().unwrap()
}

#[handler]
async fn idle(_req: &mut Request) -> Result<String, String> {
    pass_on_request(WebRequest::Idle).report_err()
}

fn get_arg_bytes(req: &mut Request) -> Result<Vec<u8>, Error> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<u8> = uri_string.bytes().skip(found_eq + 1).collect();
        return Ok(arg);
    }

    Err(Error::StrErr("no argument".to_string()))
}

#[handler]
async fn player(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req).report_err()?;
    let pid = if arg.is_empty() {
        false
    } else {
        arg[0] == b'2'
    };
    pass_on_request(WebRequest::Player(pid)).report_err()
}

#[handler]
async fn word_hash(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req).report_err()?;
    if arg.is_empty() {
        return Err("empty arg".to_string());
    }
    let player_id = arg[0] == b'2';
    let hash = Sha256Input::Bytes(&arg[1..]).hash();
    let hash_of_alice_hash = Sha256Input::Bytes(hash.bytes()).hash();
    eprintln!("{player_id} hash is {hash:?} hash of that is {hash_of_alice_hash:?}");
    pass_on_request(WebRequest::WordHash(player_id, hash.bytes().to_vec())).report_err()
}

#[handler]
async fn do_picks(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req).report_err()?;
    let bool_arg: Vec<bool> = arg.iter().skip(1).map(|b| *b == b'1').collect();
    pass_on_request(WebRequest::Picks(arg[0] == b'2', bool_arg)).report_err()
}

#[handler]
async fn exit(_req: &mut Request) -> Result<String, String> {
    std::process::exit(0);
}

#[handler]
async fn reset(_req: &mut Request) -> Result<String, String> {
    pass_on_request(WebRequest::Reset).report_err()
}

#[handler]
async fn finish(req: &mut Request) -> Result<String, String> {
    let arg = get_arg_bytes(req).report_err()?;
    let player_id = if arg.is_empty() {
        false
    } else {
        arg[0] == b'2'
    };
    pass_on_request(WebRequest::FinishMove(player_id)).report_err()
}

fn reset_sim(sim: &mut GameRunner, auto: bool) -> Result<String, Error> {
    let mut new_game = GameRunner::new()?;
    if auto {
        new_game.set_auto(true);
    }
    swap(sim, &mut new_game);
    Ok("{}".to_string())
}

fn detect_run_as_python(args: &[String]) -> bool {
    args.iter().any(|x: &String| x == "-c")
}

fn main() {
    let args = std::env::args();
    let args_vec: Vec<String> = args.collect();
    if detect_run_as_python(&args_vec) {
        let new_args: Vec<OsString> = args_vec
            .iter()
            .enumerate()
            .map(
                |(i, arg)| {
                    if i == 0 {
                        "python3".into()
                    } else {
                        arg.into()
                    }
                },
            )
            .collect();
        let exec_err = execvp("python3", &new_args);
        eprintln!("Error Running: {:?}\n{:?}\n", new_args, exec_err);
        return;
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        eprintln!("ARGS: {:?}", args_vec);
        let auto = args_vec.iter().any(|x| x == "auto");

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
            .push(Router::with_path("word_hash").post(word_hash))
            .push(Router::with_path("picks").post(do_picks))
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
                        WebRequest::WordHash(id, hash) => Ok((*locked).word_hash(id, &hash)),
                        WebRequest::Picks(id, picks) => Ok((*locked).do_picks(id, &picks)),
                        WebRequest::FinishMove(id) => Ok((*locked).finish_move(id)),
                        WebRequest::Reset => reset_sim(&mut locked, auto),
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
        s.join().unwrap();
        t.join().unwrap();
    })
}
