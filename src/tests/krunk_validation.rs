use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const AMOUNT: i64 = 200;
const BASE_UNIT: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
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
        _ => panic!("expected atom"),
    }
}

fn build_curry_args(
    allocator: &mut AllocEncoder,
    move_node: NodePtr,
    max_move_size: i64,
    mover_share: i64,
) -> NodePtr {
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
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    a.new_pair(NodePtr::NIL, tail).unwrap()
}

fn run_validator_step(
    allocator: &mut AllocEncoder,
    puzzle: &Puzzle,
    move_bytes: &[u8],
    max_move_size: i64,
    mover_share: i64,
    previous_state: NodePtr,
    evidence: NodePtr,
) -> Result<(MoveCode, NodePtr), String> {
    let validator_hash = puzzle.sha256tree(allocator);
    let vh_node = allocator
        .allocator()
        .new_atom(validator_hash.hash().bytes())
        .unwrap();
    let move_node = allocator.allocator().new_atom(move_bytes).unwrap();
    let program_clvm = puzzle.to_clvm(allocator).unwrap();
    let curry_args = build_curry_args(allocator, move_node, max_move_size, mover_share);

    let a = allocator.allocator();
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(evidence, tail).unwrap();
    let tail = a.new_pair(program_clvm, tail).unwrap();
    let tail = a.new_pair(previous_state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    let args = a.new_pair(vh_node, tail).unwrap();

    match run_program(allocator.allocator(), &chia_dialect(), program_clvm, args, 0) {
        Ok(reduction) => {
            let result = reduction.1;
            let items = proper_list(allocator.allocator(), result, true).unwrap();
            if items.is_empty() {
                Ok((MoveCode::Slash, result))
            } else {
                Ok((MoveCode::MakeMove, result))
            }
        }
        Err(e) => Err(format!("CLVM error: {e:?}")),
    }
}

/// Build state: (dict_pubkey base_unit bob_guesses alice_clues alice_commit clue_hash)
fn make_state_after_commit(allocator: &mut AllocEncoder, dict_pubkey: NodePtr, commit: [u8; 32]) -> NodePtr {
    let base_unit_node = BASE_UNIT.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let commit_node = a.new_atom(&commit).unwrap();
    let dummy_clue_hash = a.new_atom(&[0xEE; 32]).unwrap();
    let tail = a.new_pair(dummy_clue_hash, NodePtr::NIL).unwrap();
    let tail = a.new_pair(commit_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(base_unit_node, tail).unwrap();
    a.new_pair(dict_pubkey, tail).unwrap()
}

/// Build state with guesses: (dict_pubkey base_unit bob_guesses alice_clues alice_commit clue_hash)
fn make_state_with_guesses(
    allocator: &mut AllocEncoder,
    dict_pubkey: NodePtr,
    bob_guesses: NodePtr,
    alice_clues: NodePtr,
    commit: [u8; 32],
) -> NodePtr {
    let base_unit_node = BASE_UNIT.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let commit_node = a.new_atom(&commit).unwrap();
    let dummy_clue_hash = a.new_atom(&[0xEE; 32]).unwrap();
    let tail = a.new_pair(dummy_clue_hash, NodePtr::NIL).unwrap();
    let tail = a.new_pair(commit_node, tail).unwrap();
    let tail = a.new_pair(alice_clues, tail).unwrap();
    let tail = a.new_pair(bob_guesses, tail).unwrap();
    let tail = a.new_pair(base_unit_node, tail).unwrap();
    a.new_pair(dict_pubkey, tail).unwrap()
}

fn make_dict_pubkey(allocator: &mut AllocEncoder) -> NodePtr {
    allocator.allocator().new_atom(&[0xAA; 48]).unwrap()
}

fn words_to_list(allocator: &mut AllocEncoder, words: &[&[u8; 5]]) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for word in words.iter().rev() {
        let w = allocator.allocator().new_atom(word.as_slice()).unwrap();
        tail = allocator.allocator().new_pair(w, tail).unwrap();
    }
    tail
}

// --- commit.clsp tests ---

fn test_krunk_commit_happy() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let base_unit_node = BASE_UNIT.to_clvm(&mut allocator).unwrap();
    let initial_state = {
        let a = allocator.allocator();
        let tail = a.new_pair(base_unit_node, NodePtr::NIL).unwrap();
        a.new_pair(dict_pubkey, tail).unwrap()
    };
    let move_bytes = [0xAB; 32];
    let (code, result) = run_validator_step(
        &mut allocator,
        &commit,
        &move_bytes,
        32,
        0,
        initial_state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, items[2]), 5);
}

