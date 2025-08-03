use exec::execvp;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::stdin;
use std::mem::swap;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use lazy_static::lazy_static;
use log::debug;

use pyo3::Python;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use salvo::http::ResBody;
use salvo::hyper::body::Bytes;
use salvo::prelude::*;
use serde_json::{Map, Value};

use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinString, Error, Hash, IntoErr, PrivateKey, Program,
    PuzzleHash, SpendBundle,
};
use crate::peer_container::{FullCoinSetAdapter, WatchReport};
use crate::simulator::Simulator;
use pyo3::pyfunction;

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

#[allow(dead_code)]
struct GameRunner {
    allocator: AllocEncoder,
    rng: ChaCha8Rng,

    neutral_identity: ChiaIdentity,
    identities: BTreeMap<String, String>,
    pubkeys: BTreeMap<String, ChiaIdentity>,

    simulator: Simulator,
    coinset_adapter: FullCoinSetAdapter,

    sim_record: BTreeMap<u64, WatchReport>,
}

#[derive(Debug, Clone)]
enum WebRequest {
    Reset,
    Register(String),                     // Register a user
    GetCurrentPeak,                       // Ask for the current peak
    GetBlockData(u64),                    // Get the additions and deletons from the given block
    GetPuzzleAndSolution(String),         // Given a coin id, get the puzzle and solution
    CreateSpendable(String, String, u64), // Use the named wallet to give n mojo to a target puzzle hash
    Spend(String),                        // Perform this spend on the blockchain
    WaitBlock,                            // Return when a new block arrives
}

type StringWithError = Result<String, Error>;

