use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Program, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const VALIDATOR_NAMES: [&str; 5] = [
    "commitA",
    "commitB",
    "begin_round",
    "mid_round",
    "end",
];
const AMOUNT: i64 = 200;
const BET_UNIT: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
    ClvmException = 6,
}

struct ValidatorInfo {
    puzzle: Puzzle,
    name: &'static str,
}

struct ValidatorLibrary {
    by_hash: std::collections::HashMap<[u8; 32], ValidatorInfo>,
    hashes: Vec<[u8; 32]>,
}

fn load_validators(allocator: &mut AllocEncoder) -> ValidatorLibrary {
    let mut hashes = Vec::new();
    let mut by_hash = std::collections::HashMap::new();
    for name in &VALIDATOR_NAMES {
        let path = format!("clsp/games/spacepoker/onchain/{name}.hex");
        let puzzle = read_hex_puzzle(allocator, &path)
            .unwrap_or_else(|e| panic!("failed to load {path}: {e:?}"));
        let ph = puzzle.sha256tree(allocator);
        let hash_bytes: [u8; 32] = *ph.hash().bytes();
        hashes.push(hash_bytes);
        by_hash.insert(hash_bytes, ValidatorInfo { puzzle, name });
    }
    ValidatorLibrary { by_hash, hashes }
}

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    *Sha256Input::Bytes(data).hash().bytes()
}

fn int_from_atom(allocator: &mut AllocEncoder, node: NodePtr) -> i64 {
    match allocator.allocator().sexp(node) {
        SExp::Atom => {
            let bytes = allocator.allocator().atom(node);
            if bytes.is_empty() {
                return 0;
            }
            let mut val: i64 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
            for &b in bytes.as_ref() {
                val = (val << 8) | b as i64;
            }
            val
        }
        _ => panic!("expected atom, got pair"),
    }
}