fn test_krunk_commit_slash_bad_move_size() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let base_unit_node = BASE_UNIT.to_clvm(&mut allocator).unwrap();
    let initial_state = {
        let a = allocator.allocator();
        let tail = a.new_pair(base_unit_node, NodePtr::NIL).unwrap();
        a.new_pair(dict_pubkey, tail).unwrap()
    };
    let result = run_validator_step(
        &mut allocator,
        &commit,
        b"short",
        32,
        0,
        initial_state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash);
}

// --- guess.clsp tests ---

fn test_krunk_guess_happy() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);
    let (code, result) = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        0,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "valid guess returns 3 elements (no conditions)");
    assert_eq!(int_from_atom(&mut allocator, items[2]), 21);
}

fn test_krunk_guess_slash_bob_out_of_dict() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // 10-byte evidence: begin_range || end_range that brackets "xyzzy"
    // "xyzzy" as bytes = [0x78, 0x79, 0x7a, 0x7a, 0x79]
    // begin_range < "xyzzy" < end_range
    let begin_range = b"xyzzx"; // just below xyzzy
    let end_range = b"xyzzz"; // just above xyzzy
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(begin_range);
    evidence_bytes.extend_from_slice(end_range);
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let (code, result) = run_validator_step(
        &mut allocator,
        &guess,
        b"xyzzy",
        5,
        0,
        state,
        evidence,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 4, "slash with evidence returns 4 elements (vh state mms condition)");
    // 4th element should be the AGG_SIG_UNSAFE condition
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, condition[0]), 49, "AGG_SIG_UNSAFE code");
}

fn test_krunk_guess_bad_range_doesnt_bracket() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // Evidence range that does NOT bracket the move "crane"
    // begin = "death", end = "denom" — both > "crane", so crane < begin
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"death");
    evidence_bytes.extend_from_slice(b"denom");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        0,
        state,
        evidence,
    );
    assert!(result.is_err(), "should fail when evidence range doesn't bracket the move");
}

// --- clue.clsp tests ---

fn test_krunk_clue_nonterminal_happy() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // 1-byte clue move (any byte value for the encoded clue)
    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &[0x42],
        21,
        0,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "clue returns 3 elements");
    assert_eq!(int_from_atom(&mut allocator, items[2]), 5, "next max_move_size = 5 (guess)");
}

fn test_krunk_clue_blocks_5th_clue() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    // 4 clues already given (alice_clues has 4 elements)
    let bob_guesses = words_to_list(&mut allocator, &[b"crane", b"slate", b"mango", b"plumb", b"toast"]);
    let clue_a = allocator.allocator().new_atom(&[0x01]).unwrap();
    let clue_b = allocator.allocator().new_atom(&[0x02]).unwrap();
    let clue_c = allocator.allocator().new_atom(&[0x03]).unwrap();
    let clue_d = allocator.allocator().new_atom(&[0x04]).unwrap();
    let a = allocator.allocator();
    let alice_clues = {
        let t = a.new_pair(clue_d, NodePtr::NIL).unwrap();
        let t = a.new_pair(clue_c, t).unwrap();
        let t = a.new_pair(clue_b, t).unwrap();
        a.new_pair(clue_a, t).unwrap()
    };

    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        [0xCD; 32],
    );

    // Try giving a 5th clue — should fail (< 4 check fails)
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &[0x05],
        21,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "5th clue should be rejected (enforces reveal)");
}

fn test_krunk_reveal_slash_alice_out_of_dict() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // Alice reveals salt||word where word = "xyzzy" (not in dictionary)
    let salt = [0x11; 16];
    let word = b"xyzzy";
    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence brackets "xyzzy"
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"xyzzx");
    evidence_bytes.extend_from_slice(b"xyzzz");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 4, "reveal slash returns 4 elements (terminal + condition)");
    // Check the condition is AGG_SIG_UNSAFE
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, condition[0]), 49, "AGG_SIG_UNSAFE code");
}

fn test_krunk_reveal_bad_range_doesnt_bracket() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    let salt = [0x11; 16];
    let word = b"crane";
    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence that does NOT bracket "crane"
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"death");
    evidence_bytes.extend_from_slice(b"denom");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    );
    assert!(result.is_err(), "should fail when evidence range doesn't bracket the revealed word");
}

