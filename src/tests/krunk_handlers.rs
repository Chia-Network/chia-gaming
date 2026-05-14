#![allow(non_snake_case)]

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const BET_SIZE: i64 = 100;

fn run_clvm(allocator: &mut AllocEncoder, program: NodePtr, args: NodePtr) -> NodePtr {
    run_program(allocator.allocator(), &chia_dialect(), program, args, 0)
        .expect("CLVM run failed")
        .1
}

fn int_from_node(allocator: &mut AllocEncoder, node: NodePtr) -> i64 {
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
        _ => panic!("expected atom for int"),
    }
}

// Smoke test: load the krunk hex puzzles, run make_proposal + parser, and
// verify the wire/local data shapes. Does NOT execute any handler or
// validator bodies (they currently raise `(x "TODO: ...")`).
fn test_krunk_setup_game() {
    let mut allocator = AllocEncoder::new();

    let make_proposal = read_hex_puzzle(
        &mut allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )
    .expect("load krunk make_proposal");
    let parser = read_hex_puzzle(
        &mut allocator,
        "clsp/games/krunk/krunk_include_krunk_parser.hex",
    )
    .expect("load krunk parser");

    let make_proposal_clvm = make_proposal.to_clvm(&mut allocator).unwrap();
    let parser_clvm = parser.to_clvm(&mut allocator).unwrap();

    // Run make_proposal(BET_SIZE)
    let bet_args = (BET_SIZE, ()).to_clvm(&mut allocator).unwrap();
    let proposal_result = run_clvm(&mut allocator, make_proposal_clvm, bet_args);

    let proposal_list = proper_list(allocator.allocator(), proposal_result, true)
        .expect("make_proposal should return a proper list");
    assert_eq!(
        proposal_list.len(),
        2,
        "make_proposal returned {} elements, expected 2 (wire_data local_data)",
        proposal_list.len(),
    );
    let wire_data = proposal_list[0];
    let local_data = proposal_list[1];

    // wire_data = (my_contribution their_contribution [(amount we_go_first
    //              initial_validator_hash initial_move initial_max_move_size
    //              initial_state initial_mover_share)])
    let wire_data_list = proper_list(allocator.allocator(), wire_data, true)
        .expect("wire_data should be a proper list");
    assert_eq!(
        wire_data_list.len(),
        3,
        "wire_data should have 3 fields, got {}",
        wire_data_list.len(),
    );

    let my_contribution = int_from_node(&mut allocator, wire_data_list[0]);
    let their_contribution = int_from_node(&mut allocator, wire_data_list[1]);
    assert_eq!(my_contribution, BET_SIZE);
    assert_eq!(their_contribution, BET_SIZE);

    let game_specs_wrapper = proper_list(allocator.allocator(), wire_data_list[2], true)
        .expect("wire_data[2] should be a list of game_specs");
    assert!(!game_specs_wrapper.is_empty(), "no game_spec in wire_data");
    let game_spec = proper_list(allocator.allocator(), game_specs_wrapper[0], true)
        .expect("game_spec should be a proper list");
    assert_eq!(
        game_spec.len(),
        7,
        "game_spec should have 7 fields, got {}",
        game_spec.len(),
    );

    let amount = int_from_node(&mut allocator, game_spec[0]);
    let we_go_first = int_from_node(&mut allocator, game_spec[1]);
    let initial_max_move_size = int_from_node(&mut allocator, game_spec[4]);
    let initial_mover_share = int_from_node(&mut allocator, game_spec[6]);

    assert_eq!(amount, 2 * BET_SIZE, "amount should be 2 * bet_size");
    assert_eq!(we_go_first, 1, "proposer should go first");
    assert_eq!(initial_max_move_size, 32);
    assert_eq!(initial_mover_share, 0);

    // local_data = [(initial_handler initial_validator)]
    let local_data_list = proper_list(allocator.allocator(), local_data, true)
        .expect("local_data should be a proper list");
    assert!(
        !local_data_list.is_empty(),
        "local_data should contain at least one handler/validator pair"
    );
    let hv_list = proper_list(allocator.allocator(), local_data_list[0], true)
        .expect("local_data[0] should be (handler validator)");
    assert_eq!(
        hv_list.len(),
        2,
        "handler/validator pair should have 2 elements, got {}",
        hv_list.len(),
    );

    // Run parser(wire_data) and check the responder's handler/validator shape.
    let parser_result = run_clvm(&mut allocator, parser_clvm, wire_data);
    let parser_list = proper_list(allocator.allocator(), parser_result, true)
        .expect("parser should return a proper list");
    assert_eq!(
        parser_list.len(),
        2,
        "parser returned {} elements, expected 2 (readable handler_data)",
        parser_list.len(),
    );

    let bob_data_list = proper_list(allocator.allocator(), parser_list[1], true)
        .expect("parser handler_data should be a proper list");
    assert!(
        !bob_data_list.is_empty(),
        "parser handler_data should contain at least one validator/handler pair"
    );
    let bob_vh_list = proper_list(allocator.allocator(), bob_data_list[0], true)
        .expect("parser handler_data[0] should be (validator handler)");
    assert_eq!(
        bob_vh_list.len(),
        2,
        "parser validator/handler pair should have 2 elements, got {}",
        bob_vh_list.len(),
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![("test_krunk_setup_game", &test_krunk_setup_game)]
}
