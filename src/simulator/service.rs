use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::stdin;
use std::mem::swap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use serde::{Deserialize, Serialize};
use serde_json::{self, Value};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch, Notify};

use crate::channel_state::types::ChannelEnv;
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
use crate::game_session::{FullCoinSetAdapter, WatchReport};
use crate::simulator::Simulator;
use clvm_traits::Atom;
use clvm_traits::ClvmEncoder;
use clvm_traits::ToClvm;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/// Format the current wall-clock time as `HH:MM:SS.mmm` in UTC, matching the
/// time-of-day component used by the tracker's ISO8601 lines so simulator and
/// tracker output can be read together easily.
fn sim_ts() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_s = d.as_secs();
    let ms = d.subsec_millis();
    let s = total_s % 60;
    let m = (total_s / 60) % 60;
    let h = (total_s / 3600) % 24;
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

/// Write one diagnostic line to stderr. All simulator log lines flow through
/// this so they share a `[sim] <utc-time>` prefix.
fn sim_log(msg: &str) {
    eprintln!("[sim] {} {msg}", sim_ts());
}

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

        let neutral_pk: PrivateKey = rng.random();
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
        sim_log(&format!(
            "reset: dropping {} identities, clearing sim state",
            self.identities.len()
        ));
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
            return Ok(format!(
                "{{ \"created\": {created:?}, \"deleted\": {deleted:?} }}\n"
            ));
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

    fn register(&mut self, name: &str, target_balance: Option<u64>) -> StringWithError {
        let (public_key, is_new) = if let Some(identity) = self.lookup_identity(name) {
            (hex::encode(identity.puzzle_hash.bytes()), false)
        } else {
            let pk1: PrivateKey = self.rng.random();
            let identity = ChiaIdentity::new(&mut self.allocator, pk1)?;
            self.simulator.farm_block(&identity.puzzle_hash);
            self.chase_block()?;
            let result = hex::encode(identity.puzzle_hash.bytes());
            self.identities.insert(name.to_string(), result.clone());
            self.pubkeys.insert(result.clone(), identity);
            (result, true)
        };

        if is_new {
            sim_log(&format!(
                "register: new identity name={name} target_balance={target_balance:?} identities_total={}",
                self.identities.len()
            ));
        } else {
            sim_log(&format!(
                "register: existing identity name={name} target_balance={target_balance:?}"
            ));
        }

        if let Some(desired) = target_balance {
            if let Some(identity) = self.lookup_identity(&public_key).cloned() {
                let coins = self.simulator.get_my_coins(&identity.puzzle_hash)?;
                let total: u64 = coins
                    .iter()
                    .filter_map(|c| c.to_parts().map(|(_, _, amt)| amt.to_u64()))
                    .sum();
                if total > desired {
                    for c in coins.iter() {
                        if let Some((_, _, amt)) = c.to_parts() {
                            if amt.to_u64() > desired {
                                self.simulator.transfer_coin_amount(
                                    &mut self.allocator,
                                    &identity.puzzle_hash,
                                    &identity,
                                    c,
                                    Amount::new(desired),
                                )?;
                                self.farm_and_chase()?;
                                sim_log(&format!(
                                    "register: trimmed balance name={name} from={total} to={desired}"
                                ));
                                break;
                            }
                        }
                    }
                }
            }
        }

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

        let env = ChannelEnv::new(&mut self.allocator)?;
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
        let result = self
            .simulator
            .push_transactions(&mut self.allocator, spends)?;
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

    fn push_transactions(&mut self, spend_decoded: &CoinsetSpendBundle) -> StringWithError {
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
struct PushTransactionsRequest {
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
            let balance = req.params.get("balance").and_then(|v| v.as_u64());
            name.and_then(|n| game_runner.register(n, balance))
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
        "push_tx" | "push_transactions" => {
            let push_req: Result<PushTransactionsRequest, Error> =
                serde_json::from_value(req.params.clone())
                    .map_err(|e| Error::StrErr(format!("bad push_transactions params: {e}")));
            push_req.and_then(|r| game_runner.push_transactions(&r.spend_bundle))
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
            sim_log("exit: received exit RPC, terminating");
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
        Err(e) => {
            sim_log(&format!(
                "rpc_error method={} id={} err={e:?}",
                req.method, req.id
            ));
            WsResponse {
                id: req.id,
                result: None,
                error: Some(format!("{e:?}")),
            }
        }
    };

    DispatchResult {
        response: serde_json::to_string(&resp).unwrap_or_default(),
        extra_messages,
    }
}

// ---------------------------------------------------------------------------
// Async service and GameRunner actor
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK_INTERVAL: Duration = Duration::from_secs(10);
const DEFAULT_OUTBOUND_CAPACITY: usize = 64;
const WEBSOCKET_CLOSE_TIMEOUT: Duration = Duration::from_millis(250);
const CONNECTION_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const ACTOR_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct ServiceConfig {
    pub(crate) listen_addr: SocketAddr,
    pub(crate) block_interval: Duration,
    pub(crate) outbound_capacity: usize,
    pub(crate) ready: Option<oneshot::Sender<SocketAddr>>,
    #[cfg(test)]
    actor_ready: Option<oneshot::Sender<GameActor>>,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            listen_addr: "[::]:5800".parse().unwrap(),
            block_interval: DEFAULT_BLOCK_INTERVAL,
            outbound_capacity: DEFAULT_OUTBOUND_CAPACITY,
            ready: None,
            #[cfg(test)]
            actor_ready: None,
        }
    }
}

