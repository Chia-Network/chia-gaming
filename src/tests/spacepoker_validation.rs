use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const VALIDATOR_NAMES: [&str; 5] = ["commitA", "commitB", "begin_round", "mid_round", "end"];
const AMOUNT: i64 = 200;
const BET_UNIT: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
    #[allow(dead_code)]
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

// Replicates the CLVM coin toss in begin_round.clsp:
// (= (> mover_image_N waiter_image_N) (logand (logxor mover_image_N waiter_image_N) 1))
// CLVM `>` is signed two's-complement integer comparison; we replicate it
// here by comparing as signed values.
fn compute_mover_opens(mover_i4: &[u8; 32], waiter_i4: &[u8; 32]) -> bool {
    let m_neg = mover_i4[0] & 0x80 != 0;
    let w_neg = waiter_i4[0] & 0x80 != 0;
    let greater = if m_neg != w_neg {
        !m_neg
    } else {
        mover_i4 > waiter_i4
    };
    let xor_bit = (mover_i4[31] ^ waiter_i4[31]) & 1 != 0;
    greater == xor_bit
}

// Find an arbitrary 32-byte value (suitable as a stand-in for bob_image_4 at
// the begin_round validator level, where no chain consistency is checked yet)
// such that the coin toss with the given mover image yields the desired
// outcome.
fn find_waiter_value_for_outcome(mover_i4: &[u8; 32], mover_opens: bool) -> [u8; 32] {
    for seed in 0u64..1_000_000 {
        let candidate = sha256_bytes(&seed.to_be_bytes());
        if compute_mover_opens(mover_i4, &candidate) == mover_opens {
            return candidate;
        }
    }
    panic!("could not find waiter value for mover_opens={mover_opens}");
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
        assert!(!items.is_empty(), "MAKE_MOVE output too short");
        let hash_bytes = allocator.allocator().atom(items[0]);
        let next_validator_hash = if hash_bytes.is_empty() {
            None
        } else {
            let mut h = [0u8; 32];
            h.copy_from_slice(hash_bytes.as_ref());
            Some(h)
        };
        let state = if items.len() > 1 {
            items[1]
        } else {
            NodePtr::NIL
        };
        let max_move_size = if items.len() > 2 {
            int_from_atom(allocator, items[2])
        } else {
            0
        };
        MoveResult {
            move_code: MoveCode::MakeMove,
            next_validator_hash,
            state,
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

#[allow(dead_code)]
fn initial_move_result(lib: &ValidatorLibrary) -> MoveResult {
    let bet_unit_bytes = BET_UNIT.to_be_bytes();
    let _trimmed = &bet_unit_bytes[bet_unit_bytes.iter().position(|&b| b != 0).unwrap_or(7)..];
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

#[allow(dead_code)]
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

fn make_end_state(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    half_pot: i64,
    mover_preimage: &[u8],
    waiter_preimage: &[u8],
) -> MoveResult {
    let mover_image = sha256_bytes(mover_preimage);
    let half_pot_node = half_pot.to_clvm(allocator).unwrap();
    let mover_image_node = allocator.allocator().new_atom(&mover_image).unwrap();
    let waiter_preimage_node = allocator.allocator().new_atom(waiter_preimage).unwrap();
    let a = allocator.allocator();
    let tail = a.new_pair(waiter_preimage_node, NodePtr::NIL).unwrap();
    let tail = a.new_pair(mover_image_node, tail).unwrap();
    let state = a.new_pair(half_pot_node, tail).unwrap();

    MoveResult {
        move_code: MoveCode::MakeMove,
        next_validator_hash: Some(lib.hashes[4]),
        state,
        next_max_move_size: 17,
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

fn test_spacepoker_commit_a_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let move_bytes = [0xAA_u8; 32];
    let result = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &move_bytes,
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
    );
    assert!(result.is_some(), "commitA happy path should succeed");
}

fn test_spacepoker_commit_a_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &[0xAA; 31],
            AMOUNT / 2,
            None,
            MoveCode::Slash,
            false,
            "commitA",
        ),
    );
}

