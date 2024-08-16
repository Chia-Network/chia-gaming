use std::collections::BTreeMap;
use std::fs;
use std::sync::Mutex;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use lazy_static::lazy_static;
use salvo::http::ResBody;
use salvo::hyper::body::Bytes;
use salvo::prelude::*;

use chia_gaming::channel_handler::types::ReadableMove;
use chia_gaming::common::standard_coin::ChiaIdentity;
use chia_gaming::common::types::{
    AllocEncoder, Amount, CoinString, Error, GameID, PrivateKey, Program, Timeout,
};
use chia_gaming::games::poker_collection;
use chia_gaming::outside::{GameType, ToLocalUI};
use chia_gaming::peer_container::{
    FullCoinSetAdapter, SynchronousGameCradle, SynchronousGameCradleConfig,
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

    handshake_done: bool,
    can_move: bool,
}

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new().unwrap());
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
        })
    }

    #[allow(dead_code)]
    fn index(&self) -> String {
        "<html><body>Coming soon</body></html>".to_string()
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

#[tokio::main]
async fn main() {
    let router = Router::new()
        .get(index)
        .push(Router::with_path("start").post(start_game))
        .push(Router::with_path("index.css").get(index_css))
        .push(Router::with_path("index.js").get(index_js));
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;
    Server::new(acceptor).serve(router).await;
}
