mod map_m;

use js_sys::{Array, Function, JsString, Object};

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicI32, Ordering};

use hex::FromHexError;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

use wasm_bindgen::prelude::*;

use chia_gaming::channel_handler::types::ReadableMove;
use chia_gaming::common::types;
use chia_gaming::common::types::{AllocEncoder, Amount, CoinSpend, CoinString, Hash, IntoErr, GameID, PrivateKey, Program, PuzzleHash, Sha256Input, Spend, SpendBundle, Timeout};
use chia_gaming::common::standard_coin::{wasm_deposit_file, ChiaIdentity};
use chia_gaming::log::init as chia_gaming_init;
use chia_gaming::peer_container::{
    GameCradle, IdleResult, SynchronousGameCradle, SynchronousGameCradleConfig, WatchReport,
};
use chia_gaming::potato_handler::types::{GameStart, GameType, ToLocalUI};
use chia_gaming::shutdown::BasicShutdownConditions;

use crate::map_m::map_m;

#[wasm_bindgen(typescript_custom_section)]
const TS_APPEND_CONTENT: &'static str = r#"
export type Amount = {
    "amt": number,
};

export type Spend = {
    "puzzle": string,
    "solution": string,
    "signature": string
};

export type CoinSpend = {
    "coin": string,
    "bundle": Spend
};

export type SpendBundle = {
    "spends": Array<CoinSpend>
};

export type IChiaIdentity = {
    "private_key": string,
    "synthetic_private_key": string,
    "public_key": string,
    "synthetic_public_key": string,
    "puzzle": string,
    "puzzle_hash": string,
};

export type OpponentMove = [string, string];
export type GameFinished = [string, number];

export type IdleResult = {
    "continue_on": boolean,
    "outbound_transactions": Array<SpendBundle>,
    "outbound_messages": Array<string>,
    "opponent_move": OpponentMove | undefined,
    "game_finished": GameFinished | undefined
};

export type GameCradleConfig = {
    "seed": string | undefined,
    "game_types": Map<string, string>,
    "identity": string | undefined,
    "have_potato": boolean,
    "my_contribution": Amount,
    "their_contribution": Amount,
    "channel_timeout": number,
    "reward_puzzle_hash": string
};

export type IChiaIdentityFun = (seed: string) => IChiaIdentity;

export type IdleCallbacks = {
    "self_move": ((game_id: string, move_hex: string) => void) | undefined,
    "opponent_moved": ((game_id: string, readable_move_hex: string) => void) | undefined,
    "game_message": ((game_id: string, readable_move_hex: string) => void) | undefined,
    "game_finished": ((game_id: string) => void) | undefined,
    "shutdown_complete": ((coin: string) => void) | undefined,
    "going_on_chain": (() => void) | undefined
};
"#;

#[derive(Serialize, Deserialize, Default)]
struct JsAmount {
    amt: Amount,
}

struct JsCradle {
    allocator: AllocEncoder,
    rng: ChaCha8Rng,
    cradle: SynchronousGameCradle,
}

thread_local! {
    static NEXT_ID: AtomicI32 = {
        return AtomicI32::new(0);
    };
    static CRADLES: RefCell<HashMap<i32, JsCradle>> = {
        return RefCell::new(HashMap::new());
    };
}

#[wasm_bindgen]
pub fn init() {
    chia_gaming_init();
}

#[wasm_bindgen]
pub fn deposit_file(name: &str, data: &str) {
    wasm_deposit_file(name, data);
}

fn get_next_id() -> i32 {
    NEXT_ID.with(|n| n.fetch_add(1, Ordering::SeqCst))
}

fn insert_cradle(this_id: i32, runner: JsCradle) {
    CRADLES.with(|cell| {
        let mut mut_ref = cell.borrow_mut();
        mut_ref.insert(this_id, runner);
    });
}