lazy_static! {
    static ref ONE_REQUEST: Mutex<()> = Mutex::new(());
    static ref PERFORM_REQUEST: Mutex<()> = Mutex::new(());
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

fn hex_to_bytes(hexstr: &str) -> Result<Vec<u8>, Error> {
    hex::decode(hexstr).map_err(|_e| Error::StrErr("not hex".to_string()))
}

impl GameRunner {
    fn new(simulator: Simulator, coinset_adapter: FullCoinSetAdapter) -> Result<Self, Error> {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);

        let neutral_pk: PrivateKey = rng.gen();
        let neutral_identity = ChiaIdentity::new(&mut allocator, neutral_pk).expect("should work");

        simulator.farm_block(&neutral_identity.puzzle_hash);

        Ok(GameRunner {
            allocator,
            rng,
            neutral_identity,
            coinset_adapter,
            simulator,
            identities: BTreeMap::default(),
            pubkeys: BTreeMap::default(),
            sim_record: BTreeMap::default(),
        })
    }

    fn detach_simulator(
        &mut self,
        mut simulator: Simulator,
        mut coinset_adapter: FullCoinSetAdapter,
    ) -> (Simulator, FullCoinSetAdapter) {
        swap(&mut simulator, &mut self.simulator);
        swap(&mut coinset_adapter, &mut self.coinset_adapter);

        (simulator, coinset_adapter)
    }

    fn reset_sim(&mut self) -> StringWithError {
        let coinset_adapter = FullCoinSetAdapter::default();
        let simulator = Simulator::default();
        self.detach_simulator(simulator, coinset_adapter);
        Ok("1\n".to_string())
    }

    fn chase_block(&mut self) -> Result<u64, Error> {
        let new_height = self.simulator.get_current_height() as u64;
        let new_coins = self.simulator.get_all_coins().into_gen()?;
        let watch_report = self
            .coinset_adapter
            .make_report_from_coin_set_update(new_height, &new_coins)?;
        self.sim_record.insert(new_height, watch_report);
        Ok(new_height)
    }

    fn wait_block(&mut self) -> StringWithError {
        debug!("entering wait block");
        self.simulator
            .farm_block(&self.neutral_identity.puzzle_hash);
        let new_height = self.chase_block()?;
        Ok(format!("{}\n", new_height))
    }

    fn get_block_data(&self, block: u64) -> StringWithError {
        if let Some(report) = self.sim_record.get(&block) {
            let created: Vec<String> = report
                .created_watched
                .iter()
                .map(|c| hex::encode(c.to_bytes()))
                .collect();
            let deleted: Vec<String> = report
                .deleted_watched
                .iter()
                .map(|c| hex::encode(c.to_bytes()))
                .collect();
            let timed_out: Vec<String> = report
                .timed_out
                .iter()
                .map(|c| hex::encode(c.to_bytes()))
                .collect();
            return Ok(format!("{{ \"created\": {created:?}, \"deleted\": {deleted:?}, \"timed_out\": {timed_out:?} }}\n"));
        }

        Ok("null\n".to_string())
    }

    fn get_puzzle_and_solution(&self, coin: &str) -> StringWithError {
        let bytes = hex_to_bytes(coin)?;
        let coin_id = if bytes.len() > 32 {
            let cs = CoinString::from_bytes(&bytes);
            debug!("coin string: {cs:?}");
            cs.to_coin_id()
        } else {
            CoinID::new(Hash::from_slice(&bytes))
        };

        if let Some((prog, sol)) = self
            .simulator
            .get_puzzle_and_solution(&coin_id)
            .map_err(|e| Error::StrErr(format!("{e:?}")))?
        {
            return Ok(format!("[\"{}\",\"{}\"]\n", prog.to_hex(), sol.to_hex()));
        }

        Ok("null\n".to_string())
    }

    fn lookup_identity(&self, name: &str) -> Option<&ChiaIdentity> {
        if let Some(pk) = self.identities.get(name) {
            return self.pubkeys.get(pk);
        } else if let Some(pki) = self.pubkeys.get(name) {
            return Some(pki);
        }

        None
    }

    fn register(&mut self, name: &str) -> StringWithError {
        let public_key = if let Some(identity) = self.lookup_identity(name) {
            hex::encode(identity.puzzle_hash.bytes())
        } else {
            let pk1: PrivateKey = self.rng.gen();
            let identity = ChiaIdentity::new(&mut self.allocator, pk1)?;
            self.simulator.farm_block(&identity.puzzle_hash);
            self.chase_block()?;
            let result = hex::encode(identity.puzzle_hash.bytes());
            self.identities.insert(name.to_string(), result.clone());
            self.pubkeys.insert(result.clone(), identity);
            result
        };

        Ok(format!("\"{public_key}\"\n"))
    }

    fn create_spendable(&mut self, who: &str, target: &str, amt: u64) -> StringWithError {
        let target_ph_bytes: Vec<u8> =
            hex::decode(target).map_err(|_| Error::StrErr("bad target hex".to_string()))?;
        let target_ph = PuzzleHash::from_hash(Hash::from_slice(&target_ph_bytes));
        let identity = self.lookup_identity(who).cloned();
        if let Some(identity) = identity {
            let coins0 = self
                .simulator
                .get_my_coins(&identity.puzzle_hash)
                .into_gen()?;
            let coin_amt = Amount::new(amt);
            for c in coins0.iter() {
                if let Some((_, _ph, amt)) = c.to_parts() {
                    if amt >= coin_amt {
                        let (parent_coin_0, _rest_0) = self.simulator.transfer_coin_amount(
                            &mut self.allocator,
                            &target_ph,
                            &identity,
                            c,
                            coin_amt.clone(),
                        )?;
                        let parent_coin_bytes = parent_coin_0.to_bytes();
                        self.wait_block()?;
                        return Ok(format!("\"{}\"\n", hex::encode(parent_coin_bytes)));
                    }
                }
            }
        }

        Ok("null\n".to_string())
    }

    fn spend(&mut self, blob: &str) -> StringWithError {
        let spend_program = Program::from_hex(blob)?;
        let spend_node = spend_program.to_nodeptr(&mut self.allocator)?;
        let spend_bundle = SpendBundle::from_clvm(&mut self.allocator, spend_node)?;
        debug!("spend with bundle {spend_bundle:?}");
        let result = self
            .simulator
            .push_tx(&mut self.allocator, &spend_bundle.spends)
            .into_gen()?;
        let e_res = result
            .e
            .map(|e| format!("{e}"))
            .unwrap_or_else(|| "null".to_string());
        Ok(format!("[{},{e_res}]\n", result.code))
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

fn pass_on_request(
    req: &mut Request,
    response: &mut Response,
    wr: WebRequest,
) -> Result<(), String> {
    debug!("pass on request {wr:?}");

    let locked = ONE_REQUEST.lock().unwrap();

    {
        let to_web = TO_WEB.0.lock().unwrap();
        (*to_web).send(wr).unwrap();
    }

    let from_web = FROM_WEB.1.lock().unwrap();
    let result = (*from_web).recv().unwrap();
    drop(locked);

    result.report_err().and_then(|r| {
        cors_origin(req, response)?;

        let response_bytes: Vec<u8> = r.bytes().collect();
        response.replace_body(ResBody::Once(Bytes::from(response_bytes)));
        Ok(())
    })
}

#[handler]
async fn get_current_peak(req: &mut Request, response: &mut Response) -> Result<(), String> {
    pass_on_request(req, response, WebRequest::GetCurrentPeak)
}

fn get_arg_string(req: &mut Request, name: &str) -> Result<String, Error> {
    let uri_string = req.uri().to_string();
    let want_string = format!("{name}=");
    if let Some(found_eq) = uri_string.find(&want_string) {
        let arg: String = uri_string
            .chars()
            .skip(found_eq + want_string.len())
            .take_while(|c| *c != '&')
            .collect();
        return Ok(arg);
    }

    Err(Error::StrErr("no argument".to_string()))
}

fn get_arg_integer(req: &mut Request, name: &str) -> Result<u64, Error> {
    let arg = get_arg_string(req, name)?;
    arg.parse::<u64>()
        .map_err(|_e| Error::StrErr(format!("{name} is not an integer")))
}

#[handler]
async fn get_block_data(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let arg = get_arg_integer(req, "block").report_err()?;
    pass_on_request(req, response, WebRequest::GetBlockData(arg))
}

#[handler]
async fn exit(_req: &mut Request) -> Result<String, String> {
    std::process::exit(0);
}

#[handler]
async fn reset(req: &mut Request, response: &mut Response) -> Result<(), String> {
    pass_on_request(req, response, WebRequest::Reset)
}

#[handler]
async fn register(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let arg = get_arg_string(req, "name").report_err()?;
    pass_on_request(req, response, WebRequest::Register(arg))
}

#[handler]
async fn get_peak(req: &mut Request, response: &mut Response) -> Result<(), String> {
    pass_on_request(req, response, WebRequest::GetCurrentPeak)
}

#[handler]
async fn wait_block(req: &mut Request, response: &mut Response) -> Result<(), String> {
    pass_on_request(req, response, WebRequest::WaitBlock)
}

#[handler]
async fn get_puzzle_and_solution(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let arg = get_arg_string(req, "coin").report_err()?;
    pass_on_request(req, response, WebRequest::GetPuzzleAndSolution(arg))
}

#[handler]
async fn create_spendable(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let who = get_arg_string(req, "who").report_err()?;
    let target = get_arg_string(req, "target").report_err()?;
    let amount = get_arg_integer(req, "amount").report_err()?;
    pass_on_request(
        req,
        response,
        WebRequest::CreateSpendable(who, target, amount),
    )
}

#[handler]
async fn spend(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let blob = get_arg_string(req, "blob").report_err()?;
    pass_on_request(req, response, WebRequest::Spend(blob))
}

fn cors_origin(req: &mut Request, response: &mut Response) -> Result<(), String> {
    let origin_header: Option<String> = req.header("Origin");
    if let Some(origin) = origin_header {
        response
            .add_header("Access-Control-Allow-Origin", origin, true)
            .map_err(|e| format!("{e:?}"))?;
    }
    Ok(())
}

#[handler]
async fn cors(req: &mut Request, response: &mut Response) -> Result<(), String> {
    cors_origin(req, response)?;
    response.replace_body(ResBody::Once(Bytes::from(Vec::new())));
    Ok(())
}

fn service_main_inner() {
    let args = std::env::args();
    let args_vec: Vec<String> = args.collect();
    let rt = tokio::runtime::Runtime::new().unwrap();

    rt.block_on(async {
        let router = Router::new()
            .get(index)
            .push(Router::with_path("index.css").get(index_css))
            .push(Router::with_path("index.js").get(index_js))
            .push(Router::with_path("player.html").get(player_html))
            .push(Router::with_path("player.js").get(player_js))
            .push(Router::with_path("exit").post(exit))
            .push(Router::with_path("reset").post(reset))
            .push(Router::with_path("register").options(cors))
            .push(Router::with_path("register").post(register))
            .push(Router::with_path("get_peak").options(cors))
            .push(Router::with_path("get_peak").post(get_peak))
            .push(Router::with_path("get_block_data").options(cors))
            .push(Router::with_path("get_block_data").post(get_block_data))
            .push(Router::with_path("wait_block").options(cors))
            .push(Router::with_path("wait_block").post(wait_block))
            .push(Router::with_path("get_puzzle_and_solution").options(cors))
            .push(Router::with_path("get_puzzle_and_solution").post(get_puzzle_and_solution))
            .push(Router::with_path("spend").options(cors))
            .push(Router::with_path("spend").post(spend))
            .push(Router::with_path("create_spendable").options(cors))
            .push(Router::with_path("create_spendable").post(create_spendable));
        let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;

        let s = std::thread::spawn(move || { std::panic::catch_unwind(move || {
            debug!("starting simulator thread");
            let simulator = Simulator::default();
            debug!("have simulator");
            let coinset_adapter = FullCoinSetAdapter::default();
            let mut game_runner = GameRunner::new(simulator, coinset_adapter)
                .map_err(|e| format!("{e}"))
                .unwrap();
            debug!("have game runner");

            loop {
                debug!("simulator thread getting request");
                let request = {
                    let channel = TO_WEB.1.lock().unwrap();
                    (*channel).recv().unwrap()
                };

                if true { // !matches!(request, WebRequest::GetBlockData(_) | WebRequest::WaitBlock) {
                    debug!("request {request:?}");
                }
                let result = {
                    match request {
                        WebRequest::Register(name) => game_runner.register(&name),
                        WebRequest::GetCurrentPeak => {
                            let result = game_runner.simulator.get_current_height();
                            Ok(format!("{result}\n"))
                        }
                        WebRequest::GetBlockData(n) => game_runner.get_block_data(n),
                        WebRequest::WaitBlock => {
                            let result = game_runner.wait_block();
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(1000));
                                let channel = FROM_WEB.0.lock().unwrap();
                                (*channel).send(result).unwrap();
                            });
                            continue;
                        }
                        WebRequest::GetPuzzleAndSolution(coin) => {
                            game_runner.get_puzzle_and_solution(&coin)
                        }
                        WebRequest::CreateSpendable(who, target, amt) => {
                            game_runner.create_spendable(&who, &target, amt)
                        }
                        WebRequest::Spend(blob) => game_runner.spend(&blob),
                        WebRequest::Reset => game_runner.reset_sim(),
                    }
                };

                {
                    let channel = FROM_WEB.0.lock().unwrap();
                    (*channel).send(result).unwrap();
                }
            }
        }).map_err(|e| {
            eprintln!("error bringing up simulator thread: {e:?}");
            std::process::exit(0);
        }) });

        println!("port 5800.  press return to exit gracefully...");
        let t = std::thread::spawn(|| {
            let mut buffer = String::default();
            if !matches!(stdin().read_line(&mut buffer), Ok(0)) {
                println!("simulator server stopping");
                std::process::exit(0);
            }
        });

        println!("doing actual service");
        Server::new(acceptor).serve(router).await;
        s.join().unwrap();
        t.join().unwrap();
    })
}

#[pyfunction]
pub fn service_main() {
    if let Err(e) = std::panic::catch_unwind(|| {
        Python::with_gil(|py| {
            py.allow_threads(|| { service_main_inner(); })
        })
    }) {
        eprintln!("panic: {e:?}");
        std::process::exit(1);
    }
}