fn test_krunk_reveal_valid() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x22; 16];
    let commit = {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(&salt);
        hasher.update(word);
        let result = hasher.finalize();
        let mut h = [0u8; 32];
        h.copy_from_slice(&result);
        h
    };

    // Bob guessed "crane" as the latest guess (first in list)
    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    let mover_share = BASE_UNIT * 100; // depth 1: base_unit * 100 = 200
    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        mover_share,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "valid reveal returns terminal (0 0 0)");
    assert_eq!(int_from_atom(&mut allocator, items[0]), 0);
    assert_eq!(int_from_atom(&mut allocator, items[1]), 0);
    assert_eq!(int_from_atom(&mut allocator, items[2]), 0);
}

// --- New clue path tests ---

fn test_krunk_clue_all_correct_byte_rejected() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // 0x72 = "all correct" clue — should be rejected
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &[0x72],
        21,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "all-correct clue byte 0x72 should be rejected");
}

fn test_krunk_clue_above_range_rejected() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // 0x73 is above the valid range — should be rejected
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &[0x73],
        21,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "clue byte 0x73 (above valid range) should be rejected");
}

fn test_krunk_clue_nonzero_mover_share_rejected() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // Valid clue byte but nonzero mover_share
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &[0x42],
        21,
        50,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "clue with nonzero mover_share should be rejected");
}

// --- New guess path tests ---

fn test_krunk_guess_wrong_length_rejected() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // 4-byte guess (too short)
    let result = run_validator_step(
        &mut allocator,
        &guess,
        b"cran",
        5,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "4-byte guess should be rejected");

    // 6-byte guess (too long)
    let state2 = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);
    let result = run_validator_step(
        &mut allocator,
        &guess,
        b"cranes",
        5,
        0,
        state2,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "6-byte guess should be rejected");
}

fn test_krunk_guess_nonzero_mover_share_rejected() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // Valid 5-byte guess but nonzero mover_share
    let result = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        50,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "guess with nonzero mover_share should be rejected");
}

// --- Reveal path: mover_share mismatch tests ---

fn make_commit_for(salt: &[u8; 16], word: &[u8; 5]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(word);
    let result = hasher.finalize();
    let mut h = [0u8; 32];
    h.copy_from_slice(&result);
    h
}

fn test_krunk_reveal_claims_won_but_latest_guess_wrong() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"world";
    let salt = [0x33; 16];
    let commit = make_commit_for(&salt, word);

    // 5 guesses, none correct (latest = "crane")
    let bob_guesses = words_to_list(&mut allocator, &[b"crane", b"slate", b"trace", b"plumb", b"mango"]);
    let clue_a = allocator.allocator().new_atom(&[0x01]).unwrap();
    let a = allocator.allocator();
    let alice_clues = {
        let t = a.new_pair(clue_a, NodePtr::NIL).unwrap();
        let t = a.new_pair(clue_a, t).unwrap();
        let t = a.new_pair(clue_a, t).unwrap();
        a.new_pair(clue_a, t).unwrap()
    };
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Claims high mover_share (as if Bob guessed correctly) but latest guess is wrong
    // Expected: mover_share should be 0 (5 wrong guesses)
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        200,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "claiming high mover_share with wrong latest guess should fail");
}

fn test_krunk_reveal_claims_won_but_not_terminal() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"world";
    let salt = [0x44; 16];
    let commit = make_commit_for(&salt, word);

    // Only 2 guesses, latest guess is wrong (not "world")
    let bob_guesses = words_to_list(&mut allocator, &[b"crane", b"slate"]);
    let clue_a = allocator.allocator().new_atom(&[0x01]).unwrap();
    let a = allocator.allocator();
    let alice_clues = a.new_pair(clue_a, NodePtr::NIL).unwrap();
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Tries to reveal before terminal (latest guess wrong, only 2 guesses)
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err(), "reveal before terminal should raise");
}

fn test_krunk_reveal_wrong_mover_share_amount() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x55; 16];
    let commit = make_commit_for(&salt, word);

    // 4 guesses, correct at depth 4
    let bob_guesses = words_to_list(&mut allocator, &[b"crane", b"slate", b"trace", b"plumb"]);
    let clue_a = allocator.allocator().new_atom(&[0x01]).unwrap();
    let a = allocator.allocator();
    let alice_clues = {
        let t = a.new_pair(clue_a, NodePtr::NIL).unwrap();
        let t = a.new_pair(clue_a, t).unwrap();
        a.new_pair(clue_a, t).unwrap()
    };
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Correct mover_share for depth 4 is base_unit * 5 = 10, but claim 200
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        200,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "wrong mover_share amount should be rejected");
}