#[derive(Serialize, Deserialize)]
struct JsRndConfig {
    // hex string.
    seed: String,
}

#[derive(Serialize, Deserialize, Default)]
struct JsGameCradleConfig {
    // name vs hex string for program
    game_types: BTreeMap<String, String>,
    // hex string for private key
    identity: Option<String>,
    have_potato: bool,
    // float or decimal string
    my_contribution: JsAmount,
    // float or decimal string
    their_contribution: JsAmount,
    channel_timeout: i32,
    unroll_timeout: i32,
    // hex string for puzzle hash
    reward_puzzle_hash: String,
}

fn convert_game_types(
    collection: &BTreeMap<String, String>,
) -> Result<BTreeMap<GameType, Rc<Program>>, JsValue> {
    let mut result = BTreeMap::new();
    for (name, hex) in collection.iter() {
        let name_data = GameType(name.bytes().collect());
        let byte_data = hex::decode(&hex).into_js()?;
        result.insert(name_data, Rc::new(Program::from_bytes(&byte_data)));
    }
    Ok(result)
}

// return a collection of clvm factory programs indexed by byte strings used to identify
// them.  probably the indexes should be hashes, thinking about it, but can be anything.
fn get_game_config<'b>(
    identity: &'b mut ChiaIdentity,
    js_config: JsValue,
) -> Result<SynchronousGameCradleConfig<'b>, JsValue> {
    let jsconfig: JsGameCradleConfig = serde_wasm_bindgen::from_value(js_config).into_js()?;

    let game_types = convert_game_types(&jsconfig.game_types)?;
    let reward_puzzle_hash_bytes = hex::decode(&jsconfig.reward_puzzle_hash).into_js()?;
    Ok(SynchronousGameCradleConfig {
        game_types,
        have_potato: jsconfig.have_potato,
        identity: identity,
        channel_timeout: Timeout::new(jsconfig.channel_timeout as u64),
        unroll_timeout: Timeout::new(jsconfig.unroll_timeout as u64),
        my_contribution: jsconfig.my_contribution.amt.clone(),
        their_contribution: jsconfig.their_contribution.amt.clone(),
        reward_puzzle_hash: PuzzleHash::from_hash(Hash::from_slice(&reward_puzzle_hash_bytes)),
    })
}

trait ErrIntoJs {
    type EResult;
    fn into_js(self) -> Self::EResult;
}

impl ErrIntoJs for types::Error {
    type EResult = JsValue;
    fn into_js(self) -> Self::EResult {
        serde_wasm_bindgen::to_value(&self)
            .unwrap_or_else(|e| JsValue::from_str(&format!("{:?}", e)))
    }
}

impl ErrIntoJs for FromHexError {
    type EResult = JsValue;
    fn into_js(self) -> Self::EResult {
        JsValue::from_str(&format!("{self:?}"))
    }
}

impl ErrIntoJs for serde_wasm_bindgen::Error {
    type EResult = JsValue;
    fn into_js(self) -> Self::EResult {
        JsValue::from_str(&format!("{self:?}"))
    }
}

impl<X, E: ErrIntoJs<EResult = JsValue>> ErrIntoJs for Result<X, E> {
    type EResult = Result<X, JsValue>;
    fn into_js(self) -> Self::EResult {
        self.map_err(|e| e.into_js())
    }
}

#[wasm_bindgen]
pub fn config_scaffold() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&JsGameCradleConfig::default()).into_js()
}

