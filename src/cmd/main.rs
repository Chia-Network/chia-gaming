use std::collections::BTreeMap;
use std::fs;
use std::io::stdin;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::thread;

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
use serde_json::json;

use chia_gaming::channel_handler::types::ReadableMove;
use chia_gaming::common::standard_coin::ChiaIdentity;
use chia_gaming::common::types::{
    atom_from_clvm, usize_from_atom, AllocEncoder, Amount, CoinString, Error, GameID, PrivateKey,
    Program, Sha256Input, Timeout,
};
use chia_gaming::games::poker_collection;
use chia_gaming::outside::{GameStart, GameType, ToLocalUI};
use chia_gaming::peer_container::{
    FullCoinSetAdapter, GameCradle, SynchronousGameCradle, SynchronousGameCradleConfig,
};
use chia_gaming::simulator::Simulator;

struct UIReceiver {
    readable_move: ReadableMove,
}

impl UIReceiver {
    fn new(allocator: &mut AllocEncoder) -> Self {
        UIReceiver {
            readable_move: ReadableMove::from_nodeptr(allocator.encode_atom(&[]).unwrap()),
        }
    }
}

impl ToLocalUI for UIReceiver {
    fn opponent_moved(&mut self, _id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        self.readable_move = readable;
        Ok(())
    }

    fn game_message(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
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
enum PlayState {
    AliceWord,
    BobWord,
    AlicePicks,
    BobPicks,
    FinishGame,
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
    game_ids: Vec<GameID>,

    fund_coins: [CoinString; 2],
    handshake_done: bool,
    can_move: bool,
    funded: bool,
    play_state: PlayState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UpdateResult {
    info: String,
    p1: String,
    p2: String,
}

#[derive(Debug, Clone)]
enum WebRequest {
    Idle,
    AliceWordHash(Vec<u8>),
    BobWord(Vec<u8>),
    AlicePicks(Vec<bool>),
    BobPicks(Vec<bool>),
    FinishMove,
}

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new().unwrap());
    static ref TO_WEB: (Mutex<Sender<WebRequest>>, Mutex<Receiver<WebRequest>>) = {
        let (tx, rx) = mpsc::channel();
        (tx.into(), rx.into())
    };
    static ref FROM_WEB: (Mutex<Sender<String>>, Mutex<Receiver<String>>) = {
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
            play_state: PlayState::AliceWord,
        })
    }

    fn info(&self) -> String {
        format!(
            "<ul><li>block height: {}<li>handshake_done: {}<li>can_move: {}<li>play_state: {:?}</ul>",
            self.coinset_adapter.current_height,
            self.handshake_done,
            self.can_move,
            self.play_state
        )
    }

    fn alice_word_hash(&mut self, hash: &[u8]) -> String {
        let encoded_node = self.allocator.encode_atom(hash).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        self.cradles[0]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
            )
            .unwrap();

        self.play_state = PlayState::BobWord;

        self.move_state()
    }

    fn bob_word(&mut self, word: &[u8]) -> String {
        let encoded_node = self.allocator.encode_atom(word).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        self.cradles[1]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
            )
            .unwrap();

        self.play_state = PlayState::AlicePicks;

        self.move_state()
    }

    fn alice_picks(&mut self, picks: &[bool]) -> String {
        let encoded_node = picks.to_clvm(&mut self.allocator).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        self.cradles[0]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
            )
            .unwrap();

        self.play_state = PlayState::BobPicks;

        self.move_state()
    }

    fn bob_picks(&mut self, picks: &[bool]) -> String {
        let encoded_node = picks.to_clvm(&mut self.allocator).unwrap();
        let encoded = node_to_bytes(self.allocator.allocator(), encoded_node).unwrap();
        self.cradles[1]
            .make_move(
                &mut self.allocator,
                &mut self.rng,
                &self.game_ids[0],
                encoded,
            )
            .unwrap();

        self.play_state = PlayState::FinishGame;

        self.move_state()
    }

    fn basic_show(&mut self) -> (String, String) {
        let p1 = disassemble(
            self.allocator.allocator(),
            self.local_uis[0].readable_move.to_nodeptr(),
            None,
        );
        let p2 = disassemble(
            self.allocator.allocator(),
            self.local_uis[1].readable_move.to_nodeptr(),
            None,
        );
        (p1, p2)
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

    fn picks_state(&mut self, bob: bool) -> (String, String) {
        let bs = self.basic_show();
        if let Some(alice_bob_cards) = proper_list(
            self.allocator.allocator(),
            self.local_uis[0].readable_move.to_nodeptr(),
            true,
        ) {
            if alice_bob_cards.is_empty() {
                self.basic_show()
            } else {
                eprintln!("alice_bob_cards {alice_bob_cards:?}");
                let alice_cards = self.convert_cards(alice_bob_cards[0]);
                let bob_cards = self.convert_cards(alice_bob_cards[1]);
                let mut p1 = b"<div><h2>alice cards</h2><div>".to_vec();
                let mut p2 = b"<div><h2>bob cards</h2><div>".to_vec();
                for (i, (rank, suit)) in alice_cards.into_iter().enumerate() {
                    let mut card_fmt: Vec<u8> = format!("<button class='cardspan' id='alice_card{}' rank='{}' suit='{}' onclick='alice_toggle({})'>{} {}</span>", i, rank, suit, i, rank, suit).bytes().collect();
                    p1.append(&mut card_fmt);
                }
                for (i, (rank, suit)) in bob_cards.into_iter().enumerate() {
                    let mut card_fmt: Vec<u8> = format!("<button class='cardspan' id='bob_card{}' rank='{}' suit='{}' onclick='bob_toggle({})'>{} {}</span>", i, rank, suit, i, rank, suit).bytes().collect();
                    p2.append(&mut card_fmt);
                }

                {
                    let (who, to_append_button, to_append_other) = if bob {
                        ("bob", &mut p2, &mut p1)
                    } else {
                        ("alice", &mut p1, &mut p2)
                    };

                    let button_append = format!("</div><button id='{who}_pick' onclick='set_{who}_picks()'>Set {who} picks</button></div>");

                    to_append_button.append(&mut button_append.bytes().collect());
                    to_append_other.append(&mut b"</div></div>".to_vec());
                }

                (decode_string(&p1), decode_string(&p2))
            }
        } else {
            self.basic_show()
        }
    }

    fn move_state(&mut self) -> String {
        let (p1, p2) = match &self.play_state {
            PlayState::AliceWord => {
                let p1 = "<div><h2>generate alice word</h2><button onclick='send_alice_word()'>Generate</button></div>".to_string();
                let p2 = "<div><h2>alice' turn</h2></div>".to_string();
                (p1, p2)
            }
            PlayState::BobWord => {
                let p1 = "<div><h2>bob's turn</h2></div>".to_string();
                let p2 = "<div><h2>generate bob's word</h2><button onclick='send_bob_word()'>Generate</button></div>".to_string();
                (p1, p2)
            }
            PlayState::AlicePicks => self.picks_state(false),
            PlayState::BobPicks => self.picks_state(true),
            _ => self.basic_show(),
        };
        serde_json::to_string(&UpdateResult {
            info: self.info(),
            p1,
            p2,
        })
        .unwrap()
    }

    fn idle(&mut self) -> String {
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
                    .expect("should work");
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

            return serde_json::to_string(&UpdateResult {
                info: self.info(),
                p1: "player 1 funded".to_string(),
                p2: "player 2 funded".to_string(),
            })
            .unwrap();
        }

        if self.can_move {
            return self.move_state();
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

        serde_json::to_string(&UpdateResult {
            info: self.info(),
            p1: "player 1 handshaking".to_string(),
            p2: "player 2 handshaking".to_string(),
        })
        .unwrap()
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
async fn index_js(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.js", "text/javascript", response)
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
    (*from_web).recv().map_err(|e| format!("{e:?}"))
}

#[handler]
async fn idle(_req: &mut Request) -> Result<String, String> {
    pass_on_request(WebRequest::Idle)
}

#[handler]
async fn alice_word_hash(req: &mut Request) -> Result<String, String> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<u8> = uri_string.bytes().skip(found_eq + 1).collect();
        let hash = Sha256Input::Bytes(&arg).hash();
        return pass_on_request(WebRequest::AliceWordHash(hash.bytes().to_vec()));
    }

    Err("no argument".to_string())
}