type ConnectionId = u64;

struct ActorClient {
    outbound: mpsc::Sender<Message>,
    disconnect: watch::Sender<bool>,
    registered_coins: HashSet<CoinID>,
}

enum GameCommand {
    Connect {
        connection_id: ConnectionId,
        outbound: mpsc::Sender<Message>,
        disconnect: watch::Sender<bool>,
        reply: oneshot::Sender<()>,
    },
    Request {
        connection_id: ConnectionId,
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Disconnect {
        connection_id: ConnectionId,
        reason: String,
    },
    Farm {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
struct GameActor {
    commands: std_mpsc::Sender<GameCommand>,
}

impl GameActor {
    async fn connect(
        &self,
        connection_id: ConnectionId,
        outbound: mpsc::Sender<Message>,
        disconnect: watch::Sender<bool>,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(GameCommand::Connect {
                connection_id,
                outbound,
                disconnect,
                reply,
            })
            .map_err(|_| "game actor stopped".to_string())?;
        tokio::select! {
            result = received => {
                result.map_err(|_| "game actor stopped before connect".to_string())
            }
            _ = wait_for_shutdown(shutdown) => {
                Err("service stopped during game actor connect".to_string())
            }
        }
    }

    async fn request(
        &self,
        connection_id: ConnectionId,
        text: String,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(GameCommand::Request {
                connection_id,
                text,
                reply,
            })
            .map_err(|_| "game actor stopped".to_string())?;
        tokio::select! {
            result = received => {
                result
                    .map_err(|_| "game actor stopped before replying".to_string())?
            }
            _ = wait_for_shutdown(shutdown) => {
                Err("service stopped during game actor request".to_string())
            }
        }
    }

    fn disconnect(&self, connection_id: ConnectionId, reason: String) {
        let _ = self.commands.send(GameCommand::Disconnect {
            connection_id,
            reason,
        });
    }

    async fn farm(&self) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(GameCommand::Farm { reply })
            .map_err(|_| "game actor stopped".to_string())?;
        received
            .await
            .map_err(|_| "game actor stopped before farming".to_string())?
    }

    async fn shutdown(&self) -> Result<(), String> {
        let (reply, received) = oneshot::channel();
        self.commands
            .send(GameCommand::Shutdown { reply })
            .map_err(|_| "game actor stopped before shutdown".to_string())?;
        received
            .await
            .map_err(|_| "game actor stopped during shutdown".to_string())
    }
}

fn queue_actor_messages(
    connection_id: ConnectionId,
    client: &ActorClient,
    messages: Vec<String>,
) -> Result<(), String> {
    let permits = match client.outbound.try_reserve_many(messages.len()) {
        Ok(permits) => permits,
        Err(e) => {
            let reason = format!(
                "outbound queue cannot reserve {} messages atomically: {e}",
                messages.len()
            );
            sim_log(&format!(
                "slow_client: connection_id={connection_id} reason=\"{reason}\""
            ));
            let _ = client.disconnect.send(true);
            return Err(reason);
        }
    };

    for (permit, message) in permits.zip(messages) {
        permit.send(Message::Text(message.into()));
    }
    Ok(())
}

fn run_game_actor(
    commands: std_mpsc::Receiver<GameCommand>,
    height: Arc<AtomicUsize>,
    ready: std_mpsc::SyncSender<Result<(), String>>,
) {
    let simulator = Simulator::default();
    let coinset_adapter = FullCoinSetAdapter::default();
    let mut game_runner = match GameRunner::new(simulator, coinset_adapter) {
        Ok(runner) => runner,
        Err(e) => {
            let _ = ready.send(Err(format!("{e}")));
            return;
        }
    };
    height.store(
        game_runner.simulator.get_current_height(),
        Ordering::Relaxed,
    );
    let _ = ready.send(Ok(()));

    let mut clients: HashMap<ConnectionId, ActorClient> = HashMap::new();
    while let Ok(command) = commands.recv() {
        match command {
            GameCommand::Connect {
                connection_id,
                outbound,
                disconnect,
                reply,
            } => {
                clients.insert(
                    connection_id,
                    ActorClient {
                        outbound,
                        disconnect,
                        registered_coins: HashSet::new(),
                    },
                );
                sim_log(&format!(
                    "ws_connected: connection_id={connection_id} clients_total={}",
                    clients.len()
                ));
                let _ = reply.send(());
            }
            GameCommand::Request {
                connection_id,
                text,
                reply,
            } => {
                let Some(client) = clients.get_mut(&connection_id) else {
                    let _ = reply.send(Err("connection is no longer registered".to_string()));
                    continue;
                };
                let dispatch =
                    dispatch_ws_request(&mut game_runner, &text, &mut client.registered_coins);
                height.store(
                    game_runner.simulator.get_current_height(),
                    Ordering::Relaxed,
                );

                let mut messages = Vec::with_capacity(1 + dispatch.extra_messages.len());
                messages.push(dispatch.response);
                messages.extend(dispatch.extra_messages);
                let send_result = queue_actor_messages(connection_id, client, messages);
                if send_result.is_err() {
                    clients.remove(&connection_id);
                }
                let _ = reply.send(send_result);
            }
            GameCommand::Disconnect {
                connection_id,
                reason,
            } => {
                if clients.remove(&connection_id).is_some() {
                    sim_log(&format!(
                        "ws_disconnected: connection_id={connection_id} reason=\"{reason}\" clients_remaining={}",
                        clients.len()
                    ));
                }
            }
            GameCommand::Farm { reply } => {
                let result = game_runner
                    .farm_and_chase()
                    .map_err(|e| format!("{e:?}"))
                    .map(|new_height| {
                        height.store(new_height as usize, Ordering::Relaxed);
                        sim_log(&format!(
                            "block_farmed: height={new_height} clients={}",
                            clients.len()
                        ));
                        let mut slow_clients = Vec::new();
                        for (&connection_id, client) in &clients {
                            let message = make_block_event_json_for_client(
                                &game_runner,
                                new_height,
                                &client.registered_coins,
                            );
                            if queue_actor_messages(connection_id, client, vec![message]).is_err() {
                                slow_clients.push(connection_id);
                            }
                        }
                        for connection_id in slow_clients {
                            clients.remove(&connection_id);
                        }
                    });
                let _ = reply.send(result);
            }
            GameCommand::Shutdown { reply } => {
                clients.clear();
                let _ = reply.send(());
                break;
            }
        }
    }
}

fn start_game_actor(
    height: Arc<AtomicUsize>,
) -> Result<
    (
        GameActor,
        std::thread::JoinHandle<()>,
        oneshot::Receiver<()>,
    ),
    String,
> {
    let (commands, receiver) = std_mpsc::channel();
    let (ready, started) = std_mpsc::sync_channel(1);
    let (terminated, actor_done) = oneshot::channel();
    let thread = std::thread::Builder::new()
        .name("sim-game-runner".to_string())
        .spawn(move || {
            run_game_actor(receiver, height, ready);
            let _ = terminated.send(());
        })
        .map_err(|e| format!("failed to start game actor: {e}"))?;
    let startup = started
        .recv()
        .map_err(|_| "game actor stopped during startup".to_string())
        .and_then(|result| result);
    if let Err(startup_error) = startup {
        if let Err(panic_error) = join_game_actor(thread) {
            return Err(format!("{startup_error}; {panic_error}"));
        }
        return Err(startup_error);
    }
    Ok((GameActor { commands }, thread, actor_done))
}

fn join_game_actor(thread: std::thread::JoinHandle<()>) -> Result<(), String> {
    thread
        .join()
        .map_err(|panic| match panic.downcast::<String>() {
            Ok(message) => format!("game actor thread panicked: {message}"),
            Err(panic) => match panic.downcast::<&'static str>() {
                Ok(message) => format!("game actor thread panicked: {message}"),
                Err(_) => "game actor thread panicked with non-string payload".to_string(),
            },
        })
}

fn cors_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Content-Type"),
    );
    headers
}

