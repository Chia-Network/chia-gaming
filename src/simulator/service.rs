use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::stdin;
use std::mem::swap;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use serde::{Deserialize, Serialize};
use serde_json::{self, Value};
use tiny_http::{Header, Response, Server, StatusCode};
use tungstenite::{Message, WebSocket};

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::common::constants::{
    ASSERT_BEFORE_HEIGHT_ABSOLUTE, ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN, CREATE_COIN_ANNOUNCEMENT,
};
use crate::common::standard_coin::standard_solution_partial;
use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    check_for_hex, convert_coinset_org_spend_to_spend, map_m, u64_from_atom, Aggsig, AllocEncoder,
    Amount, CoinID, CoinSpend, CoinString, CoinsetCoin, CoinsetSpendBundle, CoinsetSpendRecord,
    Error, Hash, IntoErr, Node, PrivateKey, Program, PuzzleHash, SpendBundle,
};
use crate::peer_container::{FullCoinSetAdapter, WatchReport};
use crate::simulator::Simulator;
use clvm_traits::Atom;
use clvm_traits::ClvmEncoder;
use clvm_traits::ToClvm;

// ---------------------------------------------------------------------------
// WebSocket protocol types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WsRequest {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct WsResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct WsBlockEvent {
    event: &'static str,
    peak: u64,
    records: Vec<Value>,
}