/// The meta-variable typescript_type is usused by rust, but is very much used by the FFI
#[allow(unused_variables)]
#[allow(clippy::unused_variables)]
#[wasm_bindgen(typescript_type = "ICreateGameCradle")]
pub fn create_game_cradle(js_config: JsValue) -> Result<i32, JsValue> {
    let new_id = get_next_id();

    let mut use_seed: [u8; 32] = [0; 32];
    if let Some(js_rnd_config) =
        serde_wasm_bindgen::from_value::<JsRndConfig>(js_config.clone()).ok()
    {
        let seed_bytes = hex::decode(&js_rnd_config.seed).into_js()?;
        for (i, b) in seed_bytes.iter().enumerate() {
            use_seed[i % use_seed.len()] = *b;
        }
    }
    let mut rng = ChaCha8Rng::from_seed(use_seed);
    let mut allocator = AllocEncoder::new();

    let random_private_key: PrivateKey = rng.gen();
    let mut identity = ChiaIdentity::new(&mut allocator, random_private_key).into_js()?;
    let synchronous_game_cradle_config = get_game_config(&mut identity, js_config.clone())?;
    let game_cradle = SynchronousGameCradle::new(&mut rng, synchronous_game_cradle_config);
    let cradle = JsCradle {
        allocator,
        rng,
        cradle: game_cradle,
    };

    insert_cradle(new_id, cradle);

    Ok(new_id)
}

fn with_game<F, T>(cid: i32, f: F) -> Result<T, JsValue>
where
    F: FnOnce(&mut JsCradle) -> Result<T, types::Error>,
{
    CRADLES.with(|cell| {
        let mut mut_ref = cell.borrow_mut();
        if let Some(cradle) = mut_ref.get_mut(&cid) {
            return f(cradle).into_js();
        }

        Err(JsValue::from_str(&format!(
            "could not find game instance {cid}"
        )))
    })
}

fn hex_to_coinstring(hex: &str) -> Result<CoinString, types::Error> {
    let coinstring_bytes = hex::decode(hex).into_gen()?;
    Ok(CoinString::from_bytes(&coinstring_bytes))
}

fn coinstring_to_hex(cs: &CoinString) -> String {
    hex::encode(&cs.to_bytes())
}

#[wasm_bindgen]
pub fn opening_coin(cid: i32, hex_coinstring: &str) -> Result<(), JsValue> {
    with_game(cid, move |cradle: &mut JsCradle| {
        cradle.cradle.opening_coin(
            &mut cradle.allocator,
            &mut cradle.rng,
            hex_to_coinstring(hex_coinstring)?,
        )
    })
}

fn watch_report_from_params(
    additions: Vec<String>,
    removals: Vec<String>,
    timed_out: Vec<String>,
) -> Result<WatchReport, types::Error> {
    Ok(WatchReport {
        created_watched: map_m(|s| hex_to_coinstring(&s), &additions)?
            .iter()
            .cloned()
            .collect(),
        deleted_watched: map_m(|s| hex_to_coinstring(&s), &removals)?
            .iter()
            .cloned()
            .collect(),
        timed_out: map_m(|s| hex_to_coinstring(&s), &timed_out)?
            .iter()
            .cloned()
            .collect(),
    })
}

#[wasm_bindgen]
pub fn new_block(
    cid: i32,
    height: usize,
    additions: Vec<String>,
    removals: Vec<String>,
    timed_out: Vec<String>,
) -> Result<(), JsValue> {
    with_game(cid, move |cradle: &mut JsCradle| {
        let watch_report = watch_report_from_params(additions, removals, timed_out)?;
        cradle.cradle.new_block(
            &mut cradle.allocator,
            &mut cradle.rng,
            height,
            &watch_report,
        )
    })
}

#[derive(Deserialize)]
struct JsGameStart {
    // Game name
    game_type: String,
    timeout: u64,
    amount: u64,
    my_contribution: u64,
    my_turn: bool,
    // Hex
    parameters: String,
}

fn game_id_to_string(id: &GameID) -> String {
    hex::encode(id.to_bytes())
}

fn string_to_game_id(id: &str) -> Result<GameID, JsValue> {
    Ok(GameID::from_bytes(&hex::decode(id).into_js()?))
}