#[derive(Clone)]
struct ServiceState {
    height: Arc<AtomicUsize>,
    actor: GameActor,
    outbound_capacity: usize,
    shutdown: watch::Receiver<bool>,
    next_connection_id: Arc<AtomicUsize>,
    connections: ConnectionTracker,
}

#[derive(Clone, Default)]
struct ConnectionTracker {
    inner: Arc<ConnectionTrackerInner>,
}

#[derive(Default)]
struct ConnectionTrackerInner {
    active: AtomicUsize,
    changed: Notify,
}

struct ConnectionGuard {
    tracker: ConnectionTracker,
}

impl ConnectionTracker {
    fn start(&self) -> ConnectionGuard {
        self.inner.active.fetch_add(1, Ordering::Relaxed);
        ConnectionGuard {
            tracker: self.clone(),
        }
    }

    async fn wait_for_empty(&self) {
        loop {
            let changed = self.inner.changed.notified();
            if self.inner.active.load(Ordering::Relaxed) == 0 {
                return;
            }
            changed.await;
        }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.tracker.inner.active.fetch_sub(1, Ordering::Relaxed);
        self.tracker.inner.changed.notify_waiters();
    }
}

async fn get_peak(State(state): State<ServiceState>) -> impl IntoResponse {
    (
        cors_headers(),
        format!("{}\n", state.height.load(Ordering::Relaxed)),
    )
}

async fn get_peak_options() -> impl IntoResponse {
    (cors_headers(), "")
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, cors_headers(), "not found")
}

async fn upgrade_websocket(
    websocket: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<ServiceState>,
) -> impl IntoResponse {
    let connection_id = state.next_connection_id.fetch_add(1, Ordering::Relaxed) as u64;
    let connection_guard = state.connections.start();
    websocket.on_upgrade(move |socket| async move {
        let _connection_guard = connection_guard;
        handle_connection(
            socket,
            addr,
            connection_id,
            state.actor,
            state.outbound_capacity,
            state.shutdown,
        )
        .await;
    })
}

async fn run_server(
    listener: TcpListener,
    state: ServiceState,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let connections = state.connections.clone();
    let app = Router::new()
        .route(
            "/health",
            get(get_peak).post(get_peak).options(get_peak_options),
        )
        .route("/ws", get(upgrade_websocket))
        .fallback(not_found)
        .with_state(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        wait_for_shutdown(&mut shutdown).await;
    })
    .await
    .map_err(|e| format!("simulator server failed: {e}"))?;
    tokio::time::timeout(CONNECTION_SHUTDOWN_TIMEOUT, connections.wait_for_empty())
        .await
        .map_err(|_| format!("connections did not stop within {CONNECTION_SHUTDOWN_TIMEOUT:?}"))?;
    Ok(())
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    loop {
        let requested = *shutdown.borrow();
        if requested || shutdown.changed().await.is_err() {
            return;
        }
    }
}