// ---------------------------------------------------------------------------
// GameRunner (unchanged business logic)
// ---------------------------------------------------------------------------

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

    fn farm_and_chase(&mut self) -> Result<u64, Error> {
        self.simulator
            .farm_block(&self.neutral_identity.puzzle_hash);
        self.chase_block()
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
                        self.farm_and_chase()?;
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

        let (_, _, coin_amount) = selected_coin
            .to_parts()
            .ok_or_else(|| Error::StrErr("selected coin missing parts".to_string()))?;

        // Build conditions that mimic a real wallet's createOfferForIds: the
        // spend is balanced because the requested amount goes to a settlement
        // payment output.  claim_settlement_coins strips these later.
        let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
        let change = coin_amount.to_u64().saturating_sub(requested_amount);

        let mut create_targets: Vec<(PuzzleHash, Amount)> = Vec::new();
        create_targets.push((settlement_ph, Amount::new(requested_amount)));
        if change > 0 {
            create_targets.push((identity.puzzle_hash.clone(), Amount::new(change)));
        }

        let mut atom_conditions: Vec<(u32, Vec<u8>)> = Vec::new();
        for ec in &req.extra_conditions {
            match ec.opcode {
                CREATE_COIN => {
                    if ec.args.len() < 2 {
                        return Err(Error::StrErr(
                            "CREATE_COIN extra condition missing args".to_string(),
                        ));
                    }
                    let ph_bytes = check_for_hex(&ec.args[0])?;
                    if ph_bytes.len() != 32 {
                        return Err(Error::StrErr(
                            "CREATE_COIN puzzle hash must be 32 bytes".to_string(),
                        ));
                    }
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&ph_bytes);
                    let amt_bytes = check_for_hex(&ec.args[1])?;
                    let amt_val = u64_from_atom(&amt_bytes).ok_or_else(|| {
                        Error::StrErr("CREATE_COIN amount is not a valid CLVM int".to_string())
                    })?;
                    create_targets.push((PuzzleHash::from_bytes(arr), Amount::new(amt_val)));
                }
                ASSERT_COIN_ANNOUNCEMENT | CREATE_COIN_ANNOUNCEMENT => {
                    if ec.args.len() != 1 {
                        return Err(Error::StrErr(format!(
                            "announcement condition opcode {} must have exactly one arg",
                            ec.opcode
                        )));
                    }
                    let arg = check_for_hex(&ec.args[0])?;
                    if ec.opcode == ASSERT_COIN_ANNOUNCEMENT && arg.len() != 32 {
                        return Err(Error::StrErr(
                            "ASSERT_COIN_ANNOUNCEMENT arg must be 32-byte announcement id"
                                .to_string(),
                        ));
                    }
                    atom_conditions.push((ec.opcode, arg));
                }
                ASSERT_BEFORE_HEIGHT_ABSOLUTE => {
                    if ec.args.len() != 1 {
                        return Err(Error::StrErr(
                            "ASSERT_BEFORE_HEIGHT_ABSOLUTE must have exactly one arg".to_string(),
                        ));
                    }
                    let arg = check_for_hex(&ec.args[0])?;
                    if u64_from_atom(&arg).is_none() {
                        return Err(Error::StrErr(
                            "ASSERT_BEFORE_HEIGHT_ABSOLUTE arg is not a valid CLVM int".to_string(),
                        ));
                    }
                    atom_conditions.push((ec.opcode, arg));
                }
                _ => {
                    return Err(Error::StrErr(format!(
                        "unsupported extra condition opcode {} in simulator create_offer_for_ids",
                        ec.opcode
                    )));
                }
            }
        }

        let env = ChannelHandlerEnv::new(&mut self.allocator)?;
        let mut condition_nodes: Vec<Node> = create_targets
            .iter()
            .map(|(ph, amt)| {
                (CREATE_COIN, (ph.clone(), (amt.clone(), ())))
                    .to_clvm(env.allocator)
                    .map(Node)
                    .map_err(|e| Error::StrErr(format!("{e:?}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        for (opcode, arg) in atom_conditions {
            let arg_node = Node(
                env.allocator
                    .encode_atom(Atom::Borrowed(arg.as_slice()))
                    .into_gen()?,
            );
            let cond_node = (opcode, (arg_node, ())).to_clvm(env.allocator).into_gen()?;
            condition_nodes.push(Node(cond_node));
        }
        let conditions_clvm = condition_nodes.to_clvm(env.allocator).into_gen()?;

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
        if result.code != 1 && !result.diagnostic.is_empty() {
            Ok(format!(
                "[{},{e_res},{}]\n",
                result.code,
                serde_json::to_string(&result.diagnostic).unwrap_or_default()
            ))
        } else {
            Ok(format!("[{},{e_res}]\n", result.code))
        }
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

    fn coin_record_json(&self, coin_id: &CoinID) -> Option<Value> {
        let (coin, created_height, spent_height) =
            self.simulator.get_watched_coin_snapshot(coin_id)?;
        let (parent, puzzle_hash, amount) = coin.to_parts()?;
        Some(serde_json::json!({
            "coin": {
                "parentCoinInfo": format!("0x{}", hex::encode(parent.bytes())),
                "puzzleHash": format!("0x{}", hex::encode(puzzle_hash.bytes())),
                "amount": amount.to_u64(),
            },
            "confirmedBlockIndex": created_height,
            "spentBlockIndex": spent_height.unwrap_or(0),
            "spent": spent_height.is_some(),
            "coinbase": false,
            "timestamp": 0,
        }))
    }

    /// JSON array of coin records gated to registered coins.
    fn get_coin_records_by_names(
        &self,
        params: &Value,
        registered_coins: &HashSet<CoinID>,
    ) -> StringWithError {
        let names = params
            .get("names")
            .and_then(|v| v.as_array())
            .ok_or_else(|| Error::StrErr("missing names array".to_string()))?;
        let mut records = Vec::new();
        for name_val in names {
            let Some(name_hex) = name_val.as_str() else {
                continue;
            };
            let bytes = match check_for_hex(name_hex) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let hash = match Hash::from_slice(&bytes) {
                Ok(h) => h,
                Err(_) => continue,
            };
            let coin_id = CoinID::new(hash);
            if !registered_coins.contains(&coin_id) {
                continue;
            }
            if let Some(rec) = self.coin_record_json(&coin_id) {
                records.push(rec);
            }
        }
        Ok(format!(
            "{}\n",
            serde_json::to_string(&records).map_err(|e| Error::StrErr(format!("{e}")))?
        ))
    }

    fn registered_coin_records(&self, registered_coins: &HashSet<CoinID>) -> Vec<Value> {
        let mut records = Vec::new();
        for coin_id in registered_coins {
            if let Some(rec) = self.coin_record_json(coin_id) {
                records.push(rec);
            }
        }
        records
    }
}

// ---------------------------------------------------------------------------
// Request / response helper types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct PushTxRequest {
    spend_bundle: CoinsetSpendBundle,
}

#[derive(Serialize, Deserialize, Default)]
struct ExtraCondition {
    opcode: u32,
    args: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct CreateOfferForIdsRequest {
    offer: BTreeMap<String, i64>,
    #[serde(default, rename = "coinIds")]
    coin_ids: Vec<String>,
    #[serde(default, rename = "extraConditions")]
    extra_conditions: Vec<ExtraCondition>,
}

// ---------------------------------------------------------------------------
// WebSocket message dispatch
// ---------------------------------------------------------------------------

fn make_block_event_json_for_client(
    game_runner: &GameRunner,
    height: u64,
    registered_coins: &HashSet<CoinID>,
) -> String {
    let records = game_runner.registered_coin_records(registered_coins);
    let evt = WsBlockEvent {
        event: "block",
        peak: height,
        records,
    };
    serde_json::to_string(&evt).unwrap_or_default()
}

/// Parse a GameRunner method result (which is a JSON-encoded string body)
/// into a serde_json::Value so it can be embedded directly in the response.
fn parse_result_body(body: &str) -> Value {
    serde_json::from_str(body.trim()).unwrap_or(Value::String(body.trim().to_string()))
}

struct DispatchResult {
    response: String,
    extra_messages: Vec<String>,
}

fn get_str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, Error> {
    params[name]
        .as_str()
        .ok_or_else(|| Error::StrErr(format!("missing param: {name}")))
}

fn get_u64_param(params: &Value, name: &str) -> Result<u64, Error> {
    params[name]
        .as_u64()
        .ok_or_else(|| Error::StrErr(format!("missing param: {name}")))
}

fn register_remote_coins(
    params: &Value,
    registered_coins: &mut HashSet<CoinID>,
) -> StringWithError {
    let coin_ids = params
        .get("coinIds")
        .and_then(|v| v.as_array())
        .ok_or_else(|| Error::StrErr("missing coinIds array".to_string()))?;
    for id_val in coin_ids {
        let Some(hex_str) = id_val.as_str() else {
            continue;
        };
        let bytes = match check_for_hex(hex_str) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let hash = match Hash::from_slice(&bytes) {
            Ok(h) => h,
            Err(_) => continue,
        };
        registered_coins.insert(CoinID::new(hash));
    }
    Ok("true\n".to_string())
}

fn dispatch_ws_request(
    game_runner: &mut GameRunner,
    text: &str,
    registered_coins: &mut HashSet<CoinID>,
) -> DispatchResult {
    let req: WsRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            let resp = WsResponse {
                id: 0,
                result: None,
                error: Some(format!("invalid request JSON: {e}")),
            };
            return DispatchResult {
                response: serde_json::to_string(&resp).unwrap_or_default(),
                extra_messages: vec![],
            };
        }
    };

    let mut extra_messages: Vec<String> = Vec::new();

    let height_before = game_runner.simulator.get_current_height() as u64;

    let result: Result<String, Error> = match req.method.as_str() {
        "register" => {
            let name = get_str_param(&req.params, "name");
            name.and_then(|n| game_runner.register(n))
        }
        "get_peak" => {
            let h = game_runner.simulator.get_current_height();
            Ok(format!("{h}\n"))
        }
        "get_block_data" => {
            let block = get_u64_param(&req.params, "block");
            block.and_then(|b| game_runner.get_block_data(b))
        }
        "get_balance" => {
            let user = get_str_param(&req.params, "user");
            user.and_then(|u| game_runner.get_balance(u))
        }
        "get_puzzle_and_solution" => {
            let coin = get_str_param(&req.params, "coin");
            coin.and_then(|c| game_runner.get_puzzle_and_solution(c))
        }
        "create_spendable" => {
            let who = get_str_param(&req.params, "who").map(|s| s.to_string());
            let target = get_str_param(&req.params, "target").map(|s| s.to_string());
            let amount = get_u64_param(&req.params, "amount");
            match (who, target, amount) {
                (Ok(w), Ok(t), Ok(a)) => game_runner.create_spendable(&w, &t, a),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Err(e),
            }
        }
        "select_coins" => {
            let who = get_str_param(&req.params, "who").map(|s| s.to_string());
            let amount = get_u64_param(&req.params, "amount");
            match (who, amount) {
                (Ok(w), Ok(a)) => game_runner.select_coins(&w, a),
                (Err(e), _) | (_, Err(e)) => Err(e),
            }
        }
        "create_offer_for_ids" => {
            let who = get_str_param(&req.params, "who").map(|s| s.to_string());
            let offer_req: Result<CreateOfferForIdsRequest, Error> =
                serde_json::from_value(req.params.clone())
                    .map_err(|e| Error::StrErr(format!("bad offer params: {e}")));
            match (who, offer_req) {
                (Ok(w), Ok(r)) => game_runner.create_offer_for_ids(&w, &r),
                (Err(e), _) | (_, Err(e)) => Err(e),
            }
        }
        "spend" => {
            let blob = get_str_param(&req.params, "blob");
            blob.and_then(|b| game_runner.spend(b))
        }
        "push_tx" => {
            let push_req: Result<PushTxRequest, Error> = serde_json::from_value(req.params.clone())
                .map_err(|e| Error::StrErr(format!("bad push_tx params: {e}")));
            push_req.and_then(|r| game_runner.push_tx(&r.spend_bundle))
        }
        "block_spends" => {
            let height = get_u64_param(&req.params, "height");
            height.and_then(|h| game_runner.block_spends(h))
        }
        "get_coin_records_by_names" => {
            game_runner.get_coin_records_by_names(&req.params, registered_coins)
        }
        "register_remote_coins" => register_remote_coins(&req.params, registered_coins),
        "reset" => game_runner.reset_sim(),
        "exit" => {
            std::process::exit(0);
        }
        other => Err(Error::StrErr(format!("unknown method: {other}"))),
    };

    let height_after = game_runner.simulator.get_current_height() as u64;
    if height_after > height_before {
        for h in (height_before + 1)..=height_after {
            extra_messages.push(make_block_event_json_for_client(
                game_runner,
                h,
                registered_coins,
            ));
        }
    }

    let resp = match result {
        Ok(body) => WsResponse {
            id: req.id,
            result: Some(parse_result_body(&body)),
            error: None,
        },
        Err(e) => WsResponse {
            id: req.id,
            result: None,
            error: Some(format!("{e:?}")),
        },
    };

    DispatchResult {
        response: serde_json::to_string(&resp).unwrap_or_default(),
        extra_messages,
    }
}

// ---------------------------------------------------------------------------
// tiny_http health/static server (background thread)
// ---------------------------------------------------------------------------

fn url_path(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
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

fn run_health_server(height: Arc<AtomicUsize>) {
    let server = match Server::http("0.0.0.0:5800") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to bind health server on port 5800: {e}");
            return;
        }
    };

    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let path = url_path(&url);

        // CORS preflight
        if request.method() == &tiny_http::Method::Options {
            let _ = request.respond(Response::from_data(Vec::new()));
            continue;
        }

        match path {
            "/get_peak" => {
                let h = height.load(Ordering::Relaxed);
                let _ = request.respond(Response::from_data(format!("{h}\n").into_bytes()));
            }
            "/" => respond_file(request, "resources/web/index.html", "text/html"),
            "/index.css" => respond_file(request, "resources/web/index.css", "text/css"),
            "/index.js" => respond_file(request, "resources/web/index.js", "text/javascript"),
            "/player.html" => respond_file(request, "resources/web/player.html", "text/html"),
            "/player.js" => respond_file(request, "resources/web/player.js", "text/javascript"),
            _ => respond_not_found(request),
        }
    }
}