#[wasm_bindgen]
pub fn start_games(cid: i32, initiator: bool, game: JsValue) -> Result<Vec<String>, JsValue> {
    let js_game_start = serde_wasm_bindgen::from_value::<JsGameStart>(game.clone()).into_js()?;
    let res = with_game(cid, move |cradle: &mut JsCradle| {
        let game_start = GameStart {
            game_type: GameType(hex::decode(&js_game_start.game_type).into_gen()?),
            timeout: Timeout::new(js_game_start.timeout),
            amount: Amount::new(js_game_start.amount),
            my_contribution: Amount::new(js_game_start.my_contribution),
            my_turn: js_game_start.my_turn,
            parameters: hex::decode(&js_game_start.parameters).into_gen()?,
        };
        cradle.cradle.start_games(
            &mut cradle.allocator,
            &mut cradle.rng,
            initiator,
            &game_start,
        )
    })?;

    Ok(res.iter().map(game_id_to_string).collect())
}

pub fn make_move_inner(
    cid: i32,
    id: &str,
    readable: &str,
    entropy: Option<&str>,
) -> Result<(), JsValue> {
    let game_id = string_to_game_id(id)?;
    let readable_bytes = hex::decode(readable).into_js()?;
    let new_entropy = if let Some(e) = entropy {
        Some(Hash::from_slice(&hex::decode(e).into_js()?))
    } else {
        None
    };
    with_game(cid, move |cradle: &mut JsCradle| {
        let entropy: Hash = new_entropy.unwrap_or_else(|| cradle.rng.gen());
        cradle.cradle.make_move(
            &mut cradle.allocator,
            &mut cradle.rng,
            &game_id,
            readable_bytes,
            entropy,
        )
    })
}

#[wasm_bindgen]
pub fn make_move_entropy(
    cid: i32,
    id: &str,
    readable: &str,
    new_entropy: &str,
) -> Result<(), JsValue> {
    make_move_inner(cid, id, readable, Some(new_entropy))
}

#[wasm_bindgen]
pub fn make_move(cid: i32, id: &str, readable: &str) -> Result<(), JsValue> {
    make_move_inner(cid, id, readable, None)
}

#[wasm_bindgen]
pub fn accept(cid: i32, id: &str) -> Result<(), JsValue> {
    let game_id = string_to_game_id(id)?;
    with_game(cid, move |cradle: &mut JsCradle| {
        cradle
            .cradle
            .accept(&mut cradle.allocator, &mut cradle.rng, &game_id)
    })
}

#[wasm_bindgen]
pub fn shut_down(cid: i32) -> Result<(), JsValue> {
    with_game(cid, move |cradle: &mut JsCradle| {
        cradle.cradle.shut_down(
            &mut cradle.allocator,
            &mut cradle.rng,
            Rc::new(BasicShutdownConditions),
        )
    })
}

#[wasm_bindgen]
pub fn deliver_message(cid: i32, inbound_message: &str) -> Result<(), JsValue> {
    let message_data = hex::decode(inbound_message).into_js()?;
    with_game(cid, move |cradle: &mut JsCradle| {
        cradle.cradle.deliver_message(&message_data)
    })
}

#[derive(Default)]
struct JsLocalUI {
    callbacks: BTreeMap<String, JsValue>,
}

fn call_javascript_from_collection<F>(
    callbacks: &BTreeMap<String, JsValue>,
    name: &str,
    f: F,
) -> Result<(), types::Error>
where
    F: FnOnce(&mut Array) -> Result<(), types::Error>,
{
    if let Some(function) = callbacks.get(name).and_then(Function::try_from) {
        let mut args_array = Array::new();
        f(&mut args_array)?;
        function.apply(&JsValue::NULL, &args_array).into_e()?;
    }

    Ok(())
}

