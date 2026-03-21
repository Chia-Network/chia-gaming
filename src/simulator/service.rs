use std::collections::BTreeMap;
use std::fs;
use std::io::stdin;
use std::mem::swap;
use std::time::Duration;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use serde::{Deserialize, Serialize};
use serde_json;
use serde_json::{Map, Value};
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::common::constants::{CREATE_COIN, SINGLETON_LAUNCHER_HASH};
use crate::common::standard_coin::standard_solution_partial;
use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    check_for_hex, convert_coinset_org_spend_to_spend, map_m, Aggsig, AllocEncoder, Amount, CoinID,
    CoinSpend, CoinString, CoinsetCoin, CoinsetSpendBundle, CoinsetSpendRecord, Error, Hash,
    IntoErr, PrivateKey, Program, PuzzleHash, SpendBundle,
};
use crate::peer_container::{FullCoinSetAdapter, WatchReport};
use crate::simulator::Simulator;
use clvm_traits::ToClvm;

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

fn hex_to_bytes(hexstr: &str) -> Result<Vec<u8>, Error> {
    hex::decode(hexstr).map_err(|_e| Error::StrErr("not hex".to_string()))
}

#[derive(Serialize)]
struct CoinsetBlockSpends {
    block_spends: Vec<CoinsetSpendRecord>,
}

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