// ---------------------------------------------------------------------------
// Main event loop
// ---------------------------------------------------------------------------

const BLOCK_INTERVAL_SECS: u64 = 10;

struct ClientState {
    ws: WebSocket<TcpStream>,
    registered_coins: HashSet<CoinID>,
}

fn ws_send(ws: &mut WebSocket<TcpStream>, text: String) -> Result<(), tungstenite::Error> {
    ws.send(Message::Text(text))
}

fn service_main_inner() {
    let simulator = Simulator::default();
    let coinset_adapter = FullCoinSetAdapter::default();
    let mut game_runner = GameRunner::new(simulator, coinset_adapter)
        .map_err(|e| format!("{e}"))
        .unwrap();

    let height = Arc::new(AtomicUsize::new(game_runner.simulator.get_current_height()));

    // Background: tiny_http health + static files on port 5800
    let health_height = height.clone();
    std::thread::spawn(move || run_health_server(health_height));

    // Background: stdin exit
    std::thread::spawn(|| {
        let mut buffer = String::default();
        if !matches!(stdin().read_line(&mut buffer), Ok(0)) {
            println!("simulator server stopping");
            std::process::exit(0);
        }
    });

    // WebSocket API on port 5801
    let ws_listener = TcpListener::bind("0.0.0.0:5801").expect("failed to bind port 5801");
    ws_listener
        .set_nonblocking(true)
        .expect("set_nonblocking failed");

    println!("Simulator: health on :5800, WebSocket API on :5801");

    let mut clients: Vec<ClientState> = Vec::new();
    let mut last_block_time = Instant::now();
    let block_interval = Duration::from_secs(BLOCK_INTERVAL_SECS);

    loop {
        // 1. Accept new WebSocket connections (non-blocking)
        match ws_listener.accept() {
            Ok((stream, addr)) => {
                eprintln!("new TCP connection from {addr}");
                // Accepted socket is blocking by default — handshake completes fast
                match tungstenite::accept(stream) {
                    Ok(ws) => {
                        if let Err(e) = ws.get_ref().set_nonblocking(true) {
                            eprintln!("failed to set ws non-blocking: {e}");
                        } else {
                            clients.push(ClientState {
                                ws,
                                registered_coins: HashSet::new(),
                            });
                            eprintln!("WebSocket client connected ({} total)", clients.len());
                        }
                    }
                    Err(e) => eprintln!("WebSocket handshake error: {e}"),
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No pending connection
            }
            Err(e) => eprintln!("accept error: {e}"),
        }

        // 2. Read incoming WebSocket messages from all clients
        let mut to_remove: Vec<usize> = Vec::new();
        for (i, client) in clients.iter_mut().enumerate() {
            loop {
                match client.ws.read() {
                    Ok(Message::Text(text)) => {
                        let dr = dispatch_ws_request(
                            &mut game_runner,
                            &text,
                            &mut client.registered_coins,
                        );
                        height.store(
                            game_runner.simulator.get_current_height(),
                            Ordering::Relaxed,
                        );
                        if ws_send(&mut client.ws, dr.response).is_err() {
                            to_remove.push(i);
                            break;
                        }
                        for msg in dr.extra_messages {
                            if ws_send(&mut client.ws, msg).is_err() {
                                to_remove.push(i);
                                break;
                            }
                        }
                    }
                    Ok(Message::Ping(data)) => {
                        let _ = client.ws.send(Message::Pong(data));
                    }
                    Ok(Message::Close(_)) => {
                        let _ = client.ws.close(None);
                        to_remove.push(i);
                        break;
                    }
                    Err(tungstenite::Error::Io(ref e))
                        if e.kind() == std::io::ErrorKind::WouldBlock =>
                    {
                        break; // No more messages right now
                    }
                    Err(_) => {
                        to_remove.push(i);
                        break;
                    }
                    _ => {} // Binary, Pong — ignore
                }
            }
        }

        // Remove disconnected clients (reverse order to preserve indices)
        to_remove.sort_unstable();
        to_remove.dedup();
        for i in to_remove.into_iter().rev() {
            clients.remove(i);
            eprintln!(
                "WebSocket client disconnected ({} remaining)",
                clients.len()
            );
        }

        // 3. Block timer: farm a block and push per-client event
        if last_block_time.elapsed() >= block_interval {
            match game_runner.farm_and_chase() {
                Ok(new_height) => {
                    height.store(new_height as usize, Ordering::Relaxed);
                    let mut dead: Vec<usize> = Vec::new();
                    for (i, client) in clients.iter_mut().enumerate() {
                        let evt_json = make_block_event_json_for_client(
                            &game_runner,
                            new_height,
                            &client.registered_coins,
                        );
                        if ws_send(&mut client.ws, evt_json).is_err() {
                            dead.push(i);
                        }
                    }
                    for i in dead.into_iter().rev() {
                        clients.remove(i);
                    }
                }
                Err(e) => eprintln!("farm_and_chase error: {e:?}"),
            }
            last_block_time = Instant::now();
        }

        // 4. Avoid busy-spin
        std::thread::sleep(Duration::from_millis(1));
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
