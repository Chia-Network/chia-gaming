use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Program, Puzzle, Sha256Input, Sha256tree};
use crate::referee::types::{parse_validator_result, ParsedRefereeSolution};
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
    committed_infohash_b: Option<&[u8; 32]>,
    committed_max_move_size: &[u8],
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
    let max_move_size = allocator
        .allocator()
        .new_atom(committed_max_move_size)
        .expect("mms");
    let infohash_b = committed_infohash_b
        .map(|hash| hash_to_node(allocator, hash))
        .unwrap_or(NodePtr::NIL);
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

fn run_referee_move_with_max_size(new_max_move_size: &[u8]) -> Result<NodePtr, String> {
    let mut allocator = AllocEncoder::new();
    let referee = load_referee_puzzle(&mut allocator);
    let referee_clvm = referee.to_clvm(&mut allocator).expect("referee to clvm");
    let referee_hash: [u8; 32] = *referee.sha256tree(&mut allocator).hash().bytes();

    let mover_pk = allocator.allocator().new_atom(&[0x11; 48]).unwrap();
    let waiter_pk = allocator.allocator().new_atom(&[0x22; 48]).unwrap();
    let timeout = 10i64.to_clvm(&mut allocator).unwrap();
    let amount = AMOUNT.to_clvm(&mut allocator).unwrap();
    let mod_hash = hash_to_node(&mut allocator, &referee_hash);
    let nonce = 1i64.to_clvm(&mut allocator).unwrap();
    let previous_move = allocator.allocator().new_atom(&[0x44]).unwrap();
    let previous_max_move_size = 5i64.to_clvm(&mut allocator).unwrap();
    let previous_infohash = allocator.allocator().new_atom(&[0x55; 32]).unwrap();
    let previous_mover_share = 0i64.to_clvm(&mut allocator).unwrap();
    let previous_validation_info = allocator.allocator().new_atom(&[0x66; 32]).unwrap();
    let curried_args = list_from_nodes(
        &mut allocator,
        &[
            mover_pk,
            waiter_pk,
            timeout,
            amount,
            mod_hash,
            nonce,
            previous_move,
            previous_max_move_size,
            previous_infohash,
            previous_mover_share,
            previous_validation_info,
        ],
    );

    let new_move = allocator.allocator().new_atom(&[0x77]).unwrap();
    let new_infohash = allocator.allocator().new_atom(&[0x88; 32]).unwrap();
    let new_mover_share = 0i64.to_clvm(&mut allocator).unwrap();
    let new_max_move_size = allocator
        .allocator()
        .new_atom(new_max_move_size)
        .expect("new max move size");
    let move_args = list_from_nodes(
        &mut allocator,
        &[new_move, new_infohash, new_mover_share, new_max_move_size],
    );
    let args = allocator
        .allocator()
        .new_pair(curried_args, move_args)
        .expect("build referee args");

    match run_program(
        allocator.allocator(),
        &chia_dialect(),
        referee_clvm,
        args,
        0,
    ) {
        Ok(reduction) => Ok(reduction.1),
        Err(error) => Err(format!("CLVM error: {error:?}")),
    }
}

/// Validator returns nil → unconditional slash, output = payout_conditions only
#[test]
fn test_slash_succeeds_nil() {
    let mut allocator = AllocEncoder::new();
    let result = run_referee_slash_with_mock(&mut allocator, NodePtr::NIL, Some(&[0x00; 32]), &[5]);
    let output = result.expect("slash with nil validator_result should succeed");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    assert_eq!(items.len(), 2, "should have 2 payout conditions");
}

#[test]
fn test_negative_new_max_move_size_is_rejected() {
    assert!(
        run_referee_move_with_max_size(&[0xff]).is_err(),
        "canonical negative CLVM integers must not become max move sizes"
    );
    assert!(
        run_referee_move_with_max_size(&[0x00, 0xff]).is_ok(),
        "canonical positive max move sizes remain valid"
    );
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
    let result =
        run_referee_slash_with_mock(&mut allocator, validator_return, Some(&[0xFF; 32]), &[5]);
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

    let result =
        run_referee_slash_with_mock(&mut allocator, validator_return, Some(&infohash_b), &[5]);
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

    let result =
        run_referee_slash_with_mock(&mut allocator, validator_return, Some(&infohash_b), &[5]);
    assert!(
        result.is_err(),
        "slash should fail when move is valid (aligned, no conditions)"
    );
}

#[test]
fn test_noncanonical_committed_max_move_size_is_slashable() {
    let mut allocator = AllocEncoder::new();
    let next_vh = allocator
        .allocator()
        .new_atom(&[0xCC; 32])
        .expect("next validator hash");
    let new_state = allocator
        .allocator()
        .new_atom(b"next state")
        .expect("new state");
    let max_move_size = 5i64.to_clvm(&mut allocator).expect("max move size");
    let new_state_hash = shatree_of(&mut allocator, new_state);
    let infohash_b = sha256_concat(&[&[0xCC; 32], &new_state_hash]);
    let validator_return = list_from_nodes(&mut allocator, &[next_vh, new_state, max_move_size]);

    let result =
        run_referee_slash_with_mock(&mut allocator, validator_return, Some(&infohash_b), &[0, 5]);
    let output = result.expect("non-canonical committed max_move_size should authorize a slash");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    assert_eq!(items.len(), 2, "should have 2 payout conditions");
}

