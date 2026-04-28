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
        Puzzle, PuzzleHash, Sha256Input, Spend, SpendBundle, Timeout,
    };

    use chia_protocol::SpendBundle as ProtocolSpendBundle;
    use chia_traits::Streamable;
    use flate2::Decompress;
    use flate2::FlushDecompress;
    use chia_gaming::peer_container::{
        DrainResult, GameCradle, SynchronousGameCradle, SynchronousGameCradleConfig, WatchReport,
    };
    use chia_gaming::potato_handler::effects::{CradleEvent, GameNotification};
    use chia_gaming::potato_handler::handshake::{CoinSpendRequest, RawCoinCondition};
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

    export type CradleEvent =
        | { OutboundMessage: string }
        | { OutboundTransaction: SpendBundle }
        | { Notification: any }
        | { Log: string }
        | { CoinSolutionRequest: string }
        | { ReceiveError: string }
        | { NeedCoinSpend: {
            "amount": number,
            "conditions": Array<{ "opcode": number, "args": Array<string> }>,
            "coin_id"?: string,
            "max_height"?: number,
          } }
        | { NeedLauncherCoin: boolean }
        | { WatchCoin: { coin_name: string, coin_string: string } };

    export type DrainResult = {
        "events": Array<CradleEvent>,
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

    #[derive(Serialize)]
    struct JsWatchCoinEntry {
        coin_name: String,
        coin_string: String,
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

    #[cfg(target_family = "wasm")]
    unsafe extern "C" {
        fn __wasm_call_ctors();
    }

    #[wasm_bindgen]
    pub fn init() {
        #[cfg(target_family = "wasm")]
        unsafe {
            __wasm_call_ctors();
        }
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
        let byte_data = hex::decode(&js_factory.hex).map_err(|e| {
            js_error(&format!(
                "game factory '{name}' hex decode: {e:?} (length={})",
                js_factory.hex.len(),
            ))
        })?;
        let parser_program = if let Some(ref parser_hex) = js_factory.parser_hex {
            let parser_bytes = hex::decode(parser_hex).map_err(|e| {
                js_error(&format!(
                    "game factory '{name}' parser_hex decode: {e:?} (length={})",
                    parser_hex.len(),
                ))
            })?;
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
        let reward_puzzle_hash_bytes = hex::decode(&jsconfig.reward_puzzle_hash).map_err(|e| {
            js_error(&format!(
                "reward_puzzle_hash hex decode: {e:?} (length={})",
                jsconfig.reward_puzzle_hash.len(),
            ))
        })?;

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

    fn js_error(msg: &str) -> JsValue {
        js_sys::Error::new(msg).into()
    }

    impl ErrIntoJs for types::Error {
        type EResult = JsValue;
        fn into_js(self) -> Self::EResult {
            js_error(&format!("{self:?}"))
        }
    }

    impl ErrIntoJs for FromHexError {
        type EResult = JsValue;
        fn into_js(self) -> Self::EResult {
            js_error(&format!("{self:?}"))
        }
    }

    impl ErrIntoJs for serde_wasm_bindgen::Error {
        type EResult = JsValue;
        fn into_js(self) -> Self::EResult {
            js_error(&format!("{self:?}"))
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
            let private_key: PrivateKey = rng.random();
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
    pub fn create_serialized_game(data: &[u8], new_seed: &str) -> Result<i32, JsValue> {
        let mut cradle: JsCradle = bencodex::from_slice::<JsCradle>(data)
            .map_err(|e| types::Error::StrErr(e.to_string()))
            .into_js()?;
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
    pub fn serialize_cradle(cid: i32) -> Result<js_sys::Uint8Array, JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            let bytes = bencodex::to_vec(&cradle)
                .map_err(|e| types::Error::StrErr(e.to_string()))?;
            Ok(js_sys::Uint8Array::from(bytes.as_slice()))
        })
    }

    #[wasm_bindgen]
    pub fn get_watching_coins(cid: i32) -> Result<JsValue, JsValue> {
        let result = with_game(cid, move |cradle: &mut JsCradle| {
            let coins = cradle.cradle.get_watching_coins();
            let entries: Vec<JsWatchCoinEntry> = coins
                .iter()
                .map(|cs| JsWatchCoinEntry {
                    coin_name: hex::encode(cs.to_coin_id().bytes()),
                    coin_string: coin_string_to_hex(cs),
                })
                .collect();
            Ok(entries)
        })?;
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
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
                .opening_coin(&mut cradle.allocator, coin)
        })
    }

    #[wasm_bindgen]
    pub fn start_handshake(cid: i32) -> Result<JsValue, JsValue> {
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.start_handshake(&mut cradle.allocator)
        })
    }

    #[wasm_bindgen]
    pub fn provide_launcher_coin(cid: i32, hex_coinstring: &str) -> Result<JsValue, JsValue> {
        let coin = hex_to_coinstring(hex_coinstring).into_js()?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .provide_launcher_coin(&mut cradle.allocator, coin)
        })
    }

    fn coinset_spend_bundle_to_spend_bundle(
        bundle: &CoinsetSpendBundle,
    ) -> Result<SpendBundle, types::Error> {
        let mut spends = Vec::with_capacity(bundle.coin_spends.len());
        for s in bundle.coin_spends.iter() {
            let mut converted = convert_coinset_org_spend_to_spend(
                &s.coin.parent_coin_info,
                &s.coin.puzzle_hash,
                s.coin.amount,
                &s.puzzle_reveal,
                &s.solution,
            )?;
            converted.bundle.signature = Aggsig::default();
            spends.push(converted);
        }

        if let Some(first) = spends.first_mut() {
            let agg_sig = check_for_hex(&bundle.aggregated_signature).into_e()?;
            first.bundle.signature = Aggsig::from_slice(&agg_sig)?;
        }

        Ok(SpendBundle { name: None, spends })
    }

    #[wasm_bindgen]
    pub fn provide_coin_spend_bundle(cid: i32, bundle_json: &str) -> Result<JsValue, JsValue> {
        let bundle = serde_json::from_str::<CoinsetSpendBundle>(bundle_json)
            .map_err(|e| JsValue::from_str(&format!("bad spend bundle json: {e}")))?;
        let spend_bundle = coinset_spend_bundle_to_spend_bundle(&bundle).into_js()?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .provide_coin_spend_bundle(&mut cradle.allocator, spend_bundle)
        })
    }

    // Deprecated puzzles not in chia-puzzles crate (kept for zlib dictionary compat)
    const LEGACY_CAT_MOD_HEX: &str = "ff02ffff01ff02ff5effff04ff02ffff04ffff04ff05ffff04ffff0bff2cff0580ffff04ff0bff80808080ffff04ffff02ff17ff2f80ffff04ff5fffff04ffff02ff2effff04ff02ffff04ff17ff80808080ffff04ffff0bff82027fff82057fff820b7f80ffff04ff81bfffff04ff82017fffff04ff8202ffffff04ff8205ffffff04ff820bffff80808080808080808080808080ffff04ffff01ffffffff81ca3dff46ff0233ffff3c04ff01ff0181cbffffff02ff02ffff03ff05ffff01ff02ff32ffff04ff02ffff04ff0dffff04ffff0bff22ffff0bff2cff3480ffff0bff22ffff0bff22ffff0bff2cff5c80ff0980ffff0bff22ff0bffff0bff2cff8080808080ff8080808080ffff010b80ff0180ffff02ffff03ff0bffff01ff02ffff03ffff09ffff02ff2effff04ff02ffff04ff13ff80808080ff820b9f80ffff01ff02ff26ffff04ff02ffff04ffff02ff13ffff04ff5fffff04ff17ffff04ff2fffff04ff81bfffff04ff82017fffff04ff1bff8080808080808080ffff04ff82017fff8080808080ffff01ff088080ff0180ffff01ff02ffff03ff17ffff01ff02ffff03ffff20ff81bf80ffff0182017fffff01ff088080ff0180ffff01ff088080ff018080ff0180ffff04ffff04ff05ff2780ffff04ffff10ff0bff5780ff778080ff02ffff03ff05ffff01ff02ffff03ffff09ffff02ffff03ffff09ff11ff7880ffff0159ff8080ff0180ffff01818f80ffff01ff02ff7affff04ff02ffff04ff0dffff04ff0bffff04ffff04ff81b9ff82017980ff808080808080ffff01ff02ff5affff04ff02ffff04ffff02ffff03ffff09ff11ff7880ffff01ff04ff78ffff04ffff02ff36ffff04ff02ffff04ff13ffff04ff29ffff04ffff0bff2cff5b80ffff04ff2bff80808080808080ff398080ffff01ff02ffff03ffff09ff11ff2480ffff01ff04ff24ffff04ffff0bff20ff2980ff398080ffff010980ff018080ff0180ffff04ffff02ffff03ffff09ff11ff7880ffff0159ff8080ff0180ffff04ffff02ff7affff04ff02ffff04ff0dffff04ff0bffff04ff17ff808080808080ff80808080808080ff0180ffff01ff04ff80ffff04ff80ff17808080ff0180ffffff02ffff03ff05ffff01ff04ff09ffff02ff26ffff04ff02ffff04ff0dffff04ff0bff808080808080ffff010b80ff0180ff0bff22ffff0bff2cff5880ffff0bff22ffff0bff22ffff0bff2cff5c80ff0580ffff0bff22ffff02ff32ffff04ff02ffff04ff07ffff04ffff0bff2cff2c80ff8080808080ffff0bff2cff8080808080ffff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff2effff04ff02ffff04ff09ff80808080ffff02ff2effff04ff02ffff04ff0dff8080808080ffff01ff0bff2cff058080ff0180ffff04ffff04ff28ffff04ff5fff808080ffff02ff7effff04ff02ffff04ffff04ffff04ff2fff0580ffff04ff5fff82017f8080ffff04ffff02ff7affff04ff02ffff04ff0bffff04ff05ffff01ff808080808080ffff04ff17ffff04ff81bfffff04ff82017fffff04ffff0bff8204ffffff02ff36ffff04ff02ffff04ff09ffff04ff820affffff04ffff0bff2cff2d80ffff04ff15ff80808080808080ff8216ff80ffff04ff8205ffffff04ff820bffff808080808080808080808080ff02ff2affff04ff02ffff04ff5fffff04ff3bffff04ffff02ffff03ff17ffff01ff09ff2dffff0bff27ffff02ff36ffff04ff02ffff04ff29ffff04ff57ffff04ffff0bff2cff81b980ffff04ff59ff80808080808080ff81b78080ff8080ff0180ffff04ff17ffff04ff05ffff04ff8202ffffff04ffff04ffff04ff24ffff04ffff0bff7cff2fff82017f80ff808080ffff04ffff04ff30ffff04ffff0bff81bfffff0bff7cff15ffff10ff82017fffff11ff8202dfff2b80ff8202ff808080ff808080ff138080ff80808080808080808080ff018080";

    const OFFER_MOD_OLD_HEX: &str = "ff02ffff01ff02ff0affff04ff02ffff04ff03ff80808080ffff04ffff01ffff333effff02ffff03ff05ffff01ff04ffff04ff0cffff04ffff02ff1effff04ff02ffff04ff09ff80808080ff808080ffff02ff16ffff04ff02ffff04ff19ffff04ffff02ff0affff04ff02ffff04ff0dff80808080ff808080808080ff8080ff0180ffff02ffff03ff05ffff01ff04ffff04ff08ff0980ffff02ff16ffff04ff02ffff04ff0dffff04ff0bff808080808080ffff010b80ff0180ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff1effff04ff02ffff04ff09ff80808080ffff02ff1effff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080";

    const LATEST_OFFER_VERSION: u16 = 6;

    fn zdict_for_version(version: u16) -> Result<Vec<u8>, String> {
        let legacy_cat = hex::decode(LEGACY_CAT_MOD_HEX)
            .map_err(|e| format!("bad LEGACY_CAT_MOD hex: {e}"))?;
        let offer_old = hex::decode(OFFER_MOD_OLD_HEX)
            .map_err(|e| format!("bad OFFER_MOD_OLD hex: {e}"))?;

        // ZDICT entries indexed by version-1.
        // Mirrors chia-blockchain/chia/wallet/util/puzzle_compression.py
        let dicts: [&[u8]; 6] = [
            // v1: standard puzzle + legacy CAT
            &[
                chia_puzzles::P2_DELEGATED_PUZZLE_OR_HIDDEN_PUZZLE.as_slice(),
                legacy_cat.as_slice(),
            ].concat(),
            // v2: old offer/settlement mod
            &offer_old,
            // v3: singleton + NFT puzzles
            &[
                chia_puzzles::SINGLETON_TOP_LAYER_V1_1.as_slice(),
                chia_puzzles::NFT_STATE_LAYER.as_slice(),
                chia_puzzles::NFT_OWNERSHIP_LAYER.as_slice(),
                chia_puzzles::NFT_METADATA_UPDATER_DEFAULT.as_slice(),
                chia_puzzles::NFT_OWNERSHIP_TRANSFER_PROGRAM_ONE_WAY_CLAIM_WITH_ROYALTIES.as_slice(),
            ].concat(),
            // v4: current CAT puzzle
            chia_puzzles::CAT_PUZZLE.as_slice(),
            // v5: current settlement payment
            chia_puzzles::SETTLEMENT_PAYMENT.as_slice(),
            // v6: empty (compatibility break)
            &[],
        ];

        let mut result = Vec::new();
        let end = (version as usize).min(dicts.len());
        for dict in &dicts[..end] {
            result.extend_from_slice(dict);
        }
        Ok(result)
    }

    fn decompress_offer_with_zdict(data: &[u8], zdict: &[u8]) -> Result<Vec<u8>, String> {
        let mut d = Decompress::new(true);
        let mut output = vec![0u8; 6 * 1024 * 1024];
        let result = d.decompress(data, &mut output, FlushDecompress::Finish);
        match result {
            Ok(_status) => {
                let total = d.total_out() as usize;
                output.truncate(total);
                Ok(output)
            }
            Err(e) => {
                if e.needs_dictionary().is_none() {
                    return Err(format!("zlib decompression error: {e}"));
                }
                d.set_dictionary(zdict)
                    .map_err(|e| format!("set_dictionary: {e}"))?;
                let consumed = d.total_in() as usize;
                let produced = d.total_out() as usize;
                d.decompress(
                    &data[consumed..],
                    &mut output[produced..],
                    FlushDecompress::Finish,
                )
                .map_err(|e| format!("decompression after set_dictionary: {e}"))?;
                let total = d.total_out() as usize;
                output.truncate(total);
                Ok(output)
            }
        }
    }

    fn decode_offer_to_spend_bundle(offer_bech32: &str) -> Result<SpendBundle, String> {
        let (_hrp, raw_bytes) = bech32::decode(offer_bech32)
            .map_err(|e| format!("bech32m decode error: {e}"))?;

        if raw_bytes.len() < 3 {
            return Err(format!("offer data too short ({} bytes)", raw_bytes.len()));
        }

        let version = u16::from_be_bytes([raw_bytes[0], raw_bytes[1]]);
        if version > LATEST_OFFER_VERSION {
            return Err(format!(
                "offer compression version {version} unsupported (max {LATEST_OFFER_VERSION})"
            ));
        }

        let zdict = zdict_for_version(version)?;
        let decompressed = decompress_offer_with_zdict(&raw_bytes[2..], &zdict)?;

        let proto_bundle = ProtocolSpendBundle::from_bytes(&decompressed)
            .map_err(|e| format!("streamable parse: {e}"))?;

        let agg_sig = Aggsig::from_bls(proto_bundle.aggregated_signature);
        let mut first = true;
        let spends = proto_bundle.coin_spends.into_iter().map(|cs| {
            let coin_string = CoinString::from_parts(
                &CoinID::new(Hash::from_slice(cs.coin.parent_coin_info.as_ref())
                    .expect("parent_coin_info is 32 bytes")),
                &PuzzleHash::from_hash(Hash::from_slice(cs.coin.puzzle_hash.as_ref())
                    .expect("puzzle_hash is 32 bytes")),
                &Amount::new(cs.coin.amount),
            );
            let sig = if first { first = false; agg_sig.clone() } else { Aggsig::default() };
            CoinSpend {
                coin: coin_string,
                bundle: Spend {
                    puzzle: Puzzle::from_bytes(cs.puzzle_reveal.as_ref()),
                    solution: Program::from_bytes(cs.solution.as_ref()).into(),
                    signature: sig,
                },
            }
        }).collect();

        Ok(SpendBundle { name: None, spends })
    }

    #[wasm_bindgen]
    pub fn provide_offer_bech32(cid: i32, offer_bech32: &str) -> Result<JsValue, JsValue> {
        let bundle = decode_offer_to_spend_bundle(offer_bech32)
            .map_err(|e| JsValue::from_str(&format!("offer decode error: {e}")))?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .provide_coin_spend_bundle(&mut cradle.allocator, bundle)
        })
    }

    #[wasm_bindgen]
    pub fn get_channel_puzzle_hash(cid: i32) -> Result<JsValue, JsValue> {
        with_game(cid, move |cradle: &mut JsCradle| {
            let ph = cradle.cradle.channel_puzzle_hash();
            match ph {
                Some(p) => Ok(JsValue::from_str(&hex::encode(p.bytes()))),
                None => Ok(JsValue::NULL),
            }
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
                game_type: GameType(hex::decode(&js_game_start.game_type).into_gen()?),
                timeout: Timeout::new(js_game_start.timeout),
                amount: Amount::new(js_game_start.amount),
                my_contribution: Amount::new(js_game_start.my_contribution),
                my_turn: js_game_start.my_turn,
                parameters: parameters_program,
            };
            let ids = cradle.cradle.propose_game(
                &mut cradle.allocator,
                &game_start,
            )?;
            let dr = cradle
                .cradle
                .flush_and_collect(&mut cradle.allocator)?;

            let events = js_sys::Array::new();
            for event in &dr.events {
                events.push(&cradle_event_to_js(event)?);
            }
            let ids_arr = js_sys::Array::new();
            for id in &ids {
                ids_arr.push(&JsValue::from_str(&game_id_to_string(id)));
            }
            let obj = js_sys::Object::new();
            let _ = js_sys::Reflect::set(&obj, &"ids".into(), &ids_arr);
            let _ = js_sys::Reflect::set(&obj, &"events".into(), &events);
            Ok(obj.into())
        })
    }

    #[wasm_bindgen]
    pub fn accept_proposal(cid: i32, game_id: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(game_id)?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .accept_proposal(&mut cradle.allocator, &game_id)
        })
    }

    #[wasm_bindgen]
    pub fn cancel_proposal(cid: i32, game_id: &str) -> Result<JsValue, JsValue> {
        let game_id = string_to_game_id(game_id)?;
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .cancel_proposal(&mut cradle.allocator, &game_id)
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
            let entropy: Hash = new_entropy.unwrap_or_else(|| cradle.rng.0.random());
            cradle.cradle.make_move(
                &mut cradle.allocator,
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
                .cheat(&mut cradle.allocator, &game_id, share)
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
            let entropy: Hash = cradle.rng.0.random();
            cradle.cradle.accept_proposal_and_move(
                &mut cradle.allocator,
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
                .get_game_state_id(&mut cradle.allocator)?
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
                .accept_timeout(&mut cradle.allocator, &game_id)
        })
    }

    #[wasm_bindgen]
    pub fn shut_down(cid: i32) -> Result<JsValue, JsValue> {
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle
                .cradle
                .shut_down(&mut cradle.allocator)
        })
    }

    #[wasm_bindgen]
    pub fn go_on_chain(cid: i32) -> Result<JsValue, JsValue> {
        with_game_drain(cid, move |cradle: &mut JsCradle| {
            cradle.cradle.go_on_chain(
                &mut cradle.allocator,
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
                &coin,
                ps_pair,
            )
        })
    }

    #[wasm_bindgen]
    pub fn deliver_message(cid: i32, inbound_message: &[u8]) -> Result<JsValue, JsValue> {
        let message_data = inbound_message.to_vec();
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
    struct JsRawCoinCondition {
        opcode: u32,
        args: Vec<String>,
    }

    #[derive(Serialize)]
    struct JsCoinSpendRequest {
        amount: u64,
        conditions: Vec<JsRawCoinCondition>,
        coin_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_height: Option<u64>,
    }

    fn raw_condition_to_js(cond: &RawCoinCondition) -> JsRawCoinCondition {
        JsRawCoinCondition {
            opcode: cond.opcode,
            args: cond.args.iter().map(hex::encode).collect(),
        }
    }

    fn coin_spend_request_to_js(req: &CoinSpendRequest) -> JsCoinSpendRequest {
        JsCoinSpendRequest {
            amount: req.amount.to_u64(),
            conditions: req.conditions.iter().map(raw_condition_to_js).collect(),
            coin_id: req.coin_id.as_ref().map(|c| hex::encode(c.bytes())),
            max_height: req.max_height,
        }
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

    fn json_event_to_js(val: serde_json::Value) -> Result<JsValue, types::Error> {
        val.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .into_e()
    }

    fn cradle_event_to_js(event: &CradleEvent) -> Result<JsValue, types::Error> {
        match event {
            CradleEvent::OutboundMessage(data) => {
                let obj = js_sys::Object::new();
                let arr = js_sys::Uint8Array::from(data.as_slice());
                let _ = js_sys::Reflect::set(&obj, &"OutboundMessage".into(), &arr);
                Ok(obj.into())
            }
            CradleEvent::OutboundTransaction(bundle) => {
                json_event_to_js(serde_json::json!({ "OutboundTransaction": spend_bundle_to_js(bundle) }))
            }
            CradleEvent::Notification(n) => {
                let val = serde_json::to_value(n)
                    .unwrap_or_else(|_| serde_json::json!(format!("{n:?}")));
                json_event_to_js(serde_json::json!({ "Notification": val }))
            }
            CradleEvent::Log(line) => {
                json_event_to_js(serde_json::json!({ "Log": line }))
            }
            CradleEvent::CoinSolutionRequest(coin) => {
                json_event_to_js(serde_json::json!({ "CoinSolutionRequest": coin_string_to_hex(coin) }))
            }
            CradleEvent::ReceiveError(msg) => {
                json_event_to_js(serde_json::json!({ "ReceiveError": msg }))
            }
            CradleEvent::NeedCoinSpend(req) => {
                json_event_to_js(serde_json::json!({ "NeedCoinSpend": coin_spend_request_to_js(req) }))
            }
            CradleEvent::NeedLauncherCoin => {
                json_event_to_js(serde_json::json!({ "NeedLauncherCoin": true }))
            }
            CradleEvent::WatchCoin {
                coin_name,
                coin_string,
            } => {
                json_event_to_js(serde_json::json!({
                    "WatchCoin": {
                        "coin_name": hex::encode(coin_name.bytes()),
                        "coin_string": coin_string_to_hex(coin_string),
                    }
                }))
            }
        }
    }

    fn drain_result_to_js(dr: &DrainResult) -> Result<JsValue, types::Error> {
        let events = js_sys::Array::new();
        for event in &dr.events {
            events.push(&cradle_event_to_js(event)?);
        }
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &"events".into(), &events);
        Ok(obj.into())
    }

    fn with_game_drain<F>(cid: i32, f: F) -> Result<JsValue, JsValue>
    where
        F: FnOnce(&mut JsCradle) -> Result<(), types::Error>,
    {
        with_game(cid, move |cradle: &mut JsCradle| {
            if let Err(e) = f(cradle) {
                let reason = format!("{e:?}");
                cradle.cradle.push_event(CradleEvent::Log(format!(
                    "DBG_ONCHAIN: with_game_drain caught error, converting to ActionFailed: {reason}"
                )));
                cradle.cradle.push_event(CradleEvent::Notification(
                    GameNotification::ActionFailed {
                        reason,
                    },
                ));
            }
            let dr = cradle.cradle.flush_and_collect(&mut cradle.allocator)?;
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
            let private_key = rng.random();
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