async fn flush_websocket(websocket: &mut WebSocket) {
    let _ = tokio::time::timeout(WEBSOCKET_CLOSE_TIMEOUT, websocket.flush()).await;
}

async fn close_websocket(websocket: &mut WebSocket) {
    let _ = tokio::time::timeout(
        WEBSOCKET_CLOSE_TIMEOUT,
        websocket.send(Message::Close(None)),
    )
    .await;
}

async fn send_websocket_message(websocket: &mut WebSocket, message: Message) -> Result<(), String> {
    tokio::time::timeout(WEBSOCKET_CLOSE_TIMEOUT, websocket.send(message))
        .await
        .map_err(|_| "WebSocket write timed out".to_string())?
        .map_err(|e| format!("write_error: {e}"))
}

async fn handle_connection(
    mut websocket: WebSocket,
    addr: SocketAddr,
    connection_id: ConnectionId,
    actor: GameActor,
    outbound_capacity: usize,
    mut shutdown: watch::Receiver<bool>,
) {
    sim_log(&format!(
        "ws_accept: addr={addr} connection_id={connection_id}"
    ));

    let (outbound, mut outbound_receiver) = mpsc::channel(outbound_capacity);
    let (actor_disconnect, mut actor_disconnected) = watch::channel(false);
    let connect_result = actor
        .connect(connection_id, outbound, actor_disconnect, &mut shutdown)
        .await;
    if let Err(e) = connect_result {
        sim_log(&format!("ws_connect_error: addr={addr} err={e}"));
        close_websocket(&mut websocket).await;
        return;
    }
    let (reason, peer_closed) = loop {
        tokio::select! {
            incoming = websocket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let request_result = tokio::select! {
                            result = actor.request(
                                connection_id,
                                text.to_string(),
                                &mut shutdown,
                            ) => result,
                            _ = wait_for_shutdown(&mut actor_disconnected) => {
                                break ("outbound_queue_saturated".to_string(), false);
                            }
                        };
                        if let Err(e) = request_result {
                            break (e, false);
                        }
                    }
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Ping(data))) => {
                        if let Err(e) =
                            send_websocket_message(&mut websocket, Message::Pong(data)).await
                        {
                            break (e, false);
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .as_ref()
                            .map(|f| format!("close_frame: code={} reason={}", f.code, f.reason))
                            .unwrap_or_else(|| "close_frame: no frame".to_string());
                        // The WebSocket implementation queues the required close reply
                        // when it reads the peer's frame. Give it a bounded chance to flush.
                        flush_websocket(&mut websocket).await;
                        break (reason, true);
                    }
                    Some(Err(e)) => break (format!("read_error: {e}"), false),
                    None => break ("connection_eof".to_string(), false),
                }
            }
            outbound = outbound_receiver.recv() => {
                let Some(message) = outbound else {
                    break ("actor_outbound_closed".to_string(), false);
                };
                if let Err(e) = send_websocket_message(&mut websocket, message).await {
                    break (e, false);
                }
            }
            _ = wait_for_shutdown(&mut actor_disconnected) => {
                break ("outbound_queue_saturated".to_string(), false);
            }
            _ = wait_for_shutdown(&mut shutdown) => {
                break ("service_shutdown".to_string(), false);
            }
        }
    };

    if !peer_closed {
        close_websocket(&mut websocket).await;
    }
    actor.disconnect(connection_id, reason);
}

fn unexpected_task_result(
    name: &str,
    result: Result<Result<(), String>, tokio::task::JoinError>,
) -> String {
    match result {
        Ok(Ok(())) => format!("{name} terminated unexpectedly"),
        Ok(Err(e)) => format!("{name} failed: {e}"),
        Err(e) => format!("{name} task failed: {e}"),
    }
}

async fn finish_server_task(
    name: &str,
    task: &mut tokio::task::JoinHandle<Result<(), String>>,
) -> Result<(), String> {
    match tokio::time::timeout(SERVER_SHUTDOWN_TIMEOUT, &mut *task).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(format!("{name} task failed during shutdown: {e}")),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(format!(
                "{name} did not stop within {SERVER_SHUTDOWN_TIMEOUT:?}"
            ))
        }
    }
}