fn test_spacepoker_commit_a_slash_too_long() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &[0xAA; 33],
            AMOUNT / 2,
            None,
            MoveCode::Slash,
            false,
            "commitA",
        ),
    );
}

fn test_spacepoker_commit_a_slash_wrong_mover_share() {
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

fn test_spacepoker_commit_b_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &[0xAA; 32],
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
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

fn test_spacepoker_commit_b_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &[0xAA; 32],
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
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

fn test_spacepoker_commit_b_slash_wrong_mover_share() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let init = make_initial(&mut a, &lib);
    let after_a = run_step_and_check(
        &mut a,
        &lib,
        &init,
        &make_step(
            &[0xAA; 32],
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
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

// Helper: drive the validator chain from initial state through commitA and
// commitB to a state ready for begin_round, with the given alice preimage
// and bob "image_4" stand-in.
fn drive_to_begin_round(
    a: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    alice_image_4: &[u8; 32],
    bob_image_4: &[u8; 32],
) -> MoveResult {
    let alice_image_5 = sha256_bytes(alice_image_4);
    let init = make_initial(a, lib);

    let after_a = run_step_and_check(
        a,
        lib,
        &init,
        &make_step(
            &alice_image_5,
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
    )
    .unwrap();
    run_step_and_check(
        a,
        lib,
        &after_a,
        &make_step(
            bob_image_4,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "commitB",
        ),
    )
    .unwrap()
}

fn test_spacepoker_begin_round_happy() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x11; 16]);
    // Pick a waiter value for which the coin toss says Alice opens.
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, true);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

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
        &make_step(
            &alice_image_5,
            AMOUNT / 2,
            None,
            MoveCode::MakeMove,
            false,
            "commitA",
        ),
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

// Coin toss says mover opens: open path with bare 32-byte move (check).
fn test_spacepoker_begin_round_coin_toss_mover_opens_check() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x22; 16]);
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, true);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

    let move_bytes = alice_image_4.to_vec(); // exactly 32 bytes -> check (raise=0)

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
    let r = result.expect("32-byte check should succeed when mover opens");
    let info = lib.by_hash.get(&r.next_validator_hash.unwrap()).unwrap();
    assert_eq!(info.name, "mid_round", "open transitions to mid_round");
}

// Coin toss says mover must pong: bare 32-byte move is accepted as pong,
// transitions back to begin_round with images swapped.
fn test_spacepoker_begin_round_coin_toss_pong() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x33; 16]);
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, false);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

    let move_bytes = alice_image_4.to_vec();

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
    let r = result.expect("pong should succeed when mover_opens=false");
    let info = lib.by_hash.get(&r.next_validator_hash.unwrap()).unwrap();
    assert_eq!(info.name, "begin_round", "pong loops back to begin_round");
}

// Coin toss says mover must pong, but mover tries to open by appending a
// raise amount. Must slash.
fn test_spacepoker_begin_round_coin_toss_slash_open_when_should_pong() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x44; 16]);
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, false);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

    let mut move_bytes = alice_image_4.to_vec();
    move_bytes.push(0); // raise=0 appended

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

// After a pong, the next begin_round has swapped images. The new mover
// must always open (the coin toss flips on swap). Verify the full
// pong-then-open sequence.
fn test_spacepoker_begin_round_pong_then_open() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x55; 16]);
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, false);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

    // Alice pongs (sends bare 32-byte image_4).
    let pong_move = alice_image_4.to_vec();
    let after_pong = run_step_and_check(
        &mut a,
        &lib,
        &after_b,
        &make_step(
            &pong_move,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "begin_round",
        ),
    )
    .expect("pong must succeed");

    // The new mover (Bob) opens. Bob reveals his image_4 again (which the
    // validator accepts because sha256(bob_image_4) matches the new
    // mover_image_Nplus1 that the pong transition put in state).
    let mut bob_open = bob_image_4.to_vec();
    bob_open.push(0); // raise 0

    let result = run_step_and_check(
        &mut a,
        &lib,
        &after_pong,
        &make_step(
            &bob_open,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "begin_round",
        ),
    );
    let r = result.expect("post-pong open should succeed");
    let info = lib.by_hash.get(&r.next_validator_hash.unwrap()).unwrap();
    assert_eq!(
        info.name, "mid_round",
        "post-pong open should transition to mid_round"
    );
}