impl ToLocalUI for JsLocalUI {
    fn self_move(&mut self, game_id: &GameID, readable: &[u8]) -> Result<(), types::Error> {
        call_javascript_from_collection(&self.callbacks, "self_move", |args_array| {
            args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
            args_array.set(1, JsValue::from_str(&hex::encode(readable)));
            Ok(())
        })
    }

    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        game_id: &GameID,
        readable_move: ReadableMove,
        _amount: Amount,
    ) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "opponent_moved", |args_array| {
            args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
            args_array.set(1, JsValue::from_str(&readable_move.to_program().to_hex()));
            Ok(())
        })
    }

    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        game_id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "game_message", |args_array| {
            args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
            args_array.set(1, JsValue::from_str(&readable.to_program().to_hex()));
            Ok(())
        })
    }

    fn game_finished(
        &mut self,
        game_id: &GameID,
        amount: Amount,
    ) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "game_message", |args_array| {
            args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
            args_array.set(1, amount.to_u64().into());
            Ok(())
        })
    }

    fn game_cancelled(
        &mut self,
        game_id: &GameID,
    ) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "game_finished", |args_array| {
            args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
            Ok(())
        })
    }

    fn shutdown_complete(
        &mut self,
        coin: Option<&CoinString>,
    ) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "shutdown_complete", |args_array| {
            args_array.set(
                0,
                coin.map(|c| JsValue::from_str(&hex::encode(&c.to_bytes())))
                    .unwrap_or_else(|| JsValue::NULL.clone()),
            );
            Ok(())
        })
    }

    fn going_on_chain(&mut self, got_error: bool) -> Result<(), chia_gaming::common::types::Error> {
        call_javascript_from_collection(&self.callbacks, "going_on_chain", |args_array| {
            args_array.set(0, JsValue::from_bool(got_error));
            Ok(())
        })
    }
}

fn to_local_ui(callbacks: JsValue) -> Result<JsLocalUI, JsValue> {
    let object = if let Some(object) = Object::try_from(&callbacks) {
        object
    } else {
        return Err(JsValue::from_str("callbacks wasn't an object"));
    };

    let mut jslocalui = JsLocalUI::default();

    let entries = Object::entries(object);
    for i in 0..entries.length() {
        let entry = Array::from(&entries.at(i as i32));
        let name = JsString::try_from(&entry.at(0)).and_then(|s| s.as_string());
        let value = entry.at(1);
        if let Some(name) = name {
            jslocalui.callbacks.insert(name, value);
        }
    }

    Ok(jslocalui)
}

#[derive(Serialize)]
struct JsSpend {
    puzzle: String,
    solution: String,
    signature: String,
}

#[derive(Serialize)]
struct JsCoinSpend {
    coin: String,
    bundle: JsSpend,
}

#[derive(Serialize)]
struct JsSpendBundle {
    spends: Vec<JsCoinSpend>,
}

#[derive(Serialize)]
struct JsIdleResult {
    continue_on: bool,
    outbound_transactions: Vec<JsSpendBundle>,
    outbound_messages: Vec<String>,
    opponent_move: Option<(String, String)>,
    game_finished: Option<(String, u64)>,
}

fn spend_to_js(spend: &Spend) -> JsSpend {
    JsSpend {
        puzzle: spend.puzzle.to_hex(),
        solution: spend.solution.p().to_hex(),
        signature: hex::encode(&spend.signature.bytes()),
    }
}

fn coin_spend_to_js(spend: &CoinSpend) -> JsCoinSpend {
    JsCoinSpend {
        coin: coinstring_to_hex(&spend.coin),
        bundle: spend_to_js(&spend.bundle),
    }
}

fn spend_bundle_to_js(spend_bundle: &SpendBundle) -> JsSpendBundle {
    JsSpendBundle {
        spends: spend_bundle.spends.iter().map(coin_spend_to_js).collect(),
    }
}

fn readable_move_to_hex(rm: &ReadableMove) -> Result<String, types::Error> {
    Ok(rm.to_program().to_hex())
}

trait IntoE {
    type E;
    fn into_e(self) -> Self::E;
}