pub(crate) async fn run_service(
    mut config: ServiceConfig,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    if config.outbound_capacity == 0 {
        return Err("outbound capacity must be greater than zero".to_string());
    }
    let listener = TcpListener::bind(config.listen_addr)
        .await
        .map_err(|e| format!("failed to bind simulator server: {e}"))?;
    let listen_addr = listener
        .local_addr()
        .map_err(|e| format!("failed to read simulator server address: {e}"))?;
    let height = Arc::new(AtomicUsize::new(0));
    let (actor, actor_thread, mut actor_done) = tokio::task::spawn_blocking({
        let height = height.clone();
        move || start_game_actor(height)
    })
    .await
    .map_err(|e| format!("game actor startup task failed: {e}"))??;
    sim_log(&format!(
        "startup: health and WebSocket API on {listen_addr}"
    ));

    let (service_shutdown, service_shutdown_receiver) = watch::channel(false);
    let state = ServiceState {
        height,
        actor: actor.clone(),
        outbound_capacity: config.outbound_capacity,
        shutdown: service_shutdown_receiver.clone(),
        next_connection_id: Arc::new(AtomicUsize::new(1)),
        connections: ConnectionTracker::default(),
    };
    let mut server_task = tokio::spawn(run_server(listener, state, service_shutdown_receiver));
    if let Some(ready) = config.ready.take() {
        let _ = ready.send(listen_addr);
    }
    #[cfg(test)]
    if let Some(actor_ready) = config.actor_ready.take() {
        let _ = actor_ready.send(actor.clone());
    }

    let mut block_timer = tokio::time::interval(config.block_interval);
    block_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    block_timer.tick().await;
    let mut server_finished = false;
    let mut actor_finished = false;
    let service_error;
    loop {
        tokio::select! {
            _ = wait_for_shutdown(&mut shutdown) => {
                service_error = None;
                break;
            }
            result = &mut server_task => {
                server_finished = true;
                service_error = Some(unexpected_task_result("simulator server", result));
                break;
            }
            result = &mut actor_done => {
                actor_finished = true;
                service_error = Some(match result {
                    Ok(()) => "game actor terminated unexpectedly".to_string(),
                    Err(_) => "game actor terminated unexpectedly without completion signal".to_string(),
                });
                break;
            }
            _ = block_timer.tick() => {
                if let Err(e) = actor.farm().await {
                    service_error = Some(format!("game actor farm failed: {e}"));
                    break;
                }
            }
        }
    }

    let _ = service_shutdown.send(true);
    let mut cleanup_errors = Vec::new();
    if !server_finished {
        if let Err(e) = finish_server_task("simulator server", &mut server_task).await {
            cleanup_errors.push(e);
        }
    }

    if !actor_finished {
        match tokio::time::timeout(ACTOR_SHUTDOWN_TIMEOUT, actor.shutdown()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => cleanup_errors.push(e),
            Err(_) => cleanup_errors.push(format!(
                "game actor did not acknowledge shutdown within {ACTOR_SHUTDOWN_TIMEOUT:?}"
            )),
        }
        match tokio::time::timeout(ACTOR_SHUTDOWN_TIMEOUT, &mut actor_done).await {
            Ok(Ok(())) => actor_finished = true,
            Ok(Err(_)) => actor_finished = true,
            Err(_) => cleanup_errors.push(format!(
                "game actor did not terminate within {ACTOR_SHUTDOWN_TIMEOUT:?}"
            )),
        }
    }
    if actor_finished {
        let mut join_task = tokio::task::spawn_blocking(move || join_game_actor(actor_thread));
        match tokio::time::timeout(ACTOR_SHUTDOWN_TIMEOUT, &mut join_task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => cleanup_errors.push(e),
            Ok(Err(e)) => cleanup_errors.push(format!("game actor join task failed: {e}")),
            Err(_) => {
                join_task.abort();
                cleanup_errors.push(format!(
                    "game actor thread did not join within {ACTOR_SHUTDOWN_TIMEOUT:?}"
                ));
            }
        }
    }

    match (service_error, cleanup_errors.is_empty()) {
        (None, true) => Ok(()),
        (Some(error), true) => Err(error),
        (None, false) => Err(format!(
            "shutdown cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
        (Some(error), false) => Err(format!(
            "{error}; shutdown cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
    }
}

fn service_main_inner() {
    // Ensure panics produce full backtraces regardless of env.
    std::env::set_var("RUST_BACKTRACE", "1");
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture();
        eprintln!("[sim] {} PANIC: {info}\n{bt}", sim_ts());
    }));

    let runtime = tokio::runtime::Runtime::new().expect("failed to create Tokio runtime");
    runtime.block_on(async {
        let (shutdown_sender, shutdown) = watch::channel(false);
        let stdin_shutdown = shutdown_sender.clone();
        std::thread::spawn(move || {
            let mut buffer = String::new();
            if !matches!(stdin().read_line(&mut buffer), Ok(0)) {
                sim_log("stdin-close: shutting down");
                let _ = stdin_shutdown.send(true);
            }
        });
        let ctrl_c_shutdown = shutdown_sender.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                sim_log("ctrl-c: shutting down");
                let _ = ctrl_c_shutdown.send(true);
            }
        });
        #[cfg(unix)]
        tokio::spawn(async move {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to install SIGTERM handler");
            terminate.recv().await;
            sim_log("SIGTERM: shutting down");
            let _ = shutdown_sender.send(true);
        });

        run_service(ServiceConfig::default(), shutdown)
            .await
            .unwrap();
    });
}