// After a pong, the new mover cannot pong again - the coin toss has flipped
// so they must open. A bare 32-byte move from the new mover... wait, that
// is a check (raise=0), which is a valid open. So this test verifies that
// a bare 32-byte move after a pong is correctly interpreted as a check
// (not as another pong).
fn test_spacepoker_begin_round_pong_then_check_is_open() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let alice_image_4 = sha256_bytes(&[0x66; 16]);
    let bob_image_4 = find_waiter_value_for_outcome(&alice_image_4, false);
    let after_b = drive_to_begin_round(&mut a, &lib, &alice_image_4, &bob_image_4);

    let pong_move = alice_image_4.to_vec();
    let after_pong = run_step_and_check(
        &mut a,
        &lib,
        &after_b,
        &make_step(
            &pong_move,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "begin_round",
        ),
    )
    .expect("pong must succeed");

    // Bob sends bare 32 bytes (his image_4). Coin toss now says he opens,
    // so this should be interpreted as a check (open with raise=0), not as
    // another pong.
    let bob_check = bob_image_4.to_vec();
    let result = run_step_and_check(
        &mut a,
        &lib,
        &after_pong,
        &make_step(
            &bob_check,
            AMOUNT / 2 - BET_UNIT,
            None,
            MoveCode::MakeMove,
            false,
            "begin_round",
        ),
    );
    let r = result.expect("post-pong bare 32-byte move should succeed as check");
    let info = lib.by_hash.get(&r.next_validator_hash.unwrap()).unwrap();
    assert_eq!(
        info.name, "mid_round",
        "post-pong check should transition to mid_round"
    );
}

fn test_spacepoker_end_slash_too_short() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let mover_preimage = [0xA1; 16];
    let waiter_preimage = [0xB2; 16];
    let end_state = make_end_state(&mut a, &lib, BET_UNIT, &mover_preimage, &waiter_preimage);

    run_step_and_check(
        &mut a,
        &lib,
        &end_state,
        &make_step(
            &mover_preimage,
            AMOUNT / 2,
            None,
            MoveCode::Slash,
            false,
            "end",
        ),
    );
}

fn test_spacepoker_end_slash_bad_preimage() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let mover_preimage = [0xA1; 16];
    let waiter_preimage = [0xB2; 16];
    let end_state = make_end_state(&mut a, &lib, BET_UNIT, &mover_preimage, &waiter_preimage);

    let mut move_bytes = [0xC3; 16].to_vec();
    move_bytes.push(0x1F);

    run_step_and_check(
        &mut a,
        &lib,
        &end_state,
        &make_step(&move_bytes, AMOUNT / 2, None, MoveCode::Slash, false, "end"),
    );
}

fn test_spacepoker_end_slash_bad_selection_popcount() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let mover_preimage = [0xA1; 16];
    let waiter_preimage = [0xB2; 16];
    let end_state = make_end_state(&mut a, &lib, BET_UNIT, &mover_preimage, &waiter_preimage);

    let mut move_bytes = mover_preimage.to_vec();
    move_bytes.push(0x0F);

    run_step_and_check(
        &mut a,
        &lib,
        &end_state,
        &make_step(&move_bytes, AMOUNT / 2, None, MoveCode::Slash, false, "end"),
    );
}

