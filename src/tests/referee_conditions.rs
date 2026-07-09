use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Program, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

const AMOUNT: i64 = 200;
const AGG_SIG_UNSAFE_CODE: i64 = 49;

fn sha256_concat(parts: &[&[u8]]) -> [u8; 32] {
    let inputs: Vec<Sha256Input> = parts.iter().map(|b| Sha256Input::Bytes(b)).collect();
    *Sha256Input::Array(inputs).hash().bytes()
}

fn list_from_nodes(allocator: &mut AllocEncoder, nodes: &[NodePtr]) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for node in nodes.iter().rev() {
        tail = allocator
            .allocator()
            .new_pair(*node, tail)
            .expect("should build list");
    }
    tail
}

fn hash_to_node(allocator: &mut AllocEncoder, hash: &[u8; 32]) -> NodePtr {
    allocator
        .allocator()
        .new_atom(hash.as_slice())
        .expect("should build hash atom")
}

fn load_referee_puzzle(allocator: &mut AllocEncoder) -> Puzzle {
    read_hex_puzzle(allocator, "clsp/referee/onchain/referee.hex")
        .expect("failed to load referee puzzle")
}

fn load_mock_validator(allocator: &mut AllocEncoder) -> Puzzle {
    read_hex_puzzle(allocator, "clsp/test/mock_validator.hex")
        .expect("failed to load mock validator")
}

fn shatree_of(allocator: &mut AllocEncoder, node: NodePtr) -> [u8; 32] {
    *Program::from_nodeptr(allocator, node)
        .expect("state program")
        .sha256tree(allocator)
        .hash()
        .bytes()
}

/// Run the referee slash path with the mock validator.
/// `validator_return` is what the mock validator will return (placed as previous_state).
/// `committed_infohash_b` and `committed_max_move_size` are what the referee has committed to.
fn run_referee_slash_with_mock(
    allocator: &mut AllocEncoder,
    validator_return: NodePtr,
    committed_infohash_b: &[u8; 32],
    committed_max_move_size: i64,
) -> Result<NodePtr, String> {
    let referee = load_referee_puzzle(allocator);
    let referee_clvm = referee.to_clvm(allocator).expect("referee to clvm");
    let referee_hash: [u8; 32] = *referee.sha256tree(allocator).hash().bytes();

    let mock_validator = load_mock_validator(allocator);
    let mock_validator_clvm = mock_validator
        .to_clvm(allocator)
        .expect("mock validator to clvm");
    let mock_validator_hash: [u8; 32] = *mock_validator.sha256tree(allocator).hash().bytes();

    // previous_state IS the validator_return value (mock just returns it)
    let previous_state = validator_return;
    let previous_state_hash = shatree_of(allocator, previous_state);
    let infohash_a = sha256_concat(&[&mock_validator_hash, &previous_state_hash]);

    let mover_pk = allocator
        .allocator()
        .new_atom(&[0x11; 48])
        .expect("mover pk");
    let waiter_pk = allocator
        .allocator()
        .new_atom(&[0x22; 48])
        .expect("waiter pk");
    let timeout = 10i64.to_clvm(allocator).expect("timeout");
    let amount = AMOUNT.to_clvm(allocator).expect("amount");
    let mod_hash = hash_to_node(allocator, &referee_hash);
    let nonce = 1i64.to_clvm(allocator).expect("nonce");
    let move_node = allocator.allocator().new_atom(&[0x44; 5]).expect("move");
    let max_move_size = committed_max_move_size.to_clvm(allocator).expect("mms");
    let infohash_b = hash_to_node(allocator, committed_infohash_b);
    let mover_share = 0i64.to_clvm(allocator).expect("mover_share");
    let infohash_a_node = hash_to_node(allocator, &infohash_a);

    let evidence = NodePtr::NIL;
    let payout_ph = allocator
        .allocator()
        .new_atom(&[0x33; 32])
        .expect("payout ph");

    let curried_args = list_from_nodes(
        allocator,
        &[
            mover_pk,
            waiter_pk,
            timeout,
            amount,
            mod_hash,
            nonce,
            move_node,
            max_move_size,
            infohash_b,
            mover_share,
            infohash_a_node,
        ],
    );
    let slash_args = list_from_nodes(
        allocator,
        &[previous_state, mock_validator_clvm, evidence, payout_ph],
    );
    let args = allocator
        .allocator()
        .new_pair(curried_args, slash_args)
        .expect("build referee args");

    match run_program(
        allocator.allocator(),
        &chia_dialect(),
        referee_clvm,
        args,
        0,
    ) {
        Ok(reduction) => Ok(reduction.1),
        Err(e) => Err(format!("CLVM error: {e:?}")),
    }
}

/// Validator returns nil → unconditional slash, output = payout_conditions only
#[test]
fn test_slash_succeeds_nil() {
    let mut allocator = AllocEncoder::new();
    let result = run_referee_slash_with_mock(&mut allocator, NodePtr::NIL, &[0x00; 32], 5);
    let output = result.expect("slash with nil validator_result should succeed");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    assert_eq!(items.len(), 2, "should have 2 payout conditions");
}

