#[allow(unused_variables)] // enable this so 'typescript_type' can be named 'typescript_type'
mod gaming_wasm {
    use js_sys::{Array, JsString, Object};

    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};
    use std::rc::Rc;
    use std::sync::atomic::{AtomicI32, Ordering};

    use hex::FromHexError;
    use log::debug;

    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;
    use serde::{Deserialize, Serialize};

    use chia_gaming::common::types::ChaCha8SerializationWrapper;

    use wasm_bindgen::prelude::*;

    use chia_gaming::channel_handler::types::{GameStartFailed, ReadableMove};
    use chia_gaming::common::load_clvm::wasm_deposit_file;
    use chia_gaming::common::standard_coin::{puzzle_hash_for_pk, ChiaIdentity};

    use chia_gaming::common::types;
    use chia_gaming::common::types::{
        chia_dialect, convert_coinset_org_spend_to_spend, map_m, Aggsig, AllocEncoder, Amount,
        CoinCondition, CoinID, CoinSpend, CoinString, CoinsetCoin, CoinsetSpendBundle,
        CoinsetSpendRecord, GameID, GameType, Hash, IntoErr, PrivateKey, Program, PublicKey,
        PuzzleHash, Sha256Input, Spend, SpendBundle, Timeout,
    };
    use chia_gaming::peer_container::{
        GameCradle, IdleResult, SynchronousGameCradle, SynchronousGameCradleConfig, WatchReport,
    };
    use chia_gaming::potato_handler::start::GameStart;
    use chia_gaming::potato_handler::types::{GameFactory, ToLocalUI};
    use chia_gaming::shutdown::BasicShutdownConditions;

    #[cfg(target_arch = "wasm32")]
    use lol_alloc::{FreeListAllocator, LockedAllocator};

    use clvmr::run_program;

    #[cfg(target_arch = "wasm32")]
    #[global_allocator]
    static ALLOCATOR: LockedAllocator<FreeListAllocator> =
        LockedAllocator::new(FreeListAllocator::new());

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
        "shutdown_started": (() => void) | undefined,
        "shutdown_complete": ((coin: string) => void) | undefined,
        "going_on_chain": (() => void) | undefined
    };
    "#;

    #[derive(Serialize, Deserialize, Default, Debug)]
    struct JsAmount {
        amt: Amount,
    }

    #[derive(Serialize, Deserialize)]
    struct JsCradle {
        #[serde(skip_serializing, skip_deserializing)]
        allocator: AllocEncoder,
        rng: ChaCha8SerializationWrapper,
        cradle: SynchronousGameCradle,
    }

    #[derive(Serialize, Deserialize, Default, Debug)]
    struct JsWatchReport {
        created_watched: Vec<String>,
        deleted_watched: Vec<String>,
        timed_out: Vec<String>,
    }

    thread_local! {
        static NEXT_ID: AtomicI32 = const {
            AtomicI32::new(0)
        };
        static CRADLES: RefCell<HashMap<i32, JsCradle>> = {
            return RefCell::new(HashMap::new());
        };
        static RNGS: RefCell<HashMap<i32, ChaCha8Rng>> = {
        return RefCell::new(HashMap::new());
    };

    }

    #[wasm_bindgen]
    pub fn init() {
        wasm_logger::init(wasm_logger::Config::default());
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

    fn insert_rng(id: i32, rng: ChaCha8Rng) {
        RNGS.with(|cell| {
            let mut mut_ref = cell.borrow_mut();
            mut_ref.insert(id, rng);
        });
    }

    #[derive(Serialize, Deserialize, Default, Debug)]
    struct JsGameFactory {
        version: i32,
        hex: String,
    }

    #[derive(Serialize, Deserialize, Default, Debug)]
    struct JsGameCradleConfig {
        // GameInitParams?
        // name vs hex string for program
        game_types: BTreeMap<String, JsGameFactory>,
        // hex string for private key
        identity: String, //todo rename private_key
        rng_id: i32,
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

    fn convert_game_factory(
        name: &str,
        js_factory: &JsGameFactory,
    ) -> Result<(GameType, GameFactory), JsValue> {
        let name_data = GameType(name.bytes().collect());
        let byte_data = hex::decode(&js_factory.hex).into_js()?;
        Ok((
            name_data,
            GameFactory {
                version: js_factory.version as usize,
                program: Program::from_bytes(&byte_data).into(),
            },
        ))
    }

    fn convert_game_types(
        collection: &BTreeMap<String, JsGameFactory>,
    ) -> Result<BTreeMap<GameType, GameFactory>, JsValue> {
        let mut result = BTreeMap::new();
        for (name, gf) in collection.iter() {
            let (name_data, game_factory) = convert_game_factory(name, gf)?;
            result.insert(name_data, game_factory);
        }
        Ok(result)
    }

    struct GameConfigResult {
        config: SynchronousGameCradleConfig,
        rng_id: i32,
    }

    fn get_game_config(
        allocator: &mut AllocEncoder,
        js_config: JsValue,
    ) -> Result<GameConfigResult, JsValue> {
        let jsconfig: JsGameCradleConfig = serde_wasm_bindgen::from_value(js_config).into_js()?;
        let private_key_bytes = hex::decode(&jsconfig.identity).into_js()?;
        let private_key = PrivateKey::from_slice(&private_key_bytes).into_js()?;
        let identity = ChiaIdentity::new(allocator, private_key).into_js()?;
        let game_types = convert_game_types(&jsconfig.game_types)?;
        let reward_puzzle_hash_bytes = hex::decode(&jsconfig.reward_puzzle_hash).into_js()?;

        Ok(GameConfigResult {
            config: SynchronousGameCradleConfig {
                game_types,
                have_potato: jsconfig.have_potato,
                identity,
                channel_timeout: Timeout::new(jsconfig.channel_timeout as u64),
                unroll_timeout: Timeout::new(jsconfig.unroll_timeout as u64),
                my_contribution: jsconfig.my_contribution.amt.clone(),
                their_contribution: jsconfig.their_contribution.amt.clone(),
                reward_puzzle_hash: PuzzleHash::from_hash(Hash::from_slice(
                    &reward_puzzle_hash_bytes,
                )),
            },
            rng_id: jsconfig.rng_id,
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

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(typescript_type = "ICreateGameCradle")]
        pub type ICreateGameCradle;
    }

    #[wasm_bindgen]
    pub fn create_rng(seed: String) -> Result<i32, JsValue> {
        let hashed = Sha256Input::Bytes(seed.as_bytes()).hash();
        let rng = ChaCha8Rng::from_seed(*hashed.bytes());
        let id = get_next_id();
        insert_rng(id, rng);
        debug!("create_rng: {id}");
        Ok(id)
    }

    pub fn with_rng<F, T>(cid: i32, f: F) -> Result<T, JsValue>
    where
        F: FnOnce(&mut ChaCha8Rng) -> Result<T, types::Error>,
    {
        RNGS.with(|cell| {
            let mut mut_ref = cell.borrow_mut();
            if let Some(cradle) = mut_ref.get_mut(&cid) {
                return f(cradle).into_js();
            }

            Err(JsValue::from_str(&format!(
                "could not find RNG instance {cid}"
            )))
        })
    }

    /// The name 'typescript_type' is part of the FFI
    #[wasm_bindgen(typescript_type = "ICreateGameCradle")]
    pub fn create_game_cradle(js_config: JsValue) -> Result<i32, JsValue> {
        let new_id = get_next_id();
        debug!("AA");
        let mut allocator = AllocEncoder::new();
        debug!("BB");
        let game_config = get_game_config(&mut allocator, js_config.clone())?;
        debug!("CC");
        with_rng(game_config.rng_id, move |rng: &mut ChaCha8Rng| {
            let synchronous_game_cradle_config = game_config.config.clone();
            debug!("DD");
            let game_cradle = SynchronousGameCradle::new(rng, synchronous_game_cradle_config);
            debug!("EE");
            let cradle = JsCradle {
                allocator,
                rng: ChaCha8SerializationWrapper(rng.clone()),
                cradle: game_cradle,
            };
            debug!("FF");
            insert_cradle(new_id, cradle);
            Ok(new_id)
        })
    }

    #[wasm_bindgen]
    pub fn create_serialized_game(json: JsValue) -> Result<i32, JsValue> {
        let cradle = serde_wasm_bindgen::from_value::<JsCradle>(json.clone()).into_js()?;
        let new_id = get_next_id();
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

    #[wasm_bindgen]
    pub fn serialize_cradle(cid: i32) -> Result<JsValue, JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            serde_wasm_bindgen::to_value(&cradle).map_err(|e| types::Error::StrErr(e.to_string()))
        })
    }

    fn hex_to_coinstring(hex: &str) -> Result<CoinString, types::Error> {
        let coinstring_bytes = hex::decode(hex).into_gen()?;
        Ok(CoinString::from_bytes(&coinstring_bytes))
    }

    fn coinstring_to_hex(cs: &CoinString) -> String {
        hex::encode(cs.to_bytes())
    }

    #[wasm_bindgen]
    pub fn opening_coin(cid: i32, hex_coinstring: &str) -> Result<(), JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.opening_coin(
                &mut cradle.allocator,
                &mut cradle.rng.0,
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
            created_watched: map_m(|s| hex_to_coinstring(s), &additions)?
                .iter()
                .cloned()
                .collect(),
            deleted_watched: map_m(|s| hex_to_coinstring(s), &removals)?
                .iter()
                .cloned()
                .collect(),
            timed_out: map_m(|s| hex_to_coinstring(s), &timed_out)?
                .iter()
                .cloned()
                .collect(),
        })
    }

    fn coin_string_to_hex(cs: &CoinString) -> String {
        let cs_bytes = cs.to_bytes();
        hex::encode(cs_bytes)
    }

    fn watch_report_to_js(watch_report: &WatchReport) -> JsWatchReport {
        JsWatchReport {
            timed_out: watch_report
                .timed_out
                .iter()
                .map(coin_string_to_hex)
                .collect(),
            created_watched: watch_report
                .created_watched
                .iter()
                .map(coin_string_to_hex)
                .collect(),
            deleted_watched: watch_report
                .deleted_watched
                .iter()
                .map(coin_string_to_hex)
                .collect(),
        }
    }

    fn spend_bundle_to_coinset_js(spend: &SpendBundle) -> Result<CoinsetSpendBundle, JsValue> {
        let mut aggsig = Aggsig::default();
        for cs in spend.spends.iter() {
            aggsig += cs.bundle.signature.clone();
        }
        let mut coin_spends = Vec::new();
        for s in spend.spends.iter() {
            if let Some((parent, pph, amt)) = s.coin.to_parts() {
                coin_spends.push(CoinsetSpendRecord {
                    coin: CoinsetCoin {
                        amount: amt.to_u64(),
                        parent_coin_info: format!("0x{}", hex::encode(parent.bytes())),
                        puzzle_hash: format!("0x{}", hex::encode(pph.bytes())),
                    },
                    puzzle_reveal: format!("0x{}", s.bundle.puzzle.to_program().to_hex()),
                    solution: format!("0x{}", s.bundle.solution.p().to_hex()),
                });
            } else {
                return Err(JsValue::from_str(&format!("bad coin string {s:?}")));
            }
        }

        Ok(CoinsetSpendBundle {
            aggregated_signature: format!("0x{}", hex::encode(aggsig.bytes())),
            coin_spends,
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
                &mut cradle.rng.0,
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
        let js_game_start =
            serde_wasm_bindgen::from_value::<JsGameStart>(game.clone()).into_js()?;
        let res = with_game(cid, move |cradle: &mut JsCradle| {
            let game_start = GameStart {
                game_id: cradle.cradle.next_game_id()?,
                game_type: GameType(hex::decode(&js_game_start.game_type).into_gen()?),
                timeout: Timeout::new(js_game_start.timeout),
                amount: Amount::new(js_game_start.amount),
                my_contribution: Amount::new(js_game_start.my_contribution),
                my_turn: js_game_start.my_turn,
                parameters: Program::from_bytes(
                    &hex::decode(&js_game_start.parameters).into_gen()?,
                ),
            };
            cradle.cradle.start_games(
                &mut cradle.allocator,
                &mut cradle.rng.0,
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
            let entropy: Hash = new_entropy.unwrap_or_else(|| cradle.rng.0.gen());
            cradle.cradle.make_move(
                &mut cradle.allocator,
                &mut cradle.rng.0,
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
    pub fn get_identity(cid: i32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&with_game(cid, move |cradle: &mut JsCradle| {
            Ok(Into::<JsChiaIdentity>::into(cradle.cradle.identity()))
        })?)
        .into_js()
    }

    #[wasm_bindgen]
    pub fn get_game_state_id(cid: i32) -> Result<Option<String>, JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle
                .cradle
                .get_game_state_id(&mut cradle.allocator, &mut cradle.rng.0)?
                .map(|h| hex::encode(h.bytes())))
        })
    }

    // TODO: Resolve Amount(js+rs), (js)number, i32, u64
    #[wasm_bindgen]
    pub fn get_amount(cid: i32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&with_game(cid, move |cradle: &mut JsCradle| {
            Ok(JsAmount {
                amt: cradle.cradle.amount(),
            })
        })?)
        .into_js()
    }

    #[wasm_bindgen]
    pub fn accept(cid: i32, id: &str) -> Result<(), JsValue> {
        let game_id = string_to_game_id(id)?;
        with_game(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .accept(&mut cradle.allocator, &mut cradle.rng.0, &game_id)
        })
    }

    #[wasm_bindgen]
    pub fn shut_down(cid: i32) -> Result<(), JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.shut_down(
                &mut cradle.allocator,
                &mut cradle.rng.0,
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
        debug!("try to call {name} from {callbacks:?}");
        if let Some(js_value) = callbacks.get(name) {
            let function = js_value
                .dyn_ref::<js_sys::Function>()
                .expect("Not a js function");
            let mut args_array = Array::new();
            debug!("call user's injected function in {name}");
            f(&mut args_array)?;
            debug!("call javascript for {name}");
            function.apply(&JsValue::NULL, &args_array).into_e()?;
        }

        debug!("finished {name} callback");

        Ok(())
    }

    impl ToLocalUI for JsLocalUI {
        fn self_move(
            &mut self,
            game_id: &GameID,
            state_number: usize,
            readable: &[u8],
        ) -> Result<(), types::Error> {
            call_javascript_from_collection(&self.callbacks, "self_move", |args_array| {
                args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
                args_array.set(1, JsValue::from_str(&hex::encode(readable)));
                args_array.set(2, state_number.into());
                Ok(())
            })
        }

        fn opponent_moved(
            &mut self,
            _allocator: &mut AllocEncoder,
            game_id: &GameID,
            state_number: usize,
            readable_move: ReadableMove,
            _amount: Amount,
        ) -> Result<(), chia_gaming::common::types::Error> {
            call_javascript_from_collection(&self.callbacks, "opponent_moved", |args_array| {
                args_array.set(0, JsValue::from_str(&game_id_to_string(game_id)));
                args_array.set(1, JsValue::from_str(&readable_move.to_program().to_hex()));
                args_array.set(2, state_number.into());
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

        fn game_start(
            &mut self,
            game_ids: &[GameID],
            finished: std::option::Option<GameStartFailed>,
        ) -> Result<(), chia_gaming::common::types::Error> {
            call_javascript_from_collection(&self.callbacks, "game_started", |args_array| {
                let game_ids_array = Array::new();
                for (i, game_id) in game_ids.iter().enumerate() {
                    game_ids_array.set(i as u32, JsValue::from_str(&game_id_to_string(game_id)));
                }
                args_array.set(0, game_ids_array.into());
                if let Some(f) = finished {
                    args_array.set(1, JsValue::from_str(&format!("{:?}", f)));
                }
                Ok(())
            })
        }

        fn game_finished(
            &mut self,
            game_id: &GameID,
            amount: Amount,
        ) -> Result<(), chia_gaming::common::types::Error> {
            call_javascript_from_collection(&self.callbacks, "game_finished", |args_array| {
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

        fn shutdown_started(&mut self) -> Result<(), chia_gaming::common::types::Error> {
            call_javascript_from_collection(&self.callbacks, "shutdown_started", |_args_array| {
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
                    coin.map(|c| JsValue::from_str(&hex::encode(c.to_bytes())))
                        .unwrap_or_else(|| JsValue::NULL.clone()),
                );
                Ok(())
            })
        }

        fn going_on_chain(
            &mut self,
            got_error: bool,
        ) -> Result<(), chia_gaming::common::types::Error> {
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
            let js_name = &entry.at(0);

            if let Some(name) = js_name
                .dyn_ref::<JsString>()
                .expect("Not a js string")
                .as_string()
            {
                let value = entry.at(1);
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
    struct JsGameStarted {
        game_ids: Vec<String>,
        failed: Option<String>,
    }

    #[derive(Serialize)]
    struct JsIdleResult {
        continue_on: bool,
        finished: bool,
        shutdown_received: bool,
        outbound_transactions: Vec<JsSpendBundle>,
        outbound_messages: Vec<String>,
        opponent_move: Option<(String, String)>,
        game_started: Option<JsGameStarted>,
        game_finished: Option<(String, u64)>,
        handshake_done: bool,
        receive_error: Option<String>,
        action_queue: Vec<String>,
        incoming_messages: Vec<String>,
    }

    fn spend_to_js(spend: &Spend) -> JsSpend {
        JsSpend {
            puzzle: spend.puzzle.to_hex(),
            solution: spend.solution.p().to_hex(),
            signature: hex::encode(spend.signature.bytes()),
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
        let opponent_move = if let Some((gid, _sn, vs)) = &idle_result.opponent_move {
            Some((game_id_to_string(gid), readable_move_to_hex(vs)?))
        } else {
            None
        };
        let game_finished = if let Some((gid, amt)) = &idle_result.game_finished {
            Some((game_id_to_string(gid), amt.to_u64()))
        } else {
            None
        };
        let game_started = if let Some(gs) = &idle_result.game_started {
            Some(JsGameStarted {
                game_ids: gs.game_ids.iter().map(game_id_to_string).collect(),
                failed: gs.failed.as_ref().map(|f| format!("{:?}", f)),
            })
        } else {
            None
        };

        serde_wasm_bindgen::to_value(&JsIdleResult {
            continue_on: idle_result.continue_on,
            finished: idle_result.finished,
            shutdown_received: idle_result.shutdown_received,
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
            opponent_move,
            game_started,
            game_finished,
            handshake_done: idle_result.handshake_done,
            action_queue: idle_result.action_queue.clone(),
            incoming_messages: idle_result.incoming_messages.clone(),
            receive_error: idle_result.receive_error.as_ref().map(|e| format!("{e:?}")),
        })
        .into_e()
    }

    #[wasm_bindgen]
    pub fn cradle_amount(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| Ok(cradle.cradle.amount()))?;
        serde_wasm_bindgen::to_value(&JsAmount { amt: amount }).into_js()
    }

    #[wasm_bindgen]
    pub fn cradle_our_share(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle.cradle.get_our_current_share())
        })?;
        serde_wasm_bindgen::to_value(&amount.map(|a| JsAmount { amt: a })).into_js()
    }

    #[wasm_bindgen]
    pub fn cradle_their_share(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle.cradle.get_their_current_share())
        })?;
        serde_wasm_bindgen::to_value(&amount.map(|a| JsAmount { amt: a })).into_js()
    }

    #[wasm_bindgen]
    pub fn idle(cid: i32, callbacks: JsValue) -> Result<JsValue, JsValue> {
        let mut local_ui = to_local_ui(callbacks)?;
        with_game(cid, move |cradle: &mut JsCradle| {
            if let Some(idle_result) =
                cradle
                    .cradle
                    .idle(&mut cradle.allocator, &mut cradle.rng.0, &mut local_ui, 3)?
            // Give extras
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
                private_key: hex::encode(value.private_key.bytes()),
                synthetic_private_key: hex::encode(value.synthetic_private_key.bytes()),
                public_key: hex::encode(value.public_key.bytes()),
                synthetic_public_key: hex::encode(value.synthetic_public_key.bytes()),
                puzzle: value.puzzle.to_hex(),
                puzzle_hash: hex::encode(value.puzzle_hash.bytes()),
            }
        }
    }

    fn check_for_hex(hex: &str) -> Result<Vec<u8>, JsValue> {
        if let Some(hex_no_prefix) = hex.strip_prefix("0x") {
            return hex::decode(hex_no_prefix).into_js();
        }

        return hex::decode(hex).into_js();
    }

    #[wasm_bindgen]
    pub fn convert_coinset_org_block_spend_to_watch_report(
        parent_coin_info: &str,
        puzzle_hash: &str,
        amount: u64,
        puzzle_reveal: &str,
        solution: &str,
    ) -> Result<JsValue, JsValue> {
        let mut allocator = AllocEncoder::new();
        let converted_spend = convert_coinset_org_spend_to_spend(
            parent_coin_info,
            puzzle_hash,
            amount,
            puzzle_reveal,
            solution,
        )
        .into_js()?;
        let puzzle_reveal_node = converted_spend
            .bundle
            .puzzle
            .to_program()
            .to_nodeptr(&mut allocator)
            .into_js()?;
        let solution_node = converted_spend
            .bundle
            .solution
            .to_nodeptr(&mut allocator)
            .into_js()?;
        let coin_string = &converted_spend.coin;
        let parent_of_created = coin_string.to_coin_id();
        let run_output = run_program(
            allocator.allocator(),
            &chia_dialect(),
            puzzle_reveal_node,
            solution_node,
            0,
        )
        .into_gen()
        .into_js()?;
        let conditions = CoinCondition::from_nodeptr(&mut allocator, run_output.1);
        let mut watch_result = WatchReport::default();
        watch_result.deleted_watched.insert(coin_string.clone());
        for condition in conditions.into_iter() {
            if let CoinCondition::CreateCoin(ph, amt) = condition {
                let new_coin = CoinString::from_parts(&parent_of_created, &ph, &amt);
                watch_result.created_watched.insert(new_coin);
            }
        }
        serde_wasm_bindgen::to_value(&watch_report_to_js(&watch_result)).into_js()
    }

    #[wasm_bindgen]
    pub fn convert_spend_to_coinset_org(spend: &str) -> Result<JsValue, JsValue> {
        let mut allocator = AllocEncoder::new();
        let spend_bytes = hex::decode(spend).into_js()?;
        let spend_program = Program::from_bytes(&spend_bytes);
        let spend_node = spend_program.to_nodeptr(&mut allocator).into_js()?;
        let spend = SpendBundle::from_clvm(&mut allocator, spend_node).into_js()?;
        serde_wasm_bindgen::to_value(&spend_bundle_to_coinset_js(&spend)?).into_js()
    }

    #[wasm_bindgen]
    pub fn convert_coinset_to_coin_string(
        parent_coin_info: &str,
        puzzle_hash: &str,
        amount: u64,
    ) -> Result<String, JsValue> {
        let parent_coin_bytes = check_for_hex(parent_coin_info)?;
        let puzzle_hash_bytes = check_for_hex(puzzle_hash)?;
        let parent_coin_info_hash = Hash::from_slice(&parent_coin_bytes);
        let puzzle_hash_hash = Hash::from_slice(&puzzle_hash_bytes);
        let coin_string = CoinString::from_parts(
            &CoinID::new(parent_coin_info_hash),
            &PuzzleHash::from_hash(puzzle_hash_hash),
            &Amount::new(amount),
        );
        let coin_string_bytes = coin_string.to_bytes();
        Ok(hex::encode(coin_string_bytes))
    }

    #[wasm_bindgen]
    pub fn convert_chia_public_key_to_puzzle_hash(public_key: &str) -> Result<String, JsValue> {
        let mut allocator = AllocEncoder::new();
        debug!("decode public key {public_key:?}");
        let public_key_bytes = check_for_hex(public_key)?;
        debug!("public key bytes {public_key_bytes:?}");
        let pubkey = PublicKey::from_slice(&public_key_bytes).into_js()?;
        debug!("decoded public key {pubkey:?}");
        let puzzle_hash = puzzle_hash_for_pk(&mut allocator, &pubkey).into_js()?;
        debug!("use puzzle hash {puzzle_hash:?}");
        Ok(hex::encode(puzzle_hash.bytes()))
    }

    #[wasm_bindgen]
    pub fn test_string() -> JsValue {
        JsValue::from_str("hi there")
    }

    #[wasm_bindgen]
    pub fn test_string_err() -> Result<JsValue, JsValue> {
        Ok(JsValue::from_str("ok but could have been err"))
    }

    #[wasm_bindgen(typescript_type = "IChiaIdentityFun")]
    pub fn chia_identity(rng_id: i32) -> Result<JsValue, JsValue> {
        with_rng(rng_id, move |rng: &mut ChaCha8Rng| {
            let mut allocator = AllocEncoder::new();
            let mut seed: [u8; 32] = rng.get_seed();
            let private_key = rng.gen();
            debug!("Generating private_key={private_key:?} from ChaCha8Rng({seed:?}");
            seed = rng.get_seed();
            debug!("ChaCha8Rng seed after rnd.gen() for private_key={seed:?}");
            let identity = ChiaIdentity::new(&mut allocator, private_key)?;
            let js_identity: JsChiaIdentity = identity.into();
            serde_wasm_bindgen::to_value(&js_identity)
                .map_err(|x| types::Error::StrErr(format!("{x:?}")))
        })
    }

    #[wasm_bindgen]
    pub fn sha256bytes(bytes_str: &str) -> Result<JsValue, JsValue> {
        let hashed = hex::encode(Sha256Input::Bytes(bytes_str.as_bytes()).hash().bytes());
        serde_wasm_bindgen::to_value(&hashed).into_js()
    }
}