// --- Reveal path: commit mismatch ---

fn test_krunk_reveal_bad_commit() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x66; 16];
    let wrong_commit = [0xBB; 32]; // doesn't match sha256(salt||word)

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        wrong_commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        BASE_UNIT * 100,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "reveal with wrong commit should be rejected");
}

// --- Reveal path: evidence slash (wrong clue) ---

fn test_krunk_reveal_wrong_clue_slash() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x77; 16];
    let commit = make_commit_for(&salt, word);

    // State: 2 guesses. Bob's guesses are ["slate", "crane"] (latest first).
    // Alice gave clues for both. The clue for "slate" (at index 1) is wrong.
    // Correct clue for make_clue("crane", "slate") would be some value X.
    // We store 0x01 which is definitely wrong.
    let bob_guesses = words_to_list(&mut allocator, &[b"slate", b"crane"]);
    let wrong_clue = allocator.allocator().new_atom(&[0x01]).unwrap();
    let some_clue = allocator.allocator().new_atom(&[0x42]).unwrap();
    let a = allocator.allocator();
    // alice_clues[0] = some_clue (for latest guess "slate")
    // alice_clues[1] = wrong_clue (for earlier guess "crane")
    let alice_clues = {
        let t = a.new_pair(wrong_clue, NodePtr::NIL).unwrap();
        a.new_pair(some_clue, t).unwrap()
    };
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence = index 1 (second clue is wrong).
    // make_clue("crane", bob_guesses[1]) = make_clue("crane", "crane") = 0x72
    // alice_clues[1] = 0x01 ≠ 0x72 → slash succeeds
    let evidence = allocator.allocator().new_atom(&[0x01]).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    );
    match result {
        Ok((code, node)) => {
            let items = proper_list(allocator.allocator(), node, true).unwrap();
            assert!(items.is_empty() || code == MoveCode::Slash,
                "wrong clue evidence should produce unconditional slash (nil)");
        }
        Err(e) => panic!("wrong clue slash should succeed, got error: {e}"),
    }
}

fn test_krunk_reveal_correct_clue_no_slash() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x88; 16];
    let commit = make_commit_for(&salt, word);

    // State: 2 guesses. Bob guessed ["slate", "crane"] (latest first).
    // Alice gave correct clue for "crane" at index 1.
    // make_clue("crane", "crane") = 0x72
    let bob_guesses = words_to_list(&mut allocator, &[b"slate", b"crane"]);
    let correct_clue = allocator.allocator().new_atom(&[0x72]).unwrap();
    let some_clue = allocator.allocator().new_atom(&[0x42]).unwrap();
    let a = allocator.allocator();
    let alice_clues = {
        let t = a.new_pair(correct_clue, NodePtr::NIL).unwrap();
        a.new_pair(some_clue, t).unwrap()
    };
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence = index 1 — but the clue is correct, so slash should fail
    let evidence = allocator.allocator().new_atom(&[0x01]).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    );
    assert!(result.is_err(), "slash attempt with correct clue should fail (assert raises)");
}

// --- Reveal path: mover_share at various depths ---

fn make_n_clues(allocator: &mut AllocEncoder, n: usize) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for _ in 0..n {
        let c = allocator.allocator().new_atom(&[0x01]).unwrap();
        tail = allocator.allocator().new_pair(c, tail).unwrap();
    }
    tail
}

fn test_reveal_payout_at_depth(depth: usize, expected_mover_share: i64) {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x99; 16];
    let commit = make_commit_for(&salt, word);

    // Build bob_guesses: latest guess is "crane" (correct), preceded by (depth-1) wrong guesses
    let wrong_words: [&[u8; 5]; 4] = [b"slate", b"trace", b"plumb", b"mango"];
    let mut guess_words: Vec<&[u8; 5]> = Vec::new();
    guess_words.push(b"crane"); // latest (correct)
    for i in 0..(depth - 1) {
        guess_words.push(wrong_words[i]);
    }
    let bob_guesses = words_to_list(&mut allocator, &guess_words);
    let alice_clues = make_n_clues(&mut allocator, depth - 1);

    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        expected_mover_share,
        state,
        NodePtr::NIL,
    ).unwrap_or_else(|e| panic!("depth {depth} reveal failed: {e}"));
    assert_eq!(code, MoveCode::MakeMove, "depth {depth} should succeed");
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "depth {depth} should return terminal (0 0 0)");
}