#[test]
fn test_terminal_validator_with_nonzero_max_move_size_is_slashable() {
    let mut allocator = AllocEncoder::new();
    let new_state = allocator
        .allocator()
        .new_atom(b"terminal state")
        .expect("new state");
    let max_move_size = 5i64.to_clvm(&mut allocator).expect("max move size");
    let validator_return =
        list_from_nodes(&mut allocator, &[NodePtr::NIL, new_state, max_move_size]);

    let result = run_referee_slash_with_mock(&mut allocator, validator_return, None, &[5]);
    let output = result.expect("nonzero terminal max_move_size should authorize a slash");
    let items = proper_list(allocator.allocator(), output, true).unwrap();
    assert_eq!(items.len(), 2, "should have 2 payout conditions");
}

#[test]
fn test_valid_validator_results_are_not_slash_candidates() {
    let mut allocator = AllocEncoder::new();
    let terminal = list_from_nodes(&mut allocator, &[NodePtr::NIL]);
    let terminal_parsed = parse_validator_result(&mut allocator, terminal).unwrap();
    assert!(
        terminal_parsed.new_state.is_some(),
        "an ordinary terminal result must not initiate a slash"
    );
    assert!(
        terminal_parsed.next_validator_hash.is_none(),
        "a nil next-validator hash means a nil infohash"
    );

    let next_hash = allocator.allocator().new_atom(&[0x44; 32]).unwrap();
    let state = allocator.allocator().new_atom(b"next state").unwrap();
    let without_max_move_size = list_from_nodes(&mut allocator, &[next_hash, state]);
    let error = match parse_validator_result(&mut allocator, without_max_move_size) {
        Ok(_) => panic!("a two-element result omits a required transition field"),
        Err(error) => error,
    };
    assert!(
        error
            .to_string()
            .contains("validator returned 2 elements; expected 1 (terminal) or at least 3"),
        "unexpected parser error: {error}"
    );

    let max_move_size = 5_i64.to_clvm(&mut allocator).unwrap();
    let nonterminal = list_from_nodes(&mut allocator, &[next_hash, state, max_move_size]);
    let nonterminal_parsed = parse_validator_result(&mut allocator, nonterminal).unwrap();
    assert!(
        nonterminal_parsed.new_state.is_some(),
        "an ordinary three-element transition must not initiate a slash"
    );
    assert_eq!(
        nonterminal_parsed.next_validator_hash.map(|h| h.0),
        Some([0x44; 32])
    );

    // Extra elements past the three-element transition are referee extra
    // conditions. parse_validator_result still reports a payload so the
    // caller can compute the next infohash before invoking the referee.
    let diagnostic = allocator.allocator().new_atom(b"debug game: move").unwrap();
    let with_tail = list_from_nodes(
        &mut allocator,
        &[next_hash, state, max_move_size, diagnostic],
    );
    assert!(
        parse_validator_result(&mut allocator, with_tail)
            .unwrap()
            .new_state
            .is_some(),
        "a valid result with extra fields still yields a transition payload"
    );
}

#[test]
fn test_referee_solution_parser_matches_puzzle_tail_rules() {
    let mut allocator = AllocEncoder::new();
    let state = allocator.allocator().new_atom(b"state").unwrap();
    let validation_program = allocator
        .allocator()
        .new_pair(NodePtr::NIL, NodePtr::NIL)
        .unwrap();
    let unexamined_tail = allocator.allocator().new_atom(b"tail").unwrap();
    let program_and_rest = allocator
        .allocator()
        .new_pair(validation_program, unexamined_tail)
        .unwrap();
    let slash_node = allocator
        .allocator()
        .new_pair(state, program_and_rest)
        .unwrap();
    let slash_solution = Program::from_nodeptr(&mut allocator, slash_node).unwrap();

    assert!(
        matches!(
            ParsedRefereeSolution::parse(&mut allocator, &slash_solution),
            Ok(ParsedRefereeSolution::Slash)
        ),
        "slash classification must not traverse the untrusted argument tail"
    );

    let move_field = allocator.allocator().new_atom(b"move").unwrap();
    let infohash = allocator.allocator().new_atom(&[0x66; 32]).unwrap();
    let mover_share = 5_i64.to_clvm(&mut allocator).unwrap();
    let max_move_size = 10_i64.to_clvm(&mut allocator).unwrap();
    let extra = allocator.allocator().new_atom(b"extra").unwrap();
    let move_with_tail = list_from_nodes(
        &mut allocator,
        &[move_field, infohash, mover_share, max_move_size, extra],
    );
    let move_solution = Program::from_nodeptr(&mut allocator, move_with_tail).unwrap();

    assert!(
        ParsedRefereeSolution::parse(&mut allocator, &move_solution).is_err(),
        "the referee move branch rejects a trailing tail"
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_slash_succeeds_nil", &test_slash_succeeds_nil),
        (
            "test_negative_new_max_move_size_is_rejected",
            &test_negative_new_max_move_size_is_rejected,
        ),
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
        (
            "test_noncanonical_committed_max_move_size_is_slashable",
            &test_noncanonical_committed_max_move_size_is_slashable,
        ),
        (
            "test_terminal_validator_with_nonzero_max_move_size_is_slashable",
            &test_terminal_validator_with_nonzero_max_move_size_is_slashable,
        ),
        (
            "test_valid_validator_results_are_not_slash_candidates",
            &test_valid_validator_results_are_not_slash_candidates,
        ),
        (
            "test_referee_solution_parser_matches_puzzle_tail_rules",
            &test_referee_solution_parser_matches_puzzle_tail_rules,
        ),
    ]
}