/// Validator returns (wrong_vh state mms) — values misaligned → unconditional slash
#[test]
fn test_slash_succeeds_misaligned_no_conditions() {
    let mut allocator = AllocEncoder::new();

    let wrong_vh = allocator
        .allocator()
        .new_atom(&[0xAA; 32])
        .expect("wrong vh");
    let state = allocator.allocator().new_atom(&[0xBB; 8]).expect("state");
    let mms = 5i64.to_clvm(&mut allocator).expect("mms");
    let validator_return = list_from_nodes(&mut allocator, &[wrong_vh, state, mms]);

    // committed_infohash_b won't match sha256(wrong_vh, shatree(state))
    let result = run_referee_slash_with_mock(&mut allocator, validator_return, &[0xFF; 32], 5);
    let output = result.expect("slash with misaligned values should succeed");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    assert_eq!(items.len(), 2, "should have 2 payout conditions (no extra)");
}

/// Validator returns (correct_vh state mms (AGG_SIG_UNSAFE key msg)) — aligned with conditions → conditional slash
#[test]
fn test_slash_succeeds_aligned_with_conditions() {
    let mut allocator = AllocEncoder::new();

    // Build a state and compute the correct infohash_b
    let next_vh = allocator
        .allocator()
        .new_atom(&[0xCC; 32])
        .expect("next vh");
    let new_state = allocator
        .allocator()
        .new_atom(&[0xDD; 8])
        .expect("new state");
    let mms = 5i64.to_clvm(&mut allocator).expect("mms");

    let new_state_hash = shatree_of(&mut allocator, new_state);
    let next_vh_bytes: [u8; 32] = [0xCC; 32];
    let infohash_b = sha256_concat(&[&next_vh_bytes, &new_state_hash]);

    // Build an extra condition: (AGG_SIG_UNSAFE pubkey msg)
    let agg_sig_code = AGG_SIG_UNSAFE_CODE.to_clvm(&mut allocator).expect("code");
    let pubkey = allocator.allocator().new_atom(&[0xEE; 48]).expect("pubkey");
    let msg = allocator
        .allocator()
        .new_atom(b"test_evidence")
        .expect("msg");
    let condition = list_from_nodes(&mut allocator, &[agg_sig_code, pubkey, msg]);

    // validator_return = (next_vh new_state mms condition)
    // This is a 4-element list where element 4+ is extra_conditions
    let validator_return = {
        let a = allocator.allocator();
        let tail = a.new_pair(condition, NodePtr::NIL).unwrap();
        let tail = a.new_pair(mms, tail).unwrap();
        let tail = a.new_pair(new_state, tail).unwrap();
        a.new_pair(next_vh, tail).unwrap()
    };

    let result = run_referee_slash_with_mock(&mut allocator, validator_return, &infohash_b, 5);
    let output = result.expect("conditional slash should succeed");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    // extra_conditions is ((AGG_SIG_UNSAFE ...)), appended to payout_conditions (2 items)
    // Result: ((AGG_SIG_UNSAFE ...) (CREATE_COIN ...) (AGG_SIG_UNSAFE ...))
    assert_eq!(
        items.len(),
        3,
        "should have 1 extra condition + 2 payout conditions"
    );
}

/// Validator returns (correct_vh state mms) — aligned, no conditions → move valid, slash fails
#[test]
fn test_slash_fails_aligned_no_conditions() {
    let mut allocator = AllocEncoder::new();

    let next_vh = allocator
        .allocator()
        .new_atom(&[0xCC; 32])
        .expect("next vh");
    let new_state = allocator
        .allocator()
        .new_atom(&[0xDD; 8])
        .expect("new state");
    let mms = 5i64.to_clvm(&mut allocator).expect("mms");

    let new_state_hash = shatree_of(&mut allocator, new_state);
    let next_vh_bytes: [u8; 32] = [0xCC; 32];
    let infohash_b = sha256_concat(&[&next_vh_bytes, &new_state_hash]);

    // validator_return = (next_vh new_state mms) — only 3 elements, no extra_conditions
    let validator_return = list_from_nodes(&mut allocator, &[next_vh, new_state, mms]);

    let result = run_referee_slash_with_mock(&mut allocator, validator_return, &infohash_b, 5);
    assert!(
        result.is_err(),
        "slash should fail when move is valid (aligned, no conditions)"
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_slash_succeeds_nil", &test_slash_succeeds_nil),
        (
            "test_slash_succeeds_misaligned_no_conditions",
            &test_slash_succeeds_misaligned_no_conditions,
        ),
        (
            "test_slash_succeeds_aligned_with_conditions",
            &test_slash_succeeds_aligned_with_conditions,
        ),
        (
            "test_slash_fails_aligned_no_conditions",
            &test_slash_fails_aligned_no_conditions,
        ),
    ]
}