fn test_krunk_reveal_payout_depth_1() {
    test_reveal_payout_at_depth(1, BASE_UNIT * 100); // 200
}

fn test_krunk_reveal_payout_depth_2() {
    test_reveal_payout_at_depth(2, BASE_UNIT * 100); // 200
}

fn test_krunk_reveal_payout_depth_3() {
    test_reveal_payout_at_depth(3, BASE_UNIT * 20); // 40
}

fn test_krunk_reveal_payout_depth_4() {
    test_reveal_payout_at_depth(4, BASE_UNIT * 5); // 10
}

fn test_krunk_reveal_payout_depth_5() {
    test_reveal_payout_at_depth(5, BASE_UNIT * 1); // 2
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_krunk_commit_happy", &test_krunk_commit_happy),
        (
            "test_krunk_commit_slash_bad_move_size",
            &test_krunk_commit_slash_bad_move_size,
        ),
        ("test_krunk_guess_happy", &test_krunk_guess_happy),
        (
            "test_krunk_guess_slash_bob_out_of_dict",
            &test_krunk_guess_slash_bob_out_of_dict,
        ),
        (
            "test_krunk_guess_bad_range_doesnt_bracket",
            &test_krunk_guess_bad_range_doesnt_bracket,
        ),
        (
            "test_krunk_clue_nonterminal_happy",
            &test_krunk_clue_nonterminal_happy,
        ),
        (
            "test_krunk_clue_blocks_5th_clue",
            &test_krunk_clue_blocks_5th_clue,
        ),
        (
            "test_krunk_reveal_slash_alice_out_of_dict",
            &test_krunk_reveal_slash_alice_out_of_dict,
        ),
        (
            "test_krunk_reveal_bad_range_doesnt_bracket",
            &test_krunk_reveal_bad_range_doesnt_bracket,
        ),
        ("test_krunk_reveal_valid", &test_krunk_reveal_valid),
        (
            "test_krunk_clue_all_correct_byte_rejected",
            &test_krunk_clue_all_correct_byte_rejected,
        ),
        (
            "test_krunk_clue_above_range_rejected",
            &test_krunk_clue_above_range_rejected,
        ),
        (
            "test_krunk_clue_nonzero_mover_share_rejected",
            &test_krunk_clue_nonzero_mover_share_rejected,
        ),
        (
            "test_krunk_guess_wrong_length_rejected",
            &test_krunk_guess_wrong_length_rejected,
        ),
        (
            "test_krunk_guess_nonzero_mover_share_rejected",
            &test_krunk_guess_nonzero_mover_share_rejected,
        ),
        (
            "test_krunk_reveal_claims_won_but_latest_guess_wrong",
            &test_krunk_reveal_claims_won_but_latest_guess_wrong,
        ),
        (
            "test_krunk_reveal_claims_won_but_not_terminal",
            &test_krunk_reveal_claims_won_but_not_terminal,
        ),
        (
            "test_krunk_reveal_wrong_mover_share_amount",
            &test_krunk_reveal_wrong_mover_share_amount,
        ),
        (
            "test_krunk_reveal_bad_commit",
            &test_krunk_reveal_bad_commit,
        ),
        (
            "test_krunk_reveal_wrong_clue_slash",
            &test_krunk_reveal_wrong_clue_slash,
        ),
        (
            "test_krunk_reveal_correct_clue_no_slash",
            &test_krunk_reveal_correct_clue_no_slash,
        ),
        (
            "test_krunk_reveal_payout_depth_1",
            &test_krunk_reveal_payout_depth_1,
        ),
        (
            "test_krunk_reveal_payout_depth_2",
            &test_krunk_reveal_payout_depth_2,
        ),
        (
            "test_krunk_reveal_payout_depth_3",
            &test_krunk_reveal_payout_depth_3,
        ),
        (
            "test_krunk_reveal_payout_depth_4",
            &test_krunk_reveal_payout_depth_4,
        ),
        (
            "test_krunk_reveal_payout_depth_5",
            &test_krunk_reveal_payout_depth_5,
        ),
    ]
}
