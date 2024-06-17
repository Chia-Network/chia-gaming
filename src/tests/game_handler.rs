use clvm_tools_rs::classic::clvm_tools::binutils::{assemble, disassemble};
use clvm_traits::ToClvm;

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::game_handler::{MyTurnInputs, TheirTurnInputs, TheirTurnResult};
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{Aggsig, AllocEncoder, Amount, Hash};
use crate::referee::{GameMoveDetails, GameMoveStateInfo};

#[test]
fn test_game_handler_their_move_slash() {
    let mut allocator = AllocEncoder::new();
    let default_aggsig = Aggsig::default();

    let aggsig_node = default_aggsig.to_clvm(&mut allocator).expect("should make");
    let dis_aggsig = disassemble(allocator.allocator(), aggsig_node, None);
    let program = assemble(
        allocator.allocator(),
        &format!(
            "(c (1 . 2) (c (c (1 . 1337) 1) (c (1 . {}) ())))",
            dis_aggsig
        ),
    )
    .expect("should assemble");

    let their_turn_handler = GameHandler::their_driver_from_nodeptr(program);
    assert_eq!(their_turn_handler.is_my_turn(), false);
    let nil = allocator.allocator().null();
    let result = their_turn_handler
        .call_their_turn_driver(
            &mut allocator,
            &TheirTurnInputs {
                amount: Amount::default(),
                last_state: nil,
                last_move: &[],
                last_mover_share: Amount::default(),
                new_move: GameMoveDetails {
                    basic: GameMoveStateInfo {
                        move_made: vec![],
                        max_move_size: 0,
                        mover_share: Amount::default(),
                    },
                    validation_info_hash: Hash::default(),
                },
                #[cfg(test)]
                run_debug: true,
            },
        )
        .expect("should run");
    if let TheirTurnResult::Slash(evidence, aggsig) = result {
        // Good, check more
        assert_eq!(aggsig, default_aggsig);
        assert_eq!(disassemble(allocator.allocator(), evidence.to_nodeptr(), None), "(1337 () () () 0x0000000000000000000000000000000000000000000000000000000000000000 () ())");
    } else {
        assert!(false);
    }
}

#[test]
fn test_game_handler_their_make_move() {
    let mut allocator = AllocEncoder::new();
    let program = assemble(
        allocator.allocator(),
        "(c () (c (1 . 999) (c (c (1 . 1337) 1) (c (1 . 'test') ()))))",
    )
    .expect("should assemble");

    let their_turn_handler = GameHandler::their_driver_from_nodeptr(program);
    let nil = allocator.allocator().null();
    let result = their_turn_handler
        .call_their_turn_driver(
            &mut allocator,
            &TheirTurnInputs {
                amount: Amount::default(),
                last_state: nil,
                last_move: &[],
                last_mover_share: Amount::default(),
                new_move: GameMoveDetails {
                    basic: GameMoveStateInfo {
                        move_made: vec![],
                        max_move_size: 0,
                        mover_share: Amount::default(),
                    },
                    validation_info_hash: Hash::default(),
                },
                #[cfg(test)]
                run_debug: true,
            },
        )
        .expect("should run");
    if let TheirTurnResult::MakeMove(state, game_handler, msg) = result {
        assert_eq!(msg, b"test");
        assert_eq!(disassemble(allocator.allocator(), state, None), "999");
        assert_eq!(disassemble(allocator.allocator(), game_handler.to_nodeptr(), None), "(1337 () () () 0x0000000000000000000000000000000000000000000000000000000000000000 () ())");
    } else {
        assert!(false);
    }
}

#[test]
fn test_game_handler_my_turn() {
    let mut allocator = AllocEncoder::new();
    let program =
        assemble(
            allocator.allocator(),
            "(c (1 . 1) (c (1 . 2) (c (1 . 3) (c (1 . 4) (c (1 . 5) (c (1 . 6) (c (c (1 . 1337) 1) (c (1 . 8) ()))))))))"
        ).expect("should assemble");

    let my_turn_handler = GameHandler::my_driver_from_nodeptr(program);
    let nil = allocator.allocator().null();
    let result = my_turn_handler
        .call_my_turn_driver(
            &mut allocator,
            &MyTurnInputs {
                readable_new_move: ReadableMove::from_nodeptr(nil),
                amount: Amount::default(),
                last_state: nil,
                last_move: &[],
                last_mover_share: Amount::default(),
                last_max_move_size: 100,
                entropy: Hash::default(),
                #[cfg(test)]
                run_debug: true,
            },
        )
        .expect("should run");
    assert_eq!(
        disassemble(
            allocator.allocator(),
            result.waiting_driver.to_nodeptr(),
            None
        ),
        "(1337 () () () () 100 0x0000000000000000000000000000000000000000000000000000000000000000)"
    );
    assert_eq!(result.game_move.basic.move_made, &[1]);
    assert_eq!(disassemble(allocator.allocator(), result.state, None), "4");
}