type StringWithError = Result<String, Error>;

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
        let new_coins = self.simulator.get_all_coins()?;
        let watch_report = self
            .coinset_adapter
            .make_report_from_coin_set_update(new_height, &new_coins)?;
        self.sim_record.insert(new_height, watch_report);
        Ok(new_height)
    }

    fn wait_block(&mut self) -> StringWithError {
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

    fn get_balance(&self, who: &str) -> StringWithError {
        let identity = self.lookup_identity(who).cloned();
        let mut result_balance: u64 = 0;
        if let Some(pk) = identity {
            for coin in self.simulator.get_my_coins(&pk.puzzle_hash)?.iter() {
                if let Some((_, _, amt)) = coin.to_parts() {
                    result_balance += amt.to_u64();
                }
            }
        }
        Ok(result_balance.to_string())
    }

    fn get_puzzle_and_solution(&self, coin: &str) -> StringWithError {
        let bytes = hex_to_bytes(coin)?;
        let coin_id = if bytes.len() > 32 {
            let cs = CoinString::from_bytes(&bytes);
            cs.to_coin_id()
        } else {
            CoinID::new(Hash::from_slice(&bytes)?)
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
        let target_ph = PuzzleHash::from_hash(Hash::from_slice(&target_ph_bytes)?);
        let identity = self.lookup_identity(who).cloned();
        if let Some(identity) = identity {
            let coins0 = self.simulator.get_my_coins(&identity.puzzle_hash)?;
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

    fn select_coins(&self, who: &str, amount: u64) -> StringWithError {
        let identity = self.lookup_identity(who).cloned();
        if let Some(identity) = identity {
            let mut candidates = self.simulator.get_my_coins(&identity.puzzle_hash)?;
            candidates.retain(|c| {
                c.to_parts()
                    .map(|(_, _, amt)| amt.to_u64() >= amount)
                    .unwrap_or(false)
            });
            if let Some(selected) = candidates.into_iter().min_by_key(|c| {
                c.to_parts()
                    .map(|(_, _, amt)| amt.to_u64())
                    .unwrap_or(u64::MAX)
            }) {
                return Ok(format!("\"{}\"\n", hex::encode(selected.to_bytes())));
            }
        }
        Ok("null\n".to_string())
    }

    fn create_offer_for_ids(
        &mut self,
        who: &str,
        req: &CreateOfferForIdsRequest,
    ) -> StringWithError {
        let identity = self
            .lookup_identity(who)
            .cloned()
            .ok_or_else(|| Error::StrErr(format!("unknown wallet user: {who}")))?;

        let requested_amount = req
            .offer
            .values()
            .filter(|v| **v < 0)
            .map(|v| (-*v) as u64)
            .max()
            .ok_or_else(|| Error::StrErr("offer does not request any spend amount".to_string()))?;

        let mut candidates = self.simulator.get_my_coins(&identity.puzzle_hash)?;
        candidates.retain(|c| {
            c.to_parts()
                .map(|(_, _, amt)| amt.to_u64() >= requested_amount)
                .unwrap_or(false)
        });

        let selected_coin = if let Some(first_coin_id) = req.coin_ids.first() {
            let expected_bytes = check_for_hex(first_coin_id)?;
            let expected_id = CoinID::new(Hash::from_slice(&expected_bytes)?);
            candidates
                .into_iter()
                .find(|coin| coin.to_coin_id() == expected_id)
                .ok_or_else(|| Error::StrErr("requested coin id not found".to_string()))?
        } else {
            candidates
                .into_iter()
                .min_by_key(|c| {
                    c.to_parts()
                        .map(|(_, _, amt)| amt.to_u64())
                        .unwrap_or(u64::MAX)
                })
                .ok_or_else(|| {
                    Error::StrErr("no spendable coin for requested amount".to_string())
                })?
        };

        let mut create_targets: Vec<(PuzzleHash, Amount)> = Vec::new();
        if !req.coin_ids.is_empty() {
            create_targets.push((
                PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH),
                Amount::default(),
            ));
        }

        let env = ChannelHandlerEnv::new(&mut self.allocator)?;
        let clvm_conditions: Vec<(u32, (PuzzleHash, (Amount, ())))> = create_targets
            .iter()
            .map(|(ph, amt)| (CREATE_COIN, (ph.clone(), (amt.clone(), ()))))
            .collect();
        let conditions_clvm = clvm_conditions.to_clvm(env.allocator).into_gen()?;

        let spend = standard_solution_partial(
            env.allocator,
            &identity.synthetic_private_key,
            &selected_coin.to_coin_id(),
            conditions_clvm,
            &identity.synthetic_public_key,
            &env.agg_sig_me_additional_data,
            false,
        )?;

        let (parent, puzzle_hash, amount) = selected_coin
            .to_parts()
            .ok_or_else(|| Error::StrErr("selected coin missing parts".to_string()))?;
        let result = CoinsetSpendBundle {
            aggregated_signature: format!("0x{}", hex::encode(spend.signature.bytes())),
            coin_spends: vec![CoinsetSpendRecord {
                coin: CoinsetCoin {
                    parent_coin_info: format!("0x{}", hex::encode(parent.bytes())),
                    puzzle_hash: format!("0x{}", hex::encode(puzzle_hash.bytes())),
                    amount: amount.to_u64(),
                },
                puzzle_reveal: format!("0x{}", identity.puzzle.to_program().to_hex()),
                solution: format!("0x{}", spend.solution.p().to_hex()),
            }],
        };

        serde_json::to_string(&result).into_gen()
    }

    fn spend_list_of_spends(&mut self, spends: &[CoinSpend]) -> StringWithError {
        let result = self.simulator.push_tx(&mut self.allocator, spends)?;
        let e_res = result
            .e
            .map(|e| format!("{e}"))
            .unwrap_or_else(|| "null".to_string());
        Ok(format!("[{},{e_res}]\n", result.code))
    }

    fn spend(&mut self, blob: &str) -> StringWithError {
        let spend_program = Program::from_hex(blob)?;
        let spend_node = spend_program.to_nodeptr(&mut self.allocator)?;
        let spend_bundle = SpendBundle::from_clvm(&self.allocator, spend_node)?;
        self.spend_list_of_spends(&spend_bundle.spends)
    }

    fn push_tx(&mut self, spend_decoded: &CoinsetSpendBundle) -> StringWithError {
        let aggsig_bytes = check_for_hex(&spend_decoded.aggregated_signature)?;
        let aggsig = Aggsig::from_slice(&aggsig_bytes)?;
        let mut spends: Vec<CoinSpend> = map_m(
            |spend_data| {
                convert_coinset_org_spend_to_spend(
                    &spend_data.coin.parent_coin_info,
                    &spend_data.coin.puzzle_hash,
                    spend_data.coin.amount,
                    &spend_data.puzzle_reveal,
                    &spend_data.solution,
                )
            },
            &spend_decoded.coin_spends,
        )?;
        if !spends.is_empty() {
            spends[0].bundle.signature = aggsig;
        }
        self.spend_list_of_spends(&spends)
    }

    fn block_spends(&mut self, height: u64) -> StringWithError {
        let spends = self.sim_record.get(&height).map(|report| {
            let block_spend_data: Vec<CoinsetSpendRecord> = report
                .deleted_watched
                .iter()
                .filter_map(|c| {
                    c.to_parts().and_then(|(parent, ph, amt)| {
                        self.simulator
                            .get_puzzle_and_solution(&c.to_coin_id())
                            .ok()
                            .unwrap_or_default()
                            .map(|(puzzle, solution)| CoinsetSpendRecord {
                                coin: CoinsetCoin {
                                    parent_coin_info: format!("0x{}", hex::encode(parent.bytes())),
                                    puzzle_hash: format!("0x{}", hex::encode(ph.bytes())),
                                    amount: amt.into(),
                                },
                                puzzle_reveal: format!("0x{}", hex::encode(puzzle.bytes())),
                                solution: format!("0x{}", hex::encode(solution.bytes())),
                            })
                    })
                })
                .collect();
            CoinsetBlockSpends {
                block_spends: block_spend_data,
            }
        });
        let value = serde_json::to_value(&spends).into_gen()?;
        let serialized = serde_json::to_string(&value).into_gen()?;
        Ok(serialized)
    }
}

fn get_arg_string(url: &str, name: &str) -> Result<String, Error> {
    let want_string = format!("{name}=");
    if let Some(found_eq) = url.find(&want_string) {
        let arg: String = url
            .chars()
            .skip(found_eq + want_string.len())
            .take_while(|c| *c != '&')
            .collect();
        return Ok(arg);
    }

    Err(Error::StrErr("no argument".to_string()))
}

fn get_arg_integer(url: &str, name: &str) -> Result<u64, Error> {
    let arg = get_arg_string(url, name)?;
    arg.parse::<u64>()
        .map_err(|_e| Error::StrErr(format!("{name} is not an integer")))
}

fn get_origin(request: &tiny_http::Request) -> Option<String> {
    for header in request.headers() {
        if header.field.as_str() == "Origin" || header.field.as_str() == "origin" {
            return Some(header.value.as_str().to_string());
        }
    }
    None
}

fn cors_headers(origin: &Option<String>) -> Vec<Header> {
    let mut headers = Vec::new();
    if let Some(ref o) = origin {
        if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], o.as_bytes()) {
            headers.push(h);
        }
    }
    headers
}

