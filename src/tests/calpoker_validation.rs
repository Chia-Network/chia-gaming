use std::collections::HashMap;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const VALIDATOR_NAMES: [&str; 5] = ["a", "b", "c", "d", "e"];
const AMOUNT: i64 = 200;

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
    by_hash: HashMap<[u8; 32], ValidatorInfo>,
    hashes: Vec<[u8; 32]>,
}

fn load_validators(allocator: &mut AllocEncoder) -> ValidatorLibrary {
    let mut hashes = Vec::new();
    let mut by_hash = HashMap::new();
    for name in &VALIDATOR_NAMES {
        let path = format!("clsp/games/calpoker/onchain/{name}.hex");
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

fn sha256_concat(parts: &[&[u8]]) -> [u8; 32] {
    let inputs: Vec<Sha256Input> = parts.iter().map(|b| Sha256Input::Bytes(b)).collect();
    *Sha256Input::Array(inputs).hash().bytes()
}

fn bitfield_to_byte(indices: &[u8]) -> Vec<u8> {
    let mut v: u8 = 0;
    for &bit in indices {
        v |= 1 << bit;
    }
    vec![v]
}

struct GameSeed {
    alice_seed: Vec<u8>,
    bob_seed: Vec<u8>,
    seed: Vec<u8>,
}

impl GameSeed {
    fn new(int_seed: u64) -> Self {
        let alice_seed = sha256_bytes(format!("alice{int_seed}").as_bytes())[..16].to_vec();
        let bob_seed = sha256_bytes(format!("bob{int_seed}").as_bytes())[..16].to_vec();
        let amount_byte: u8 = 200;
        let seed = sha256_concat(&[&alice_seed, &bob_seed, &[amount_byte]])[..].to_vec();
        GameSeed {
            alice_seed,
            bob_seed,
            seed,
        }
    }
}

struct MoveResult {
    move_code: MoveCode,
    next_validator_hash: Option<[u8; 32]>,
    state: NodePtr,
    next_max_move_size: i64,
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

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> MoveResult {
    let items = proper_list(allocator.allocator(), result, true)
        .expect("validator output should be a proper list");
    assert!(
        items.len() >= 2,
        "validator output too short: {}",
        items.len()
    );

    let code_int = int_from_atom(allocator, items[0]);
    let move_code = match code_int {
        0 => MoveCode::MakeMove,
        2 => MoveCode::Slash,
        _ => panic!("unexpected move code: {code_int}"),
    };

    if move_code == MoveCode::MakeMove {
        assert!(items.len() >= 4, "MAKE_MOVE output too short");
        let hash_bytes = allocator.allocator().atom(items[1]);
        let next_validator_hash = if hash_bytes.is_empty() {
            None
        } else {
            let mut h = [0u8; 32];
            h.copy_from_slice(hash_bytes.as_ref());
            Some(h)
        };
        let max_move_size = int_from_atom(allocator, items[3]);
        MoveResult {
            move_code,
            next_validator_hash,
            state: items[2],
            next_max_move_size: max_move_size,
        }
    } else {
        MoveResult {
            move_code,
            next_validator_hash: None,
            state: NodePtr::NIL,
            next_max_move_size: 0,
        }
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
    // Build as nested pairs to avoid exceeding tuple ToClvm limit:
    // (nil waiter_ph nil amount nil nil move max_move_size nil mover_share nil)
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
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap(); // output_conditions
    let tail = a.new_pair(evidence_node, tail).unwrap();
    let tail = a.new_pair(validator_program, tail).unwrap();
    let tail = a.new_pair(previous_state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    a.new_pair(vh_node, tail).unwrap()
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
        eprintln!("HASH MISMATCH: looking for {}", hex::encode(vh));
        for (k, v) in &lib.by_hash {
            eprintln!("  library has {} => {}", hex::encode(k), v.name);
        }
        panic!("validator hash not found in library");
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
    MoveResult {
        move_code: MoveCode::MakeMove,
        next_validator_hash: Some(lib.hashes[0]),
        state: NodePtr::NIL,
        next_max_move_size: 32,
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

struct TestData {
    seed: GameSeed,
    first_move: Vec<u8>,
    good_c_move: Vec<u8>,
    alice_discards_salt: Vec<u8>,
    alice_discards_byte: Vec<u8>,
    bob_discards_byte: Vec<u8>,
    alice_good_selections: Vec<u8>,
    alice_loss_selections: Vec<u8>,
    bob_good_selections: Vec<u8>,
    bob_loss_selections: Vec<u8>,
}

fn build_test_data() -> TestData {
    let seed = GameSeed::new(1027);
    let first_move = sha256_bytes(&seed.alice_seed).to_vec();
    let alice_discards_byte = bitfield_to_byte(&[1, 3, 4, 7]);
    let bob_discards_byte = bitfield_to_byte(&[0, 2, 4, 6]);
    let alice_good_selections = bitfield_to_byte(&[3, 4, 5, 6, 7]);
    let alice_loss_selections = bitfield_to_byte(&[0, 1, 2, 3, 4]);
    let bob_good_selections = bitfield_to_byte(&[2, 3, 5, 6, 7]);
    let bob_loss_selections = bitfield_to_byte(&[0, 1, 2, 3, 4]);
    let alice_discards_salt = seed.seed[..16].to_vec();
    let good_c_move = {
        let discard_commit = sha256_concat(&[&alice_discards_salt, &alice_discards_byte]);
        let mut v = seed.alice_seed.clone();
        v.extend_from_slice(&discard_commit);
        v
    };
    TestData {
        seed,
        first_move,
        good_c_move,
        alice_discards_salt,
        alice_discards_byte,
        bob_discards_byte,
        alice_good_selections,
        alice_loss_selections,
        bob_good_selections,
        bob_loss_selections,
    }
}

fn happy_path_through_d(td: &TestData) -> Vec<StepSpec> {
    vec![
        make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
        make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
        make_step(&td.good_c_move, 0, None, MoveCode::MakeMove, false, "c"),
        make_step(
            &td.bob_discards_byte,
            0,
            None,
            MoveCode::MakeMove,
            false,
            "d",
        ),
    ]
}

fn e_move(td: &TestData) -> Vec<u8> {
    let mut v = td.alice_discards_salt.clone();
    v.extend_from_slice(&td.alice_discards_byte);
    v.extend_from_slice(&td.alice_good_selections);
    v
}

// ─── Tests ───────────────────────────────────────────────────────────────────

fn test_calpoker_validator_hashes() {
    let mut allocator = AllocEncoder::new();
    let lib = load_validators(&mut allocator);
    assert_eq!(lib.hashes.len(), 5);
    for (i, name) in VALIDATOR_NAMES.iter().enumerate() {
        let info = lib.by_hash.get(&lib.hashes[i]).unwrap();
        assert_eq!(info.name, *name);
    }
}

fn test_calpoker_a_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&td.first_move[1..], 0, None, MoveCode::Slash, false, "a"),
    );
}

fn test_calpoker_a_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let mut long = td.first_move.clone();
    long.push(b'b');
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(&long, 0, None, MoveCode::Slash, false, "a"),
    );
}

fn test_calpoker_b_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[make_step(
            &td.first_move,
            0,
            None,
            MoveCode::MakeMove,
            false,
            "a",
        )],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&td.seed.bob_seed[1..], 0, None, MoveCode::Slash, false, "b"),
    );
}

