#[allow(unused_variables)] // enable this so 'typescript_type' can be named 'typescript_type'
mod gaming_wasm {

    use std::cell::RefCell;
    use std::collections::{BTreeMap, HashMap};
    use std::sync::atomic::{AtomicI32, Ordering};

    use hex::FromHexError;

    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;
    use serde::{Deserialize, Serialize};

    use chia_gaming::common::types::ChaCha8SerializationWrapper;

    use wasm_bindgen::prelude::*;

    use chia_gaming::common::load_clvm::wasm_deposit_file;
    use chia_gaming::common::standard_coin::{puzzle_hash_for_pk, ChiaIdentity};

    use chia_gaming::channel_handler::types::ReadableMove;
    use chia_gaming::common::types;
    use chia_gaming::common::types::{
        chia_dialect, convert_coinset_org_spend_to_spend, map_m, Aggsig, AllocEncoder, Amount,
        CoinCondition, CoinID, CoinSpend, CoinString, CoinsetCoin, CoinsetSpendBundle,
        CoinsetSpendRecord, GameID, GameType, Hash, IntoErr, PrivateKey, Program, PublicKey,
        PuzzleHash, Sha256Input, Spend, SpendBundle, Timeout,
    };
    use chia_gaming::peer_container::{
        DrainResult, GameCradle, SynchronousGameCradle, SynchronousGameCradleConfig, WatchReport,
    };
    use chia_gaming::potato_handler::effects::GameNotification;
    use chia_gaming::potato_handler::start::GameStart;
    use chia_gaming::potato_handler::types::{GameFactory, ToLocalUI};

    struct NullLocalUI;
    impl ToLocalUI for NullLocalUI {
        fn notification(
            &mut self,
            _notification: &GameNotification,
        ) -> Result<(), types::Error> {
            Ok(())
        }
    }

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

    export type DrainResult = {
        "handshake_done": boolean,
        "finished": boolean,
        "outbound_transactions": Array<SpendBundle>,
        "outbound_messages": Array<string>,
        "notifications": Array<any>,
        "receive_errors": Array<string>,
        "coin_solution_requests": Array<string>,
    };

    export type GameCradleConfig = {
        "seed": string | undefined,
        "game_types": Map<string, string>,
        "have_potato": boolean,
        "my_contribution": Amount,
        "their_contribution": Amount,
        "channel_timeout": number,
        "reward_puzzle_hash": string
    };

    export type GameCradleResult = {
        "id": number,
        "puzzle_hash": string,
    };

