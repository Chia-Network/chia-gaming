use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI32, Ordering};

use hex::FromHexError;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};

use wasm_bindgen::prelude::*;

use chia_gaming::log::wasm_init;
use chia_gaming::common::types::{AllocEncoder, Amount, Error, Hash, PrivateKey, Program, PuzzleHash, Timeout};
use chia_gaming::potato_handler::GameType;
use chia_gaming::peer_container::{SynchronousGameCradle, SynchronousGameCradleConfig};
use chia_gaming::common::standard_coin::{ChiaIdentity, wasm_deposit_file};

#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

#[derive(Serialize, Deserialize, Default)]
struct JsAmount {
    amt: Amount
}

struct JsCradle {
    allocator: AllocEncoder,
    rng: ChaCha8Rng,
    cradle: SynchronousGameCradle
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
    wasm_init();
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
    seed: String
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
    // hex string for puzzle hash
    reward_puzzle_hash: String,
}

fn convert_game_types(collection: &BTreeMap<String, String>) -> Result<BTreeMap<GameType, Program>, JsValue> {
    let mut result = BTreeMap::new();
    for (name, hex) in collection.iter() {
        let name_data = GameType(name.bytes().collect());
        let byte_data = hex::decode(&hex).into_js()?;
        result.insert(name_data, Program::from_bytes(&byte_data));
    }
    Ok(result)
}

// return a collection of clvm factory programs indexed by byte strings used to identify
// them.  probably the indexes should be hashes, thinking about it, but can be anything.
fn get_game_config<'b>(
    allocator: &mut AllocEncoder,
    identity: &'b mut ChiaIdentity,
    js_config: JsValue
) -> Result<SynchronousGameCradleConfig<'b>, JsValue> {
    let jsconfig: JsGameCradleConfig = serde_wasm_bindgen::from_value(js_config).into_js()?;

    let mut game_types = convert_game_types(&jsconfig.game_types)?;
    let reward_puzzle_hash_bytes = hex::decode(&jsconfig.reward_puzzle_hash).into_js()?;
    Ok(SynchronousGameCradleConfig {
        game_types,
        have_potato: jsconfig.have_potato,
        identity: identity,
        channel_timeout: Timeout::new(jsconfig.channel_timeout as u64),
        my_contribution: jsconfig.my_contribution.amt.clone(),
        their_contribution: jsconfig.their_contribution.amt.clone(),
        reward_puzzle_hash: PuzzleHash::from_hash(Hash::from_slice(&reward_puzzle_hash_bytes)),
    })
}

trait ErrIntoJs {
    type EResult;
    fn into_js(self) -> Self::EResult;
}

impl ErrIntoJs for Error {
    type EResult = JsValue;
    fn into_js(self) -> Self::EResult {
        serde_wasm_bindgen::to_value(&self).unwrap_or_else(|e| JsValue::from_str(&format!("{:?}", e)))
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

#[wasm_bindgen]
pub fn create_game_cradle(js_config: JsValue) -> Result<i32, JsValue> {
    let new_id = get_next_id();

    let mut use_seed: [u8; 32] = [0; 32];
    if let Some(js_rnd_config) = serde_wasm_bindgen::from_value::<JsRndConfig>(js_config.clone()).into_js().ok() {
        let seed_bytes = hex::decode(&js_rnd_config.seed).into_js()?;
        for (i,b) in seed_bytes.iter().enumerate() {
            use_seed[i % use_seed.len()] = *b;
        }
    }
    let mut rng = ChaCha8Rng::from_seed(use_seed);
    let mut allocator = AllocEncoder::new();

    let random_private_key: PrivateKey = rng.gen();
    let mut identity = ChiaIdentity::new(&mut allocator, random_private_key).into_js()?;
    let synchronous_game_cradle_config = get_game_config(&mut allocator, &mut identity, js_config.clone())?;
    let game_cradle = SynchronousGameCradle::new(
        &mut rng,
        synchronous_game_cradle_config
    );
    let cradle = JsCradle {
        allocator,
        rng,
        cradle: game_cradle
    };

    insert_cradle(new_id, cradle);

    Ok(new_id)
}