fn test_calpoker_b_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[make_step(
            &td.first_move,
            0,
            None,
            MoveCode::MakeMove,
            false,
            "a",
        )],
    )
    .unwrap();
    let mut long = td.seed.bob_seed.clone();
    long.push(b'a');
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&long, 0, None, MoveCode::Slash, false, "b"),
    );
}

fn test_calpoker_c_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
        ],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&td.good_c_move[1..], 0, None, MoveCode::Slash, false, "c"),
    );
}

fn test_calpoker_c_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
        ],
    )
    .unwrap();
    let mut long = td.good_c_move.clone();
    long.push(b'b');
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&long, 0, None, MoveCode::Slash, false, "c"),
    );
}

fn test_calpoker_c_slash_bad_alice_reveal() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
        ],
    )
    .unwrap();
    let bad_seed = b"0000000000000000";
    let commit = sha256_concat(&[&td.alice_discards_salt, &td.alice_discards_byte]);
    let mut bad = bad_seed.to_vec();
    bad.extend_from_slice(&commit);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&bad, 0, None, MoveCode::Slash, false, "c"),
    );
}

fn test_calpoker_d_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
            make_step(&td.good_c_move, 0, None, MoveCode::MakeMove, false, "c"),
        ],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&[], 0, None, MoveCode::Slash, false, "d"),
    );
}

