use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::channel_state::game::Game;
use crate::common::load_clvm::read_binary_puzzle;
use crate::common::types::{AllocEncoder, GameType, Program, ProgramRef};

include!(concat!(env!("OUT_DIR"), "/game_register.rs"));

thread_local! {
    static CACHED_PRODUCTION: RefCell<Option<RegisteredGameSet>> = const { RefCell::new(None) };
    static CACHED_WITH_TEST: RefCell<Option<RegisteredGameSet>> = const { RefCell::new(None) };
}

#[derive(Clone, Default)]
pub struct RegisteredGameSet {
    pub factories: BTreeMap<GameType, ProgramRef>,
    pub package_ids: Vec<(String, GameType)>,
}

pub fn register_package(
    allocator: &mut AllocEncoder,
    key: &str,
    factory: ProgramRef,
    probe: Program,
    factories: &mut BTreeMap<GameType, ProgramRef>,
    package_ids: &mut Vec<(String, GameType)>,
) {
    let games = Game::run_factory(allocator, factory.clone().into(), &probe)
        .unwrap_or_else(|e| panic!("package {key} factory probe failed: {e:?}"));
    if games.is_empty() {
        panic!("package {key} factory returned no games");
    }
    let id = GameType::from_hash(games[0].initial_validation_program_hash.clone());
    if factories.contains_key(&id) {
        panic!("package {key} duplicate first-validator hash {id}");
    }
    factories.insert(id.clone(), factory);
    package_ids.push((key.to_string(), id));
}

pub fn register_built_package(
    allocator: &mut AllocEncoder,
    key: &str,
    id: GameType,
    factories: &mut BTreeMap<GameType, ProgramRef>,
    package_ids: &mut Vec<(String, GameType)>,
) {
    let factory_path = format!("games/{key}/clsp/factory_prepared.clvm.bin");
    let factory = read_binary_puzzle(allocator, &factory_path)
        .unwrap_or_else(|e| panic!("package {key} loading failed: {e:?}"));
    if factories.contains_key(&id) {
        panic!("package {key} duplicate first-validator hash {id}");
    }
    factories.insert(id.clone(), factory.to_program().into());
    package_ids.push((key.to_string(), id));
}

/// Register production games. Under `cfg(test)`, also register test packages.
pub fn game_collection(allocator: &mut AllocEncoder) -> BTreeMap<GameType, ProgramRef> {
    register_games(allocator).factories
}

fn with_cache<R>(include_test: bool, f: impl FnOnce(&mut RegisteredGameSet) -> R) -> R {
    let slot = if include_test {
        &CACHED_WITH_TEST
    } else {
        &CACHED_PRODUCTION
    };
    slot.with(|cell| {
        let mut set = cell.borrow_mut().take().unwrap_or_default();
        let result = f(&mut set);
        *cell.borrow_mut() = Some(set);
        result
    })
}

fn ensure_package(
    allocator: &mut AllocEncoder,
    key: &str,
    set: &mut RegisteredGameSet,
) -> GameType {
    if let Some((_, id)) = set.package_ids.iter().find(|(k, _)| k == key) {
        return id.clone();
    }
    register_one_package(allocator, key, &mut set.factories, &mut set.package_ids);
    set.package_ids
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, id)| id.clone())
        .unwrap_or_else(|| panic!("package {key} did not register"))
}

fn ensure_all(allocator: &mut AllocEncoder, include_test: bool, set: &mut RegisteredGameSet) {
    for key in production_package_keys() {
        ensure_package(allocator, key, set);
    }
    if include_test {
        for key in test_package_keys() {
            ensure_package(allocator, key, set);
        }
    }
}

fn cached_register(allocator: &mut AllocEncoder, include_test: bool) -> RegisteredGameSet {
    with_cache(include_test, |set| {
        ensure_all(allocator, include_test, set);
        set.clone()
    })
}

pub fn register_games(allocator: &mut AllocEncoder) -> RegisteredGameSet {
    cached_register(allocator, cfg!(test))
}

pub fn game_type_for_package(allocator: &mut AllocEncoder, key: &str) -> GameType {
    register_games(allocator)
        .package_ids
        .into_iter()
        .find(|(k, _)| k == key)
        .map(|(_, id)| id)
        .unwrap_or_else(|| panic!("unknown game package {key}"))
}

pub fn production_package_ids(_allocator: &mut AllocEncoder) -> Vec<(String, GameType)> {
    built_production_package_ids()
}