    export type IChiaIdentityFun = (seed: string) => IChiaIdentity;
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
        hex: String,
        #[serde(default)]
        parser_hex: Option<String>,
    }

    #[derive(Serialize, Deserialize, Default, Debug)]
    struct JsGameCradleConfig {
        game_types: BTreeMap<String, JsGameFactory>,
        rng_id: i32,
        have_potato: bool,
        my_contribution: JsAmount,
        their_contribution: JsAmount,
        channel_timeout: i32,
        unroll_timeout: i32,
        reward_puzzle_hash: String,
    }

    fn convert_game_factory(
        name: &str,
        js_factory: &JsGameFactory,
    ) -> Result<(GameType, GameFactory), JsValue> {
        let name_data = GameType(name.bytes().collect());
        let byte_data = hex::decode(&js_factory.hex).into_js()?;
        let parser_program = if let Some(ref parser_hex) = js_factory.parser_hex {
            let parser_bytes = hex::decode(parser_hex).into_js()?;
            Some(Program::from_bytes(&parser_bytes).into())
        } else {
            None
        };
        Ok((
            name_data,
            GameFactory {
                program: Program::from_bytes(&byte_data).into(),
                parser_program,
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

    struct GameConfigPartial {
        game_types: BTreeMap<GameType, GameFactory>,
        have_potato: bool,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        my_contribution: Amount,
        their_contribution: Amount,
        reward_puzzle_hash: PuzzleHash,
        rng_id: i32,
    }

    fn parse_game_config(js_config: JsValue) -> Result<GameConfigPartial, JsValue> {
        let jsconfig: JsGameCradleConfig = serde_wasm_bindgen::from_value(js_config).into_js()?;
        let game_types = convert_game_types(&jsconfig.game_types)?;
        let reward_puzzle_hash_bytes = hex::decode(&jsconfig.reward_puzzle_hash).into_js()?;

        Ok(GameConfigPartial {
            game_types,
            have_potato: jsconfig.have_potato,
            channel_timeout: Timeout::new(jsconfig.channel_timeout as u64),
            unroll_timeout: Timeout::new(jsconfig.unroll_timeout as u64),
            my_contribution: jsconfig.my_contribution.amt.clone(),
            their_contribution: jsconfig.their_contribution.amt.clone(),
            reward_puzzle_hash: PuzzleHash::from_hash(
                Hash::from_slice(&reward_puzzle_hash_bytes).into_js()?,
            ),
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
    pub fn create_game_cradle(js_config: JsValue) -> Result<JsValue, JsValue> {
        let new_id = get_next_id();
        let partial = parse_game_config(js_config)?;
        with_rng(partial.rng_id, move |rng: &mut ChaCha8Rng| {
            let mut allocator = AllocEncoder::new();
            let private_key: PrivateKey = rng.gen();
            let identity = ChiaIdentity::new(&mut allocator, private_key)?;
            let puzzle_hash_hex = hex::encode(identity.puzzle_hash.bytes());

            let config = SynchronousGameCradleConfig {
                game_types: partial.game_types,
                have_potato: partial.have_potato,
                identity,
                channel_timeout: partial.channel_timeout,
                unroll_timeout: partial.unroll_timeout,
                my_contribution: partial.my_contribution,
                their_contribution: partial.their_contribution,
                reward_puzzle_hash: partial.reward_puzzle_hash,
            };

            let game_cradle = SynchronousGameCradle::new(rng, config);
            let cradle = JsCradle {
                allocator,
                rng: ChaCha8SerializationWrapper(rng.clone()),
                cradle: game_cradle,
            };
            insert_cradle(new_id, cradle);

            #[derive(Serialize)]
            struct CradleResult {
                id: i32,
                puzzle_hash: String,
            }
            serde_wasm_bindgen::to_value(&CradleResult {
                id: new_id,
                puzzle_hash: puzzle_hash_hex,
            })
            .map_err(|e| types::Error::StrErr(format!("{e:?}")))
        })
    }

    #[wasm_bindgen]
    pub fn create_serialized_game(json: JsValue, new_seed: &str) -> Result<i32, JsValue> {
        let mut cradle = serde_wasm_bindgen::from_value::<JsCradle>(json.clone()).into_js()?;
        let hashed = Sha256Input::Bytes(new_seed.as_bytes()).hash();
        cradle.rng = ChaCha8SerializationWrapper(ChaCha8Rng::from_seed(*hashed.bytes()));
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
        let coinstring_bytes = hex::decode(hex).map_err(|e| {
            types::Error::StrErr(format!(
                "hex_to_coinstring failed: {e:?}, input length={}, input={:?}",
                hex.len(),
                if hex.len() > 64 { &hex[..64] } else { hex },
            ))
        })?;
        Ok(CoinString::from_bytes(&coinstring_bytes))
    }

    #[wasm_bindgen]
    pub fn opening_coin(cid: i32, hex_coinstring: &str) -> Result<JsValue, JsValue> {
        let coin = hex_to_coinstring(hex_coinstring).into_js()?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .opening_coin(&mut cradle.allocator, &mut cradle.rng.0, coin)
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
    ) -> Result<JsValue, JsValue> {
        let watch_report = watch_report_from_params(additions, removals, timed_out).into_js()?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
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
    }

    fn game_id_to_string(id: &GameID) -> String {
        id.0.to_string()
    }

    fn string_to_game_id(id: &str) -> Result<GameID, JsValue> {
        Ok(GameID(id.parse::<u64>().map_err(|e| {
            JsValue::from_str(&format!("bad game id: {e}"))
        })?))
    }

    #[wasm_bindgen]
    pub fn propose_game(cid: i32, game: JsValue, parameters: &[u8]) -> Result<JsValue, JsValue> {
        let js_game_start =
            serde_wasm_bindgen::from_value::<JsGameStart>(game.clone()).into_js()?;
        let parameters_program = Program::from_bytes(parameters);
        with_game(cid, move |cradle: &mut JsCradle| {
            let game_start = GameStart {
                game_id: cradle.cradle.next_game_id()?,
                game_type: GameType(hex::decode(&js_game_start.game_type).into_gen()?),
                timeout: Timeout::new(js_game_start.timeout),
                amount: Amount::new(js_game_start.amount),
                my_contribution: Amount::new(js_game_start.my_contribution),
                my_turn: js_game_start.my_turn,
                parameters: parameters_program,
            };
            let ids = cradle.cradle.propose_game(
                &mut cradle.allocator,
                &mut cradle.rng.0,
                &game_start,
            )?;
            let dr = cradle
                .cradle
                .drain_all(&mut cradle.allocator, &mut cradle.rng.0)?;

            #[derive(Serialize)]
            struct ProposeGameResult {
                ids: Vec<String>,
                handshake_done: bool,
                finished: bool,
                outbound_transactions: Vec<JsSpendBundle>,
                outbound_messages: Vec<String>,
                notifications: Vec<serde_json::Value>,
                receive_errors: Vec<String>,
            }

            to_js_compat(&ProposeGameResult {
                ids: ids.iter().map(game_id_to_string).collect(),
                handshake_done: dr.handshake_done,
                finished: dr.finished,
                outbound_transactions: dr
                    .outbound_transactions
                    .iter()
                    .map(spend_bundle_to_js)
                    .collect(),
                outbound_messages: dr.outbound_messages.iter().map(hex::encode).collect(),
                notifications: notifications_to_js(&dr.notifications),
                receive_errors: dr.receive_errors.iter().map(|e| format!("{e:?}")).collect(),
            })
        })
    }

    #[wasm_bindgen]
    pub fn accept_proposal(cid: i32, game_id: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(game_id)?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .accept_proposal(&mut cradle.allocator, &mut cradle.rng.0, &game_id)
        })
    }

    #[wasm_bindgen]
    pub fn cancel_proposal(cid: i32, game_id: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(game_id)?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .cancel_proposal(&mut cradle.allocator, &mut cradle.rng.0, &game_id)
        })
    }

    pub fn make_move_inner(
        cid: i32,
        id: &str,
        readable: &[u8],
        entropy: Option<&str>,
    ) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(id)?;
        let readable_move =
            ReadableMove::from_program(std::rc::Rc::new(Program::from_bytes(readable)));
        let new_entropy = if let Some(e) = entropy {
            Some(Hash::from_slice(&hex::decode(e).into_js()?).into_js()?)
        } else {
            None
        };
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            let entropy: Hash = new_entropy.unwrap_or_else(|| cradle.rng.0.gen());
            cradle.cradle.make_move(
                &mut cradle.allocator,
                &mut cradle.rng.0,
                &game_id,
                readable_move,
                entropy,
            )
        })
    }

    #[wasm_bindgen]
    pub fn make_move_with_entropy_for_testing(
        cid: i32,
        id: &str,
        readable: &[u8],
        new_entropy: &str,
    ) -> Result<JsValue, JsValue> {
        make_move_inner(cid, id, readable, Some(new_entropy))
    }

    #[wasm_bindgen]
    pub fn make_move(cid: i32, id: &str, readable: &[u8]) -> Result<JsValue, JsValue> {
        make_move_inner(cid, id, readable, None)
    }

    /// Submit a cheating move for testing and demonstration purposes.
    /// The mover_share is the amount the victim receives on timeout.
    #[wasm_bindgen]
    pub fn cheat(cid: i32, id: &str, mover_share: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(id)?;
        let share = Amount::new(
            mover_share
                .parse::<u64>()
                .map_err(|e| JsValue::from_str(&e.to_string()))?,
        );
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .cheat(&mut cradle.allocator, &mut cradle.rng.0, &game_id, share)
        })
    }

    #[wasm_bindgen]
    pub fn accept_proposal_and_move(
        cid: i32,
        id: &str,
        readable: &[u8],
    ) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(id)?;
        let readable_move =
            ReadableMove::from_program(std::rc::Rc::new(Program::from_bytes(readable)));
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            let entropy: Hash = cradle.rng.0.gen();
            cradle.cradle.accept_proposal_and_move(
                &mut cradle.allocator,
                &mut cradle.rng.0,
                &game_id,
                readable_move,
                entropy,
            )
        })
    }

    #[wasm_bindgen]
    pub fn get_identity(cid: i32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&with_game(cid, move |cradle: &mut JsCradle| {
            Ok(Into::<JsChiaIdentity>::into(cradle.cradle.identity()))
        })?)
        .into_js()
    }

    #[wasm_bindgen]
    #[deprecated(note = "Game state should come from notifications in the DrainResult")]
    #[allow(deprecated)]
    pub fn get_game_state_id(cid: i32) -> Result<Option<String>, JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle
                .cradle
                .get_game_state_id(&mut cradle.allocator, &mut cradle.rng.0)?
                .map(|h| hex::encode(h.bytes())))
        })
    }

    #[wasm_bindgen]
    #[deprecated(note = "Duplicate of cradle_amount; balance should come from notifications")]
    #[allow(deprecated)]
    pub fn get_amount(cid: i32) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&with_game(cid, move |cradle: &mut JsCradle| {
            Ok(JsAmount {
                amt: cradle.cradle.amount(),
            })
        })?)
        .into_js()
    }

    #[wasm_bindgen]
    pub fn accept_timeout(cid: i32, id: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(id)?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .accept_timeout(&mut cradle.allocator, &mut cradle.rng.0, &game_id)
        })
    }

    #[wasm_bindgen]
    pub fn shut_down(cid: i32) -> Result<JsValue, JsValue> {
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .shut_down(&mut cradle.allocator, &mut cradle.rng.0)
        })
    }

    #[wasm_bindgen]
    pub fn go_on_chain(cid: i32) -> Result<JsValue, JsValue> {
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.go_on_chain(
                &mut cradle.allocator,
                &mut cradle.rng.0,
                &mut NullLocalUI,
                false,
            )
        })
    }

    #[wasm_bindgen]
    pub fn report_puzzle_and_solution(
        cid: i32,
        coin_hex: &str,
        puzzle_hex: Option<String>,
        solution_hex: Option<String>,
    ) -> Result<JsValue, JsValue> {
        let coin_bytes = hex::decode(coin_hex).into_js()?;
        let coin = CoinString::from_bytes(&coin_bytes);

        let puzzle_program = puzzle_hex
            .map(|h| Program::from_hex(&h))
            .transpose()
            .into_js()?;
        let solution_program = solution_hex
            .map(|h| Program::from_hex(&h))
            .transpose()
            .into_js()?;

        let ps_pair = match (&puzzle_program, &solution_program) {
            (Some(p), Some(s)) => Some((p, s)),
            _ => None,
        };

        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.report_puzzle_and_solution(
                &mut cradle.allocator,
                &mut cradle.rng.0,
                &coin,
                ps_pair,
            )
        })
    }

    #[wasm_bindgen]
    pub fn deliver_message(cid: i32, inbound_message: &str) -> Result<JsValue, JsValue> {
        let message_data = hex::decode(inbound_message).into_js()?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.deliver_message(&message_data)
        })
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
    struct JsDrainResult {
        handshake_done: bool,
        finished: bool,
        outbound_transactions: Vec<JsSpendBundle>,
        outbound_messages: Vec<String>,
        notifications: Vec<serde_json::Value>,
        receive_errors: Vec<String>,
        coin_solution_requests: Vec<String>,
        debug_lines: Vec<String>,
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
            coin: coin_string_to_hex(&spend.coin),
            bundle: spend_to_js(&spend.bundle),
        }
    }

    fn spend_bundle_to_js(spend_bundle: &SpendBundle) -> JsSpendBundle {
        JsSpendBundle {
            spends: spend_bundle.spends.iter().map(coin_spend_to_js).collect(),
        }
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

    fn notifications_to_js(notifications: &[GameNotification]) -> Vec<serde_json::Value> {
        notifications
            .iter()
            .map(|n| {
                serde_json::to_value(n).unwrap_or_else(|_| serde_json::json!(format!("{n:?}")))
            })
            .collect()
    }

    fn to_js_compat<T: Serialize>(value: &T) -> Result<JsValue, types::Error> {
        value
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .into_e()
    }

    fn drain_result_to_js(dr: &DrainResult) -> Result<JsValue, types::Error> {
        to_js_compat(&JsDrainResult {
            handshake_done: dr.handshake_done,
            finished: dr.finished,
            outbound_transactions: dr
                .outbound_transactions
                .iter()
                .map(spend_bundle_to_js)
                .collect(),
            outbound_messages: dr.outbound_messages.iter().map(hex::encode).collect(),
            notifications: notifications_to_js(&dr.notifications),
            receive_errors: dr.receive_errors.iter().map(|e| format!("{e:?}")).collect(),
            coin_solution_requests: dr
                .coin_solution_requests
                .iter()
                .map(coin_string_to_hex)
                .collect(),
            debug_lines: dr.debug_lines.clone(),
        })
    }

    fn with_game_drain<F>(cid: i32, f: F) -> Result<JsValue, JsValue>
    where
        F: FnOnce(&mut JsCradle) -> Result<(), types::Error>,
    {
        with_game(cid, move |cradle: &mut JsCradle| {
            f(cradle)?;
            let dr = cradle
                .cradle
                .drain_all(&mut cradle.allocator, &mut cradle.rng.0)?;
            drain_result_to_js(&dr)
        })
    }

    #[wasm_bindgen]
    pub fn cradle_amount(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| Ok(cradle.cradle.amount()))?;
        serde_wasm_bindgen::to_value(&JsAmount { amt: amount }).into_js()
    }

    #[wasm_bindgen]
    #[deprecated(note = "Share information should come from game notifications")]
    #[allow(deprecated)]
    pub fn cradle_our_share(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle.cradle.get_our_current_share())
        })?;
        serde_wasm_bindgen::to_value(&amount.map(|a| JsAmount { amt: a })).into_js()
    }

    #[wasm_bindgen]
    #[deprecated(note = "Share information should come from game notifications")]
    #[allow(deprecated)]
    pub fn cradle_their_share(cid: i32) -> Result<JsValue, JsValue> {
        let amount = with_game(cid, move |cradle: &mut JsCradle| {
            Ok(cradle.cradle.get_their_current_share())
        })?;
        serde_wasm_bindgen::to_value(&amount.map(|a| JsAmount { amt: a })).into_js()
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

    fn check_for_hex(hex_with_prefix: &str) -> Result<Vec<u8>, JsValue> {
        if let Some(stripped) = hex_with_prefix.strip_prefix("0x") {
            return hex::decode(stripped).into_js();
        }

        hex::decode(hex_with_prefix).into_js()
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
        let conditions = CoinCondition::from_nodeptr(&allocator, run_output.1);
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
        let spend = SpendBundle::from_clvm(&allocator, spend_node).into_js()?;
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
        let parent_coin_info_hash = Hash::from_slice(&parent_coin_bytes).into_js()?;
        let puzzle_hash_hash = Hash::from_slice(&puzzle_hash_bytes).into_js()?;
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
        let public_key_bytes = check_for_hex(public_key)?;
        let pubkey = PublicKey::from_slice(&public_key_bytes).into_js()?;
        let puzzle_hash = puzzle_hash_for_pk(&mut allocator, &pubkey).into_js()?;
        Ok(hex::encode(puzzle_hash.bytes()))
    }

    #[wasm_bindgen(typescript_type = "IChiaIdentityFun")]
    pub fn chia_identity(rng_id: i32) -> Result<JsValue, JsValue> {
        with_rng(rng_id, move |rng: &mut ChaCha8Rng| {
            let mut allocator = AllocEncoder::new();
            let private_key = rng.gen();
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