fn test_spacepoker_end_valid_move_nil_evidence_exception() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let mover_preimage = [0xA1; 16];
    let waiter_preimage = [0xB2; 16];
    let end_state = make_end_state(&mut a, &lib, BET_UNIT, &mover_preimage, &waiter_preimage);

    let mut move_bytes = mover_preimage.to_vec();
    move_bytes.push(0x1F);

    run_step_and_check(
        &mut a,
        &lib,
        &end_state,
        &make_step(
            &move_bytes,
            AMOUNT / 2,
            None,
            MoveCode::ClvmException,
            false,
            "end",
        ),
    );
}

fn test_spacepoker_end_valid_move_bad_evidence_exception() {
    let mut a = AllocEncoder::new();
    let lib = load_validators(&mut a);
    let mover_preimage = [0xA1; 16];
    let waiter_preimage = [0xB2; 16];
    let end_state = make_end_state(&mut a, &lib, BET_UNIT, &mover_preimage, &waiter_preimage);

    let mut move_bytes = mover_preimage.to_vec();
    move_bytes.push(0x1F);

    run_step_and_check(
        &mut a,
        &lib,
        &end_state,
        &make_step(
            &move_bytes,
            AMOUNT / 2,
            Some(&[0x0F]),
            MoveCode::ClvmException,
            false,
            "end",
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
            "test_spacepoker_commit_a_happy",
            &test_spacepoker_commit_a_happy,
        ),
        (
            "test_spacepoker_commit_a_slash_too_short",
            &test_spacepoker_commit_a_slash_too_short,
        ),
        (
            "test_spacepoker_commit_a_slash_too_long",
            &test_spacepoker_commit_a_slash_too_long,
        ),
        (
            "test_spacepoker_commit_a_slash_wrong_mover_share",
            &test_spacepoker_commit_a_slash_wrong_mover_share,
        ),
        (
            "test_spacepoker_commit_b_happy",
            &test_spacepoker_commit_b_happy,
        ),
        (
            "test_spacepoker_commit_b_slash_too_short",
            &test_spacepoker_commit_b_slash_too_short,
        ),
        (
            "test_spacepoker_commit_b_slash_wrong_mover_share",
            &test_spacepoker_commit_b_slash_wrong_mover_share,
        ),
        (
            "test_spacepoker_begin_round_happy",
            &test_spacepoker_begin_round_happy,
        ),
        (
            "test_spacepoker_begin_round_slash_bad_image",
            &test_spacepoker_begin_round_slash_bad_image,
        ),
        (
            "test_spacepoker_begin_round_coin_toss_mover_opens_check",
            &test_spacepoker_begin_round_coin_toss_mover_opens_check,
        ),
        (
            "test_spacepoker_begin_round_coin_toss_pong",
            &test_spacepoker_begin_round_coin_toss_pong,
        ),
        (
            "test_spacepoker_begin_round_coin_toss_slash_open_when_should_pong",
            &test_spacepoker_begin_round_coin_toss_slash_open_when_should_pong,
        ),
        (
            "test_spacepoker_begin_round_pong_then_open",
            &test_spacepoker_begin_round_pong_then_open,
        ),
        (
            "test_spacepoker_begin_round_pong_then_check_is_open",
            &test_spacepoker_begin_round_pong_then_check_is_open,
        ),
        (
            "test_spacepoker_end_slash_too_short",
            &test_spacepoker_end_slash_too_short,
        ),
        (
            "test_spacepoker_end_slash_bad_preimage",
            &test_spacepoker_end_slash_bad_preimage,
        ),
        (
            "test_spacepoker_end_slash_bad_selection_popcount",
            &test_spacepoker_end_slash_bad_selection_popcount,
        ),
        (
            "test_spacepoker_end_valid_move_nil_evidence_exception",
            &test_spacepoker_end_valid_move_nil_evidence_exception,
        ),
        (
            "test_spacepoker_end_valid_move_bad_evidence_exception",
            &test_spacepoker_end_valid_move_bad_evidence_exception,
        ),
    ]
}