fn respond_cors_preflight(request: tiny_http::Request, origin: &Option<String>) {
    let mut response = Response::from_data(Vec::new());
    for h in cors_headers(origin) {
        response.add_header(h);
    }
    if let Ok(h) = Header::from_bytes(
        &b"Access-Control-Allow-Methods"[..],
        &b"POST, GET, OPTIONS"[..],
    ) {
        response.add_header(h);
    }
    if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"content-type"[..]) {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn respond_ok(request: tiny_http::Request, body: String, origin: &Option<String>) {
    let data = body.into_bytes();
    let mut response = Response::from_data(data).with_header(
        Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..]).unwrap(),
    );
    for h in cors_headers(origin) {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn respond_err(request: tiny_http::Request, msg: String) {
    let response = Response::from_data(msg.into_bytes()).with_status_code(StatusCode(500));
    let _ = request.respond(response);
}

fn respond_file(request: tiny_http::Request, path: &str, content_type: &str) {
    match fs::read_to_string(path) {
        Ok(content) => {
            let response = Response::from_data(content.into_bytes()).with_header(
                Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
            );
            let _ = request.respond(response);
        }
        Err(e) => {
            let response = Response::from_data(format!("{e:?}").into_bytes())
                .with_status_code(StatusCode(404));
            let _ = request.respond(response);
        }
    }
}

fn respond_not_found(request: tiny_http::Request) {
    let response = Response::from_data(b"not found".to_vec()).with_status_code(StatusCode(404));
    let _ = request.respond(response);
}

#[derive(Serialize, Deserialize)]
struct PushTxRequest {
    spend_bundle: CoinsetSpendBundle,
}

#[derive(Serialize, Deserialize, Default)]
struct CreateOfferForIdsRequest {
    offer: BTreeMap<String, i64>,
    #[serde(default, rename = "coinIds")]
    coin_ids: Vec<String>,
}

fn url_path(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

fn service_main_inner() {
    let server = Server::http("0.0.0.0:5800").expect("failed to bind port 5800");

    let simulator = Simulator::default();
    let coinset_adapter = FullCoinSetAdapter::default();
    let mut game_runner = GameRunner::new(simulator, coinset_adapter)
        .map_err(|e| format!("{e}"))
        .unwrap();

    println!("port 5800.  press return to exit gracefully...");

    std::thread::spawn(|| {
        let mut buffer = String::default();
        if !matches!(stdin().read_line(&mut buffer), Ok(0)) {
            println!("simulator server stopping");
            std::process::exit(0);
        }
    });

    println!("doing actual service");
    loop {
        let mut request = match server.recv() {
            Ok(rq) => rq,
            Err(e) => {
                eprintln!("recv error: {e}");
                continue;
            }
        };

        let url = request.url().to_string();
        let path = url_path(&url);
        let method = request.method().clone();
        let origin = get_origin(&request);

        if method == Method::Options {
            respond_cors_preflight(request, &origin);
            continue;
        }

        match (method, path) {
            (Method::Get, "/") => {
                respond_file(request, "resources/web/index.html", "text/html");
            }
            (Method::Get, "/index.css") => {
                respond_file(request, "resources/web/index.css", "text/css");
            }
            (Method::Get, "/index.js") => {
                respond_file(request, "resources/web/index.js", "text/javascript");
            }
            (Method::Get, "/player.html") => {
                respond_file(request, "resources/web/player.html", "text/html");
            }
            (Method::Get, "/player.js") => {
                respond_file(request, "resources/web/player.js", "text/javascript");
            }
            (Method::Post, "/exit") => {
                let _ = request.respond(Response::from_data(Vec::new()));
                std::process::exit(0);
            }
            (Method::Post, "/reset") => match game_runner.reset_sim().report_err() {
                Ok(body) => respond_ok(request, body, &origin),
                Err(msg) => respond_err(request, msg),
            },
            (Method::Post, "/register") => {
                match get_arg_string(&url, "name")
                    .and_then(|name| game_runner.register(&name))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/get_peak") => {
                let result = game_runner.simulator.get_current_height();
                respond_ok(request, format!("{result}\n"), &origin);
            }
            (Method::Post, "/get_block_data") => {
                match get_arg_integer(&url, "block")
                    .and_then(|n| game_runner.get_block_data(n))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/get_balance") => {
                match get_arg_string(&url, "user")
                    .and_then(|user| game_runner.get_balance(&user))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/wait_block") => {
                let result = game_runner.wait_block();
                std::thread::sleep(Duration::from_millis(1000));
                match result.report_err() {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/get_puzzle_and_solution") => {
                match get_arg_string(&url, "coin")
                    .and_then(|coin| game_runner.get_puzzle_and_solution(&coin))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/create_spendable") => {
                match (|| -> Result<String, Error> {
                    let who = get_arg_string(&url, "who")?;
                    let target = get_arg_string(&url, "target")?;
                    let amount = get_arg_integer(&url, "amount")?;
                    game_runner.create_spendable(&who, &target, amount)
                })()
                .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/select_coins") => {
                match (|| -> Result<String, Error> {
                    let who = get_arg_string(&url, "who")?;
                    let amount = get_arg_integer(&url, "amount")?;
                    game_runner.select_coins(&who, amount)
                })()
                .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/create_offer_for_ids") => {
                let mut body_bytes = Vec::new();
                match std::io::Read::read_to_end(request.as_reader(), &mut body_bytes) {
                    Ok(_) => {
                        match serde_json::from_slice::<CreateOfferForIdsRequest>(&body_bytes) {
                            Ok(decoded) => {
                                let who = get_arg_string(&url, "who");
                                match who
                                    .and_then(|who| {
                                        game_runner.create_offer_for_ids(&who, &decoded)
                                    })
                                    .report_err()
                                {
                                    Ok(resp) => respond_ok(request, resp, &origin),
                                    Err(msg) => respond_err(request, msg),
                                }
                            }
                            Err(e) => respond_err(request, format!("{{\"error\":\"{e}\"}}")),
                        }
                    }
                    Err(e) => respond_err(request, format!("{{\"error\":\"read error: {e}\"}}")),
                }
            }
            (Method::Post, "/spend") => {
                match get_arg_string(&url, "blob")
                    .and_then(|blob| game_runner.spend(&blob))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/block_spends") => {
                match get_arg_integer(&url, "header_hash")
                    .and_then(|h| game_runner.block_spends(h))
                    .report_err()
                {
                    Ok(body) => respond_ok(request, body, &origin),
                    Err(msg) => respond_err(request, msg),
                }
            }
            (Method::Post, "/push_tx") => {
                let mut body_bytes = Vec::new();
                match std::io::Read::read_to_end(request.as_reader(), &mut body_bytes) {
                    Ok(_) => match serde_json::from_slice::<PushTxRequest>(&body_bytes) {
                        Ok(decoded) => {
                            match game_runner.push_tx(&decoded.spend_bundle).report_err() {
                                Ok(resp) => respond_ok(request, resp, &origin),
                                Err(msg) => respond_err(request, msg),
                            }
                        }
                        Err(e) => {
                            respond_err(request, format!("{{\"error\":\"{e}\"}}"));
                        }
                    },
                    Err(e) => {
                        respond_err(request, format!("{{\"error\":\"read error: {e}\"}}"));
                    }
                }
            }
            _ => {
                respond_not_found(request);
            }
        }
    }
}

pub fn service_main() {
    if let Err(e) = std::panic::catch_unwind(|| {
        service_main_inner();
    }) {
        eprintln!("panic: {e:?}");
        std::process::exit(1);
    }
}