#[handler]
async fn bob_word(req: &mut Request) -> Result<String, String> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<u8> = uri_string.bytes().skip(found_eq + 1).collect();
        let hash = Sha256Input::Bytes(&arg).hash();
        return pass_on_request(WebRequest::BobWord(
            hash.bytes().iter().take(16).cloned().collect(),
        ));
    }

    Err("no argument".to_string())
}

#[handler]
async fn alice_picks(req: &mut Request) -> Result<String, String> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<bool> = uri_string
            .bytes()
            .skip(found_eq + 1)
            .map(|b| b == b'1')
            .collect();
        return pass_on_request(WebRequest::AlicePicks(arg));
    }

    Err("no argument".to_string())
}

#[handler]
async fn bob_picks(req: &mut Request) -> Result<String, String> {
    let uri_string = req.uri().to_string();
    if let Some(found_eq) = uri_string.bytes().position(|x| x == b'=') {
        let arg: Vec<bool> = uri_string
            .bytes()
            .skip(found_eq + 1)
            .map(|b| b == b'1')
            .collect();
        return pass_on_request(WebRequest::BobPicks(arg));
    }

    Err("no argument".to_string())
}

#[handler]
async fn exit(_req: &mut Request) -> Result<String, String> {
    std::process::exit(0);
    Ok("done".to_string())
}

#[tokio::main]
async fn main() {
    let router = Router::new()
        .get(index)
        .push(Router::with_path("index.css").get(index_css))
        .push(Router::with_path("index.js").get(index_js))
        .push(Router::with_path("exit").post(exit))
        .push(Router::with_path("idle.json").post(idle))
        .push(Router::with_path("alice_word_hash").post(alice_word_hash))
        .push(Router::with_path("bob_word").post(bob_word))
        .push(Router::with_path("alice_picks").post(alice_picks))
        .push(Router::with_path("bob_picks").post(bob_picks));
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;

    let s = std::thread::spawn(|| loop {
        let request = {
            let channel = TO_WEB.1.lock().unwrap();
            (*channel).recv().unwrap()
        };

        eprintln!("request {request:?}");
        let result = {
            let mut locked = MUTEX.lock().unwrap();
            match request {
                WebRequest::Idle => (*locked).idle(),
                WebRequest::AliceWordHash(hash) => (*locked).alice_word_hash(&hash),
                WebRequest::BobWord(bytes) => (*locked).bob_word(&bytes),
                WebRequest::AlicePicks(picks) => (*locked).alice_picks(&picks),
                WebRequest::BobPicks(picks) => (*locked).bob_picks(&picks),
                _ => todo!(),
            }
        };

        {
            let channel = FROM_WEB.0.lock().unwrap();
            (*channel).send(result).unwrap();
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