impl IntoE for serde_wasm_bindgen::Error {
    type E = types::Error;
    fn into_e(self) -> types::Error {
        types::Error::StrErr(format!("{self:?}"))
    }
}

impl IntoE for wasm_bindgen::JsValue {
    type E = types::Error;
    fn into_e(self) -> types::Error {
        self.as_string()
            .map(types::Error::StrErr)
            .unwrap_or_else(|| types::Error::StrErr("unspecified error".to_string()))
    }
}

impl<T, Err: IntoE<E = types::Error>> IntoE for Result<T, Err> {
    type E = Result<T, types::Error>;
    fn into_e(self) -> Result<T, types::Error> {
        self.map_err(|e| e.into_e())
    }
}

fn idle_result_to_js(idle_result: &IdleResult) -> Result<JsValue, types::Error> {
    let opponent_move = if let Some((gid, vs)) = &idle_result.opponent_move {
        Some((game_id_to_string(gid), readable_move_to_hex(vs)?))
    } else {
        None
    };
    let game_finished = if let Some((gid, amt)) = &idle_result.game_finished {
        Some((game_id_to_string(gid), amt.to_u64()))
    } else {
        None
    };
    serde_wasm_bindgen::to_value(&JsIdleResult {
        continue_on: idle_result.continue_on,
        outbound_transactions: idle_result
            .outbound_transactions
            .iter()
            .map(spend_bundle_to_js)
            .collect(),
        outbound_messages: idle_result
            .outbound_messages
            .iter()
            .map(hex::encode)
            .collect(),
        opponent_move: opponent_move,
        game_finished: game_finished,
    })
    .into_e()
}

#[wasm_bindgen]
pub fn idle(cid: i32, callbacks: JsValue) -> Result<JsValue, JsValue> {
    let mut local_ui = to_local_ui(callbacks)?;
    with_game(cid, move |cradle: &mut JsCradle| {
        if let Some(idle_result) =
            cradle
                .cradle
                .idle(&mut cradle.allocator, &mut cradle.rng, &mut local_ui)?
        {
            idle_result_to_js(&idle_result)
        } else {
            Ok(JsValue::NULL.clone())
        }
    })
}

#[derive(Serialize, Deserialize)]
struct JsChiaIdentity {
    pub private_key: String,
    pub synthetic_private_key: String,
    pub public_key: String,
    pub synthetic_public_key: String,
    pub puzzle: String,
    pub puzzle_hash: String,
}

impl From<ChiaIdentity> for JsChiaIdentity {
    fn from(value: ChiaIdentity) -> JsChiaIdentity {
        JsChiaIdentity {
            private_key: hex::encode(&value.private_key.bytes()),
            synthetic_private_key: hex::encode(&value.synthetic_private_key.bytes()),
            public_key: hex::encode(&value.public_key.bytes()),
            synthetic_public_key: hex::encode(&value.synthetic_public_key.bytes()),
            puzzle: value.puzzle.to_hex(),
            puzzle_hash: hex::encode(&value.puzzle_hash.bytes()),
        }
    }
}

#[wasm_bindgen(typescript_type = "IChiaIdentityFun")]
pub fn chia_identity(seed: &str) -> Result<JsValue, JsValue> {
    let hashed = Sha256Input::Bytes(seed.as_bytes()).hash();
    let mut rng = ChaCha8Rng::from_seed(*hashed.bytes());
    let mut allocator = AllocEncoder::new();
    let private_key = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key).into_js()?;
    let js_identity: JsChiaIdentity = identity.into();
    serde_wasm_bindgen::to_value(&js_identity).into_js()
}

#[wasm_bindgen]
pub fn sha256bytes(bytes_str: &str) -> Result<JsValue, JsValue> {
    let hashed = Sha256Input::Bytes(bytes_str.as_bytes()).hash();
    serde_wasm_bindgen::to_value(&hashed).into_js()
}