fn build_curry_args(
    allocator: &mut AllocEncoder,
    on_chain: bool,
    move_node: NodePtr,
    max_move_size: i64,
    mover_share: i64,
) -> NodePtr {
    let waiter_ph: NodePtr = if on_chain {
        1i64.to_clvm(allocator).unwrap()
    } else {
        NodePtr::NIL
    };
    let amount_node = AMOUNT.to_clvm(allocator).unwrap();
    let mms_node = max_move_size.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();

    let a = allocator.allocator();
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(ms_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(mms_node, tail).unwrap();
    let tail = a.new_pair(move_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(amount_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(waiter_ph, tail).unwrap();
    a.new_pair(NodePtr::NIL, tail).unwrap()
}

fn build_validator_args(
    allocator: &mut AllocEncoder,
    validator_hash: &[u8; 32],
    on_chain: bool,
    move_bytes: &[u8],
    max_move_size: i64,
    mover_share: i64,
    previous_state: NodePtr,
    validator_program: NodePtr,
    evidence: Option<&[u8]>,
) -> NodePtr {
    let move_node = allocator.allocator().new_atom(move_bytes).unwrap();
    let evidence_node = match evidence {
        Some(e) => allocator.allocator().new_atom(e).unwrap(),
        None => NodePtr::NIL,
    };
    let vh_node = allocator.allocator().new_atom(validator_hash).unwrap();

    let curry_args = build_curry_args(allocator, on_chain, move_node, max_move_size, mover_share);

    let a = allocator.allocator();
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(evidence_node, tail).unwrap();
    let tail = a.new_pair(validator_program, tail).unwrap();
    let tail = a.new_pair(previous_state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    a.new_pair(vh_node, tail).unwrap()
}

struct MoveResult {
    move_code: MoveCode,
    next_validator_hash: Option<[u8; 32]>,
    state: NodePtr,
    next_max_move_size: i64,
}

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> MoveResult {
    let items = proper_list(allocator.allocator(), result, true)
        .expect("validator output should be a proper list");
    if items.is_empty() {
        MoveResult {
            move_code: MoveCode::Slash,
            next_validator_hash: None,
            state: NodePtr::NIL,
            next_max_move_size: 0,
        }
    } else {
        assert!(items.len() >= 4, "MAKE_MOVE output too short");
        let hash_bytes = allocator.allocator().atom(items[0]);
        let next_validator_hash = if hash_bytes.is_empty() {
            None
        } else {
            let mut h = [0u8; 32];
            h.copy_from_slice(hash_bytes.as_ref());
            Some(h)
        };
        let max_move_size = int_from_atom(allocator, items[2]);
        MoveResult {
            move_code: MoveCode::MakeMove,
            next_validator_hash,
            state: items[1],
            next_max_move_size: max_move_size,
        }
    }
}

fn run_validator_step(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    validator_hash: &[u8; 32],
    on_chain: bool,
    move_bytes: &[u8],
    max_move_size: i64,
    mover_share: i64,
    previous_state: NodePtr,
    evidence: Option<&[u8]>,
) -> Result<MoveResult, String> {
    let info = lib
        .by_hash
        .get(validator_hash)
        .unwrap_or_else(|| panic!("unknown validator hash: {}", hex::encode(validator_hash)));

    let program_clvm = info.puzzle.to_clvm(allocator).unwrap();

    let args = build_validator_args(
        allocator,
        validator_hash,
        on_chain,
        move_bytes,
        max_move_size,
        mover_share,
        previous_state,
        program_clvm,
        evidence,
    );

    match run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        args,
        0,
    ) {
        Ok(reduction) => Ok(parse_validator_output(allocator, reduction.1)),
        Err(e) => Err(format!("CLVM error: {e:?}")),
    }
}

struct StepSpec {
    move_bytes: Vec<u8>,
    mover_share: i64,
    evidence: Option<Vec<u8>>,
    expected: MoveCode,
    on_chain: bool,
    validator_name: &'static str,
}

fn run_step_and_check(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    last: &MoveResult,
    spec: &StepSpec,
) -> Option<MoveResult> {
    let vh = last.next_validator_hash.as_ref()?;

    let info = lib.by_hash.get(vh).unwrap_or_else(|| {
        panic!(
            "validator hash {} not found in library (have: {})",
            hex::encode(vh),
            lib.by_hash
                .keys()
                .map(|k| hex::encode(k))
                .collect::<Vec<_>>()
                .join(", "),
        );
    });
    assert_eq!(
        info.name, spec.validator_name,
        "expected validator {}, got {}",
        spec.validator_name, info.name
    );

    let result = run_validator_step(
        allocator,
        lib,
        vh,
        spec.on_chain,
        &spec.move_bytes,
        last.next_max_move_size,
        spec.mover_share,
        last.state,
        spec.evidence.as_deref(),
    );

    match spec.expected {
        MoveCode::ClvmException => {
            assert!(result.is_err(), "expected CLVM exception but got Ok");
            None
        }
        expected => {
            let r = result.unwrap_or_else(|e| panic!("unexpected CLVM error: {e}"));
            assert_eq!(
                r.move_code, expected,
                "step {}: expected {:?}, got {:?}",
                spec.validator_name, expected, r.move_code
            );
            if r.move_code == MoveCode::Slash {
                None
            } else {
                Some(r)
            }
        }
    }
}

fn initial_move_result(lib: &ValidatorLibrary) -> MoveResult {
    let bet_unit_bytes = BET_UNIT.to_be_bytes();
    let trimmed = &bet_unit_bytes[bet_unit_bytes.iter().position(|&b| b != 0).unwrap_or(7)..];
    MoveResult {
        move_code: MoveCode::MakeMove,
        next_validator_hash: Some(lib.hashes[0]),
        state: NodePtr::NIL, // will be set properly below
        next_max_move_size: 32,
    }
}

fn make_step(
    move_bytes: &[u8],
    mover_share: i64,
    evidence: Option<&[u8]>,
    expected: MoveCode,
    on_chain: bool,
    validator_name: &'static str,
) -> StepSpec {
    StepSpec {
        move_bytes: move_bytes.to_vec(),
        mover_share,
        evidence: evidence.map(|e| e.to_vec()),
        expected,
        on_chain,
        validator_name,
    }
}

fn run_sequence(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    initial: &MoveResult,
    steps: &[StepSpec],
) -> Option<MoveResult> {
    let mut current = MoveResult {
        move_code: initial.move_code,
        next_validator_hash: initial.next_validator_hash,
        state: initial.state,
        next_max_move_size: initial.next_max_move_size,
    };
    for step in steps {
        match run_step_and_check(allocator, lib, &current, step) {
            Some(next) => current = next,
            None => return None,
        }
    }
    Some(current)
}

fn make_initial(allocator: &mut AllocEncoder, lib: &ValidatorLibrary) -> MoveResult {
    let bet_unit_node = BET_UNIT.to_clvm(allocator).unwrap();
    MoveResult {
        move_code: MoveCode::MakeMove,
        next_validator_hash: Some(lib.hashes[0]),
        state: bet_unit_node,
        next_max_move_size: 32,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

fn test_spacepoker_validator_hashes() {
    let mut allocator = AllocEncoder::new();
    let lib = load_validators(&mut allocator);
    assert_eq!(lib.hashes.len(), 5);
    for (i, name) in VALIDATOR_NAMES.iter().enumerate() {
        let info = lib.by_hash.get(&lib.hashes[i]).unwrap();
        assert_eq!(info.name, *name);
    }
}

fn test_spacepoker_commitA_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let move_bytes = [0xAA_u8; 32];
    let result = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&move_bytes, AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    );
    assert!(result.is_some(), "commitA happy path should succeed");
}

fn test_spacepoker_commitA_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 31], AMOUNT / 2, None, MoveCode::Slash, false, "commitA"),
    );
}

