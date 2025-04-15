use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::game_handler::{MyTurnInputs, TheirTurnInputs, TheirTurnResult};
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{AllocEncoder, Amount, Hash, Node, Program};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};

#[test]
fn test_game_handler_their_move_slash() {
    let mut allocator = AllocEncoder::new();

    let program = Program::from_hex("ff04ffff0102ffff04ffff04ffff01820539ff0180ff808080")
        .expect("cvt")
        .to_clvm(&mut allocator)
        .expect("cvt");
    let their_turn_handler =
        GameHandler::their_driver_from_nodeptr(&mut allocator, program).expect("should cvt");
    assert!(!their_turn_handler.is_my_turn());
    let nil = allocator.allocator().nil();
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
            },
        )
        .expect("should run");
    if let TheirTurnResult::Slash(evidence) = result {
        // Good, check more
        let z32: [u8; 32] = [0; 32];
        let z32_node = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&z32))
            .expect("cvt");
        let evidence_compare = (1337, ((), ((), ((), (Node(z32_node), ((), ((), ())))))))
            .to_clvm(&mut allocator)
            .expect("cvt");
        let evidence_hex = evidence.to_program().to_hex();
        assert_eq!(
            evidence_hex,
            Node(evidence_compare).to_hex(&mut allocator).expect("cvt")
        );
    } else {
        unreachable!();
    }
}

#[test]
fn test_game_handler_their_make_move() {
    let mut allocator = AllocEncoder::new();
    let prog = Program::from_hex("ff04ff80ffff04ffff018203e7ffff04ff80ffff04ffff04ffff01820539ff0180ffff04ffff018474657374ff808080808080").expect("cvt");
    let program = prog.to_clvm(&mut allocator).expect("cvt");

    let their_turn_handler =
        GameHandler::their_driver_from_nodeptr(&mut allocator, program).expect("should cvt");
    let nil = allocator.allocator().nil();
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
            },
        )
        .expect("should run");
    if let TheirTurnResult::MakeMove(game_handler, msg, move_data) = result {
        let game_handler_node = game_handler.to_nodeptr(&mut allocator).expect("should cvt");
        assert_eq!(msg, b"test");
        let node_999 = 999.to_clvm(&mut allocator).expect("cvt");
        let hex_999 = Node(node_999).to_hex(&mut allocator).expect("cvt");
        let z32: [u8; 32] = [0; 32];
        let node_z32 = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&z32))
            .expect("cvt");
        assert_eq!(
            move_data.readable_move.p()
                .to_hex(),
            hex_999
        );
        let node_list = (1337, ((), ((), ((), (node_z32, ((), ((), ())))))))
            .to_clvm(&mut allocator)
            .expect("cvt");
        let game_handler_hex = Node(game_handler_node).to_hex(&mut allocator).expect("cvt");
        assert_eq!(
            game_handler_hex,
            Node(node_list).to_hex(&mut allocator).expect("cvt")
        );
    } else {
        unreachable!();
    }
}

#[test]
fn test_game_handler_my_turn() {
    let mut allocator = AllocEncoder::new();
    let program = Program::from_hex("ff04ffff0101ffff04ffff0102ffff04ffff0103ffff04ffff0104ffff04ffff0105ffff04ffff0106ffff04ffff04ffff01820539ff0180ffff04ffff0108ff808080808080808080").expect("cvt").to_clvm(&mut allocator).expect("cvt");
    let my_turn_handler =
        GameHandler::my_driver_from_nodeptr(&mut allocator, program).expect("should cvt");
    let result = my_turn_handler
        .call_my_turn_driver(
            &mut allocator,
            &MyTurnInputs {
                readable_new_move: ReadableMove::from_program(Rc::new(Program::from_bytes(&[
                    0x80,
                ]))),
                amount: Amount::default(),
                last_move: &[],
                last_mover_share: Amount::default(),
                last_max_move_size: 100,
                entropy: Hash::default(),
            },
        )
        .expect("should run");
    let waiting_driver_node = result
        .waiting_driver
        .to_nodeptr(&mut allocator)
        .expect("should cvt");
    let z32: [u8; 32] = [0; 32];
    let encoded_z32 = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&z32))
        .expect("cvt");
    let encoded_result = (1337, ((), ((), ((), (100, (Node(encoded_z32), ()))))))
        .to_clvm(&mut allocator)
        .expect("cvt");
    let waiting_hex = Node(waiting_driver_node)
        .to_hex(&mut allocator)
        .expect("cvt");
    assert_eq!(
        waiting_hex,
        Node(encoded_result).to_hex(&mut allocator).expect("cvt")
    );
    assert_eq!(result.game_move.basic.move_made, &[1]);
    assert_eq!(result.state, Rc::new(Program::from_bytes(&[4])));
}