pub fn service_main() {
    if let Err(e) = std::panic::catch_unwind(|| {
        service_main_inner();
    }) {
        sim_log(&format!("panic: {e:?}"));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::task::JoinHandle as TokioJoinHandle;
    use tokio::time::{sleep, timeout};
    use tokio_tungstenite::tungstenite::Message as ClientMessage;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    struct ServiceHarness {
        listen_addr: SocketAddr,
        actor: GameActor,
        shutdown: Option<watch::Sender<bool>>,
        service: Option<TokioJoinHandle<Result<(), String>>>,
    }

    impl ServiceHarness {
        async fn start() -> Self {
            let (ready_sender, ready) = oneshot::channel();
            let (actor_sender, actor_ready) = oneshot::channel();
            let (shutdown, shutdown_receiver) = watch::channel(false);
            let config = ServiceConfig {
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                block_interval: Duration::from_secs(60),
                outbound_capacity: DEFAULT_OUTBOUND_CAPACITY,
                ready: Some(ready_sender),
                actor_ready: Some(actor_sender),
            };
            let service = tokio::spawn(run_service(config, shutdown_receiver));
            let listen_addr = timeout(TEST_TIMEOUT, ready)
                .await
                .expect("service readiness timed out")
                .expect("service stopped before reporting readiness");
            assert_ne!(listen_addr.port(), 0);
            let actor = timeout(TEST_TIMEOUT, actor_ready)
                .await
                .expect("actor readiness timed out")
                .expect("service stopped before exposing actor");
            Self {
                listen_addr,
                actor,
                shutdown: Some(shutdown),
                service: Some(service),
            }
        }

        async fn shutdown(mut self) {
            self.shutdown
                .take()
                .unwrap()
                .send(true)
                .expect("service dropped shutdown receiver");
            let result = timeout(TEST_TIMEOUT, self.service.take().unwrap())
                .await
                .expect("service shutdown timed out")
                .expect("service task panicked");
            result.expect("service shutdown failed");

            assert!(
                TcpStream::connect(self.listen_addr).await.is_err(),
                "simulator listener still accepted connections after shutdown"
            );
        }
    }

    impl Drop for ServiceHarness {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(true);
            }
        }
    }

    type ClientWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    async fn receive_response(websocket: &mut ClientWebSocket, expected_id: u64) -> Value {
        timeout(TEST_TIMEOUT, async {
            loop {
                let message = websocket
                    .next()
                    .await
                    .expect("WebSocket closed before RPC response")
                    .expect("failed to read WebSocket message");
                let ClientMessage::Text(text) = message else {
                    continue;
                };
                let value: Value =
                    serde_json::from_str(&text).expect("server returned invalid JSON");
                if value.get("event").and_then(Value::as_str) == Some("block") {
                    continue;
                }
                if value.get("id").and_then(Value::as_u64) == Some(expected_id) {
                    return value;
                }
            }
        })
        .await
        .expect("timed out waiting for matching RPC response")
    }

    async fn receive_json(websocket: &mut ClientWebSocket) -> Value {
        timeout(TEST_TIMEOUT, async {
            loop {
                let message = websocket
                    .next()
                    .await
                    .expect("WebSocket closed before JSON message")
                    .expect("failed to read WebSocket message");
                if let ClientMessage::Text(text) = message {
                    return serde_json::from_str(&text).expect("server returned invalid JSON");
                }
            }
        })
        .await
        .expect("timed out waiting for JSON message")
    }

    async fn send_request(websocket: &mut ClientWebSocket, request: Value) {
        websocket
            .send(ClientMessage::Text(request.to_string().into()))
            .await
            .expect("failed to send WebSocket request");
    }

    async fn raw_http_request(addr: SocketAddr, request: &str) -> String {
        timeout(TEST_TIMEOUT, async {
            let mut stream = TcpStream::connect(addr).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            String::from_utf8(response).unwrap()
        })
        .await
        .expect("HTTP request timed out")
    }

    #[tokio::test]
    async fn regression_fragmented_websocket_upgrade_waits_for_complete_request() {
        let harness = ServiceHarness::start().await;
        let mut stream = TcpStream::connect(harness.listen_addr).await.unwrap();
        let request = format!(
            "GET /ws HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            harness.listen_addr
        );

        for chunk in request.as_bytes().chunks(17) {
            stream.write_all(chunk).await.unwrap();
            sleep(Duration::from_millis(5)).await;
        }

        let response = timeout(TEST_TIMEOUT, async {
            let mut response = Vec::new();
            let mut chunk = [0; 128];
            while !response.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0, "connection closed before HTTP headers completed");
                response.extend_from_slice(&chunk[..count]);
            }
            response
        })
        .await
        .expect("WebSocket upgrade response timed out");
        let response = String::from_utf8_lossy(&response);
        assert!(
            response.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
            "unexpected upgrade response: {response}"
        );

        drop(stream);
        harness.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn regression_concurrent_websocket_clients_are_serialized_by_actor() {
        const CLIENT_COUNT: usize = 12;

        let harness = ServiceHarness::start().await;
        let listen_addr = harness.listen_addr;
        let mut clients = Vec::new();
        for client_index in 0..CLIENT_COUNT {
            clients.push(tokio::spawn(async move {
                let url = format!("ws://{listen_addr}/ws");
                let (mut websocket, _) = timeout(TEST_TIMEOUT, connect_async(url))
                    .await
                    .expect("WebSocket connect timed out")
                    .expect("WebSocket connect failed");
                let register_id = 10_000 + client_index as u64;
                websocket
                    .send(ClientMessage::Text(
                        serde_json::json!({
                            "id": register_id,
                            "method": "register",
                            "params": {"name": format!("concurrent-client-{client_index}")}
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .unwrap();
                let register = receive_response(&mut websocket, register_id).await;
                assert!(register["error"].is_null(), "{register}");
                assert!(
                    register["result"].as_str().is_some(),
                    "register result was not a public key: {register}"
                );

                let peak_id = 20_000 + client_index as u64;
                websocket
                    .send(ClientMessage::Text(
                        serde_json::json!({
                            "id": peak_id,
                            "method": "get_peak",
                            "params": {}
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .unwrap();
                let peak = receive_response(&mut websocket, peak_id).await;
                assert!(peak["error"].is_null(), "{peak}");
                assert!(peak["result"].as_u64().is_some(), "{peak}");
            }));
        }
        for client in clients {
            timeout(TEST_TIMEOUT, client)
                .await
                .expect("concurrent client timed out")
                .expect("concurrent client task panicked");
        }

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn regression_capacity_one_outbound_disconnects_only_saturated_client() {
        let (slow_outbound, _slow_receiver) = mpsc::channel(1);
        slow_outbound
            .try_send(Message::Text("already full".into()))
            .unwrap();
        let (slow_disconnect, mut slow_disconnected) = watch::channel(false);
        let slow_client = ActorClient {
            outbound: slow_outbound,
            disconnect: slow_disconnect,
            registered_coins: HashSet::new(),
        };

        let error = queue_actor_messages(1, &slow_client, vec!["cannot fit".to_string()])
            .expect_err("saturated outbound queue unexpectedly accepted a message");
        assert!(
            error.contains("cannot reserve 1 messages atomically"),
            "{error}"
        );
        timeout(TEST_TIMEOUT, slow_disconnected.changed())
            .await
            .expect("disconnect watch was not triggered")
            .unwrap();
        assert!(*slow_disconnected.borrow());

        let (healthy_outbound, mut healthy_receiver) = mpsc::channel(1);
        let (healthy_disconnect, healthy_disconnected) = watch::channel(false);
        let healthy_client = ActorClient {
            outbound: healthy_outbound,
            disconnect: healthy_disconnect,
            registered_coins: HashSet::new(),
        };
        queue_actor_messages(2, &healthy_client, vec!["delivered".to_string()]).unwrap();
        assert_eq!(
            healthy_receiver.recv().await,
            Some(Message::Text("delivered".into()))
        );
        assert!(!*healthy_disconnected.borrow());
    }

    #[tokio::test]
    async fn regression_outbound_batch_is_atomic_when_capacity_is_insufficient() {
        let (outbound, mut receiver) = mpsc::channel(2);
        outbound.try_send(Message::Text("existing".into())).unwrap();
        let (disconnect, mut disconnected) = watch::channel(false);
        let client = ActorClient {
            outbound,
            disconnect,
            registered_coins: HashSet::new(),
        };

        let error = queue_actor_messages(
            1,
            &client,
            vec!["response".to_string(), "block event".to_string()],
        )
        .expect_err("batch unexpectedly fit in one remaining queue slot");
        assert!(
            error.contains("cannot reserve 2 messages atomically"),
            "{error}"
        );
        assert_eq!(
            receiver.recv().await,
            Some(Message::Text("existing".into()))
        );
        assert!(
            matches!(
                receiver.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "part of the rejected batch was enqueued"
        );
        timeout(TEST_TIMEOUT, disconnected.changed())
            .await
            .expect("disconnect watch was not triggered")
            .unwrap();
        assert!(*disconnected.borrow());
    }

    #[tokio::test]
    async fn regression_health_get_and_post_and_shutdown_release_ports() {
        let harness = ServiceHarness::start().await;
        let get = raw_http_request(
            harness.listen_addr,
            &format!(
                "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                harness.listen_addr
            ),
        )
        .await;
        assert!(get.starts_with("HTTP/1.1 200 OK\r\n"), "{get}");
        let get_body = get
            .split_once("\r\n\r\n")
            .expect("GET response had no body separator")
            .1;
        assert!(
            get_body.trim().parse::<u64>().is_ok(),
            "GET peak was not numeric: {get}"
        );

        let post = raw_http_request(
            harness.listen_addr,
            &format!(
                "POST /health HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                harness.listen_addr
            ),
        )
        .await;
        assert!(post.starts_with("HTTP/1.1 200 OK\r\n"), "{post}");
        let post_body = post
            .split_once("\r\n\r\n")
            .expect("POST response had no body separator")
            .1;
        assert_eq!(post_body, get_body);

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn regression_shutdown_sends_websocket_close_on_unified_listener() {
        let harness = ServiceHarness::start().await;
        let url = format!("ws://{}/ws", harness.listen_addr);
        let (mut websocket, _) = connect_async(url).await.unwrap();

        harness.shutdown().await;

        let message = timeout(TEST_TIMEOUT, websocket.next())
            .await
            .expect("timed out waiting for WebSocket close")
            .expect("WebSocket ended without a close frame")
            .expect("failed to read WebSocket close");
        assert!(
            matches!(message, ClientMessage::Close(_)),
            "expected close frame, got {message:?}"
        );
    }

    #[tokio::test]
    async fn regression_response_precedes_events_and_coin_filters_are_per_client() {
        let harness = ServiceHarness::start().await;
        let url = format!("ws://{}/ws", harness.listen_addr);
        let (mut registered_client, _) = connect_async(&url).await.unwrap();
        let (mut unregistered_client, _) = connect_async(&url).await.unwrap();

        send_request(
            &mut registered_client,
            serde_json::json!({
                "id": 1,
                "method": "register",
                "params": {"name": "filtered-wallet"}
            }),
        )
        .await;
        let register_response = receive_json(&mut registered_client).await;
        assert_eq!(register_response["id"], 1);
        let puzzle_hash = register_response["result"]
            .as_str()
            .expect("register did not return a puzzle hash")
            .to_string();
        let register_event = receive_json(&mut registered_client).await;
        assert_eq!(register_event["event"], "block");

        send_request(
            &mut registered_client,
            serde_json::json!({
                "id": 2,
                "method": "create_spendable",
                "params": {
                    "who": "filtered-wallet",
                    "target": puzzle_hash,
                    "amount": 100
                }
            }),
        )
        .await;
        let spendable_response = receive_json(&mut registered_client).await;
        assert_eq!(spendable_response["id"], 2);
        let coin_bytes = hex::decode(
            spendable_response["result"]
                .as_str()
                .expect("create_spendable did not return a coin"),
        )
        .unwrap();
        let coin_id = CoinString::from_bytes(&coin_bytes).to_coin_id();
        let spendable_event = receive_json(&mut registered_client).await;
        assert_eq!(spendable_event["event"], "block");

        send_request(
            &mut registered_client,
            serde_json::json!({
                "id": 3,
                "method": "register_remote_coins",
                "params": {"coinIds": [format!("0x{}", hex::encode(coin_id.bytes()))]}
            }),
        )
        .await;
        assert_eq!(
            receive_response(&mut registered_client, 3).await["result"],
            true
        );

        send_request(
            &mut unregistered_client,
            serde_json::json!({"id": 4, "method": "get_peak", "params": {}}),
        )
        .await;
        assert_eq!(receive_response(&mut unregistered_client, 4).await["id"], 4);

        harness.actor.farm().await.expect("manual farm failed");
        let registered_event = receive_json(&mut registered_client).await;
        let unregistered_event = receive_json(&mut unregistered_client).await;
        assert_eq!(registered_event["event"], "block");
        assert_eq!(registered_event["records"].as_array().unwrap().len(), 1);
        assert_eq!(unregistered_event["event"], "block");
        assert!(unregistered_event["records"].as_array().unwrap().is_empty());

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn regression_actor_connect_and_request_waits_cancel_on_shutdown() {
        let (commands, receiver) = std_mpsc::channel();
        let actor = GameActor { commands };
        let (shutdown_sender, shutdown_receiver) = watch::channel(false);
        let (outbound, _outbound_receiver) = mpsc::channel(1);
        let (disconnect, _disconnected) = watch::channel(false);
        let (command_seen, seen) = oneshot::channel();
        let (release, hold_command) = std_mpsc::channel();
        let actor_thread = tokio::task::spawn_blocking(move || {
            let command = receiver.recv().expect("connect command was not sent");
            assert!(matches!(command, GameCommand::Connect { .. }));
            let _ = command_seen.send(());
            hold_command.recv().expect("test did not release command");
            drop(command);
        });
        let connect = tokio::spawn({
            let actor = actor.clone();
            let mut shutdown = shutdown_receiver.clone();
            async move { actor.connect(1, outbound, disconnect, &mut shutdown).await }
        });
        seen.await.expect("connect command was not observed");
        shutdown_sender.send(true).unwrap();
        let connect_error = timeout(TEST_TIMEOUT, connect)
            .await
            .expect("connect did not cancel")
            .expect("connect task panicked")
            .expect_err("connect unexpectedly succeeded");
        assert!(connect_error.contains("service stopped"), "{connect_error}");
        release.send(()).unwrap();
        actor_thread.await.unwrap();

        let (commands, receiver) = std_mpsc::channel();
        let actor = GameActor { commands };
        let (shutdown_sender, mut shutdown_receiver) = watch::channel(false);
        let (command_seen, seen) = oneshot::channel();
        let (release, hold_command) = std_mpsc::channel();
        let actor_thread = tokio::task::spawn_blocking(move || {
            let command = receiver.recv().expect("request command was not sent");
            assert!(matches!(command, GameCommand::Request { .. }));
            let _ = command_seen.send(());
            hold_command.recv().expect("test did not release command");
            drop(command);
        });
        let request = tokio::spawn(async move {
            actor
                .request(1, "{}".to_string(), &mut shutdown_receiver)
                .await
        });
        seen.await.expect("request command was not observed");
        shutdown_sender.send(true).unwrap();
        let request_error = timeout(TEST_TIMEOUT, request)
            .await
            .expect("request did not cancel")
            .expect("request task panicked")
            .expect_err("request unexpectedly succeeded");
        assert!(request_error.contains("service stopped"), "{request_error}");
        release.send(()).unwrap();
        actor_thread.await.unwrap();
    }

    #[tokio::test]
    async fn regression_early_actor_exit_stops_servers_and_returns_error() {
        let (ready_sender, ready) = oneshot::channel();
        let (actor_sender, actor_ready) = oneshot::channel();
        let (_shutdown, shutdown_receiver) = watch::channel(false);
        let config = ServiceConfig {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            block_interval: Duration::from_secs(60),
            outbound_capacity: DEFAULT_OUTBOUND_CAPACITY,
            ready: Some(ready_sender),
            actor_ready: Some(actor_sender),
        };
        let service = tokio::spawn(run_service(config, shutdown_receiver));
        let listen_addr = timeout(TEST_TIMEOUT, ready)
            .await
            .expect("service readiness timed out")
            .expect("service stopped before reporting readiness");
        let actor = timeout(TEST_TIMEOUT, actor_ready)
            .await
            .expect("actor readiness timed out")
            .expect("service stopped before exposing actor");

        actor.shutdown().await.expect("actor shutdown failed");
        let error = timeout(TEST_TIMEOUT, service)
            .await
            .expect("service did not react to actor exit")
            .expect("service task panicked")
            .expect_err("early actor exit unexpectedly returned success");
        assert!(
            error.contains("game actor terminated unexpectedly"),
            "{error}"
        );
        assert!(
            TcpStream::connect(listen_addr).await.is_err(),
            "simulator listener remained open after actor exit"
        );
    }
}
