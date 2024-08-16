use std::collections::BTreeMap;
use std::fs;
use std::io::stdin;
use std::sync::Mutex;
use std::thread;
use std::sync::mpsc::{Sender, Receiver};
use std::sync::mpsc;

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
    AllocEncoder, Amount, CoinString, Error, GameID, PrivateKey, Program, Timeout,
};
use chia_gaming::games::poker_collection;
use chia_gaming::outside::{GameStart, GameType, ToLocalUI};
use chia_gaming::peer_container::{
    FullCoinSetAdapter, SynchronousGameCradle, SynchronousGameCradleConfig, GameCradle
};
use chia_gaming::simulator::Simulator;

#[derive(Default)]
struct UIReceiver {}

impl ToLocalUI for UIReceiver {
    fn opponent_moved(&mut self, _id: &GameID, _readable: ReadableMove) -> Result<(), Error> {
        todo!();
    }

    fn game_message(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
        todo!();
    }

    fn game_finished(&mut self, _id: &GameID, _my_share: Amount) -> Result<(), Error> {
        todo!();
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UpdateResult {
    info: String,
    p1: String,
    p2: String,
}

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new().unwrap());
    static ref TO_WEB: (Mutex<Sender<String>>, Mutex<Receiver<String>>) = {
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
        let local_uis = [UIReceiver::default(), UIReceiver::default()];
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
            fund_coins: [parent_coin_0.clone(), parent_coin_1.clone()]
        })
    }

    fn info(&self) -> String {
        format!("<ul><li>block height: {}<li>handshake_done: {}<li>can_move: {}</ul>", self.coinset_adapter.current_height, self.handshake_done, self.can_move)
    }

    fn idle(&mut self) -> String {
        self.simulator.farm_block(&self.neutral_identity.puzzle_hash);

        let current_height = self.simulator.get_current_height();
        let current_coins = self.simulator.get_all_coins().expect("should work");
        let watch_report = self.coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)
            .expect("should work");

        for i in 0..=1 {
            self.cradles[i]
                .new_block(&mut self.allocator, &mut self.rng, current_height, &watch_report)
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
                    let included_result = self.simulator
                        .push_tx(&mut self.allocator, &tx.spends)
                        .expect("should work");
                    debug!("included_result {included_result:?}");
                    assert_eq!(included_result.code, 1);
                }

                for msg in result.outbound_messages.iter() {
                    self.cradles[i ^ 1].deliver_message(&msg).expect("should work");
                }

                if !result.continue_on {
                    break;
                }
            }
        }

        if !self.funded {
            // Give coins to the cradles.
            self.cradles[0]
                .opening_coin(&mut self.allocator, &mut self.rng, self.fund_coins[0].clone())
                .expect("should work");
            self.cradles[1]
                .opening_coin(&mut self.allocator, &mut self.rng, self.fund_coins[1].clone())
                .expect("should work");

            self.funded = true;

            return serde_json::to_string(&UpdateResult {
                info: self.info(),
                p1: "player 1 funded".to_string(),
                p2: "player 2 funded".to_string()
            }).unwrap();
        }

        if self.can_move {
            return serde_json::to_string(&UpdateResult {
                info: self.info(),
                p1: "player 1 can play".to_string(),
                p2: "player 2 can play".to_string()
            }).unwrap();
        }

        if !self.handshake_done && self.cradles[0].handshake_finished() && self.cradles[1].handshake_finished() {
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
            p2: "player 2 handshaking".to_string()
        }).unwrap()
    }

    fn start_game(&mut self) -> String {
        "start".to_string()
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

#[handler]
async fn start_game(_req: &mut Request) -> Result<String, String> {
    let mut locked = MUTEX.try_lock().map_err(|e| format!("{e:?}"))?;
    Ok((*locked).start_game())
}

#[handler]
async fn idle(_req: &mut Request) -> Result<String, String> {
    {
        let to_web = TO_WEB.0.lock().unwrap();
        (*to_web).send("idle".to_string()).unwrap();
    }
    let from_web = FROM_WEB.1.lock().unwrap();
    (*from_web).recv().map_err(|e| format!("{e:?}"))
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
        .push(Router::with_path("start").post(start_game))
        .push(Router::with_path("index.css").get(index_css))
        .push(Router::with_path("index.js").get(index_js))
        .push(Router::with_path("exit").post(exit))
        .push(Router::with_path("idle.json").post(idle));
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;

    let s = std::thread::spawn(|| {
        loop {
            let request =
            {
                let channel = TO_WEB.1.lock().unwrap();
                (*channel).recv().unwrap()
            };

            eprintln!("request {request}");
            let result =
            {
                let mut locked = MUTEX.lock().unwrap();
                (*locked).idle()
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