fn test_calpoker_d_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
            make_step(&td.good_c_move, 0, None, MoveCode::MakeMove, false, "c"),
        ],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(b"ab", 0, None, MoveCode::Slash, false, "d"),
    );
}

fn test_calpoker_d_slash_too_few_bits() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
            make_step(&td.good_c_move, 0, None, MoveCode::MakeMove, false, "c"),
        ],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&[0b00000111], 0, None, MoveCode::Slash, false, "d"),
    );
}

fn test_calpoker_d_slash_too_many_bits() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(
        &mut a,
        &lib,
        &init,
        &[
            make_step(&td.first_move, 0, None, MoveCode::MakeMove, false, "a"),
            make_step(&td.seed.bob_seed, 0, None, MoveCode::MakeMove, false, "b"),
            make_step(&td.good_c_move, 0, None, MoveCode::MakeMove, false, "c"),
        ],
    )
    .unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&[0b00011111], 0, None, MoveCode::Slash, false, "d"),
    );
}

fn test_calpoker_e_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let em = e_move(&td);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &em[1..],
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut em = e_move(&td);
    em.push(b'a');
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &em,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_bad_reveal() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut bad = td.alice_discards_salt.clone();
    bad.extend_from_slice(&td.alice_discards_byte);
    bad.push(0x00);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &bad,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_too_few_discards() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut bad = td.alice_discards_salt.clone();
    bad.push(0b00000111);
    bad.extend_from_slice(&td.alice_good_selections);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &bad,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_too_many_discards() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut bad = td.alice_discards_salt.clone();
    bad.push(0b00111111);
    bad.extend_from_slice(&td.alice_good_selections);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &bad,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_too_few_selections() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut bad = td.alice_discards_salt.clone();
    bad.extend_from_slice(&td.alice_discards_byte);
    bad.push(0b00001111);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &bad,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_slash_too_many_selections() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut bad = td.alice_discards_salt.clone();
    bad.extend_from_slice(&td.alice_discards_byte);
    bad.push(0b00111111);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &bad,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_happy_path() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let mut steps = happy_path_through_d(&td);
    steps.push(make_step(
        &e_move(&td),
        100,
        Some(&td.bob_good_selections),
        MoveCode::MakeMove,
        false,
        "e",
    ));
    assert!(
        run_sequence(&mut a, &lib, &init, &steps).is_some(),
        "happy path should complete"
    );
}

fn test_calpoker_e_mover_share_zero_slash() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &e_move(&td),
            0,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_alice_loss_slash() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut m = td.alice_discards_salt.clone();
    m.extend_from_slice(&td.alice_discards_byte);
    m.extend_from_slice(&td.alice_loss_selections);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &m,
            0,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_alice_loss_mover_share_100_slash() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut m = td.alice_discards_salt.clone();
    m.extend_from_slice(&td.alice_discards_byte);
    m.extend_from_slice(&td.alice_loss_selections);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &m,
            100,
            Some(&td.bob_good_selections),
            MoveCode::Slash,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_bob_loss_make_move() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &e_move(&td),
            100,
            Some(&td.bob_loss_selections),
            MoveCode::MakeMove,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_bob_loss_zero_make_move() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(
            &e_move(&td),
            0,
            Some(&td.bob_loss_selections),
            MoveCode::MakeMove,
            false,
            "e",
        ),
    );
}

fn test_calpoker_e_nil_evidence_offchain() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&e_move(&td), 100, None, MoveCode::MakeMove, false, "e"),
    );
}