fn test_spacepoker_commitA_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 33], AMOUNT / 2, None, MoveCode::Slash, false, "commitA"),
    );
}

fn test_spacepoker_commitA_slash_wrong_mover_share() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 32], 0, None, MoveCode::Slash, false, "commitA"),
    );
}

fn test_spacepoker_commitB_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 32], AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    )
    .unwrap();
    let result = run_step_and_check(
        &mut a,
        &lib,
        &after_a,
        &make_step(
            &[0xBB; 32],
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "commitB",
        ),
    );
    assert!(result.is_some(), "commitB happy path should succeed");
}

fn test_spacepoker_commitB_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 32], AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after_a,
        &make_step(
            &[0xBB; 31],
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::Slash,
            false,
            "commitB",
        ),
    );
}

fn test_spacepoker_commitB_slash_wrong_mover_share() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&[0xAA; 32], AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after_a,
        &make_step(
            &[0xBB; 32],
            AMOUNT / 2,
            None,
            MoveCode::Slash,
            false,
            "commitB",
        ),
    );
}

fn test_spacepoker_begin_round_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let alice_image_4 = sha256_bytes(&[0x11; 16]);
    let alice_image_5 = sha256_bytes(&alice_image_4);

    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&alice_image_5, AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    )
    .unwrap();
    let after_b = run_step_and_check(
        &mut a,
        &lib,
        &after_a,
        &make_step(
            &[0xBB; 32],
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "commitB",
        ),
    )
    .unwrap();

    let mut move_bytes = alice_image_4.to_vec();
    move_bytes.push(0); // raise 0

    let result = run_step_and_check(
        &mut a,
        &lib,
        &after_b,
        &make_step(
            &move_bytes,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "begin_round",
        ),
    );
    assert!(result.is_some(), "begin_round happy path should succeed");
}

fn test_spacepoker_begin_round_slash_bad_image() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let alice_image_5 = sha256_bytes(&[0x11; 32]);

    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&alice_image_5, AMOUNT / 2, None, MoveCode::MakeMove, false, "commitA"),
    )
    .unwrap();
    let after_b = run_step_and_check(
        &mut a,
        &lib,
        &after_a,
        &make_step(
            &[0xBB; 32],
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "commitB",
        ),
    )
    .unwrap();

    let mut move_bytes = [0xFF_u8; 32].to_vec();
    move_bytes.push(0);

    run_step_and_check(
        &mut a,
        &lib,
        &after_b,
        &make_step(
            &move_bytes,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::Slash,
            false,
            "begin_round",
        ),
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        (
            "test_spacepoker_validator_hashes",
            &test_spacepoker_validator_hashes,
        ),
        (
            "test_spacepoker_commitA_happy",
            &test_spacepoker_commitA_happy,
        ),
        (
            "test_spacepoker_commitA_slash_too_short",
            &test_spacepoker_commitA_slash_too_short,
        ),
        (
            "test_spacepoker_commitA_slash_too_long",
            &test_spacepoker_commitA_slash_too_long,
        ),
        (
            "test_spacepoker_commitA_slash_wrong_mover_share",
            &test_spacepoker_commitA_slash_wrong_mover_share,
        ),
        (
            "test_spacepoker_commitB_happy",
            &test_spacepoker_commitB_happy,
        ),
        (
            "test_spacepoker_commitB_slash_too_short",
            &test_spacepoker_commitB_slash_too_short,
        ),
        (
            "test_spacepoker_commitB_slash_wrong_mover_share",
            &test_spacepoker_commitB_slash_wrong_mover_share,
        ),
        (
            "test_spacepoker_begin_round_happy",
            &test_spacepoker_begin_round_happy,
        ),
        (
            "test_spacepoker_begin_round_slash_bad_image",
            &test_spacepoker_begin_round_slash_bad_image,
        ),
    ]
}