fn test_calpoker_e_nil_evidence_onchain_exception() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&e_move(&td), 100, None, MoveCode::ClvmException, true, "e"),
    );
}

fn test_calpoker_e_bad_evidence_exception() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let td = build_test_data();
    let init = initial_move_result(&lib);
    let after = run_sequence(&mut a, &lib, &init, &happy_path_through_d(&td)).unwrap();
    let mut m = td.alice_discards_salt.clone();
    m.extend_from_slice(&td.alice_discards_byte);
    m.extend_from_slice(&td.alice_loss_selections);
    run_step_and_check(
        &mut a,
        &lib,
        &after,
        &make_step(&m, 100, Some(&[0xFF]), MoveCode::ClvmException, false, "e"),
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        (
            "test_calpoker_validator_hashes",
            &test_calpoker_validator_hashes,
        ),
        (
            "test_calpoker_a_slash_too_short",
            &test_calpoker_a_slash_too_short,
        ),
        (
            "test_calpoker_a_slash_too_long",
            &test_calpoker_a_slash_too_long,
        ),
        (
            "test_calpoker_b_slash_too_short",
            &test_calpoker_b_slash_too_short,
        ),
        (
            "test_calpoker_b_slash_too_long",
            &test_calpoker_b_slash_too_long,
        ),
        (
            "test_calpoker_c_slash_too_short",
            &test_calpoker_c_slash_too_short,
        ),
        (
            "test_calpoker_c_slash_too_long",
            &test_calpoker_c_slash_too_long,
        ),
        (
            "test_calpoker_c_slash_bad_alice_reveal",
            &test_calpoker_c_slash_bad_alice_reveal,
        ),
        (
            "test_calpoker_d_slash_too_short",
            &test_calpoker_d_slash_too_short,
        ),
        (
            "test_calpoker_d_slash_too_long",
            &test_calpoker_d_slash_too_long,
        ),
        (
            "test_calpoker_d_slash_too_few_bits",
            &test_calpoker_d_slash_too_few_bits,
        ),
        (
            "test_calpoker_d_slash_too_many_bits",
            &test_calpoker_d_slash_too_many_bits,
        ),
        (
            "test_calpoker_e_slash_too_short",
            &test_calpoker_e_slash_too_short,
        ),
        (
            "test_calpoker_e_slash_too_long",
            &test_calpoker_e_slash_too_long,
        ),
        (
            "test_calpoker_e_slash_bad_reveal",
            &test_calpoker_e_slash_bad_reveal,
        ),
        (
            "test_calpoker_e_slash_too_few_discards",
            &test_calpoker_e_slash_too_few_discards,
        ),
        (
            "test_calpoker_e_slash_too_many_discards",
            &test_calpoker_e_slash_too_many_discards,
        ),
        (
            "test_calpoker_e_slash_too_few_selections",
            &test_calpoker_e_slash_too_few_selections,
        ),
        (
            "test_calpoker_e_slash_too_many_selections",
            &test_calpoker_e_slash_too_many_selections,
        ),
        ("test_calpoker_happy_path", &test_calpoker_happy_path),
        (
            "test_calpoker_e_mover_share_zero_slash",
            &test_calpoker_e_mover_share_zero_slash,
        ),
        (
            "test_calpoker_e_alice_loss_slash",
            &test_calpoker_e_alice_loss_slash,
        ),
        (
            "test_calpoker_e_alice_loss_mover_share_100_slash",
            &test_calpoker_e_alice_loss_mover_share_100_slash,
        ),
        (
            "test_calpoker_e_bob_loss_make_move",
            &test_calpoker_e_bob_loss_make_move,
        ),
        (
            "test_calpoker_e_bob_loss_zero_make_move",
            &test_calpoker_e_bob_loss_zero_make_move,
        ),
        (
            "test_calpoker_e_nil_evidence_offchain",
            &test_calpoker_e_nil_evidence_offchain,
        ),
        (
            "test_calpoker_e_nil_evidence_onchain_exception",
            &test_calpoker_e_nil_evidence_onchain_exception,
        ),
        (
            "test_calpoker_e_bad_evidence_exception",
            &test_calpoker_e_bad_evidence_exception,
        ),
    ]
}
