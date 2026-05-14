use std::rc::Rc;

use crate::channel_handler::types::ReadableMove;
use crate::common::types::GameID;
use crate::common::types::{AllocEncoder, Program};
use crate::peer_container::SynchronousGameCradle;
use crate::test_support::game::GameAction;

pub fn prefix_test_moves(allocator: &mut AllocEncoder, game_id: GameID) -> Vec<GameAction> {
    let nil_move = Program::from_hex("80").expect("should build nil move");
    let zero_raise = Program::from_hex("80").expect("should build zero raise");

    let mut moves = Vec::new();

    // Move 0: Alice commitA (automatic, local_move = nil)
    moves.push(GameAction::Move(
        0,
        game_id,
        ReadableMove::from_program(Rc::new(nil_move.clone())),
        true,
    ));

    // Move 1: Bob commitB (automatic, local_move = nil)
    moves.push(GameAction::Move(
        1,
        game_id,
        ReadableMove::from_program(Rc::new(nil_move.clone())),
        true,
    ));

    // 4 streets: begin_round (raise=0) + mid_round (call=nil)
    for _street in 0..4 {
        // Alice begin_round with raise=0
        moves.push(GameAction::Move(
            0,
            game_id,
            ReadableMove::from_program(Rc::new(zero_raise.clone())),
            true,
        ));
        // Bob mid_round call (nil = call)
        moves.push(GameAction::Move(
            1,
            game_id,
            ReadableMove::from_program(Rc::new(nil_move.clone())),
            true,
        ));
    }

    // Move 10: Alice end (automatic, local_move = nil — handler auto-selects best hand)
    moves.push(GameAction::Move(
        0,
        game_id,
        ReadableMove::from_program(Rc::new(nil_move)),
        true,
    ));

    moves
}

#[allow(clippy::type_complexity)]
pub fn spacepoker_ran_all_the_moves_predicate(
    want_move_number: usize,
) -> Box<dyn Fn(usize, &[SynchronousGameCradle]) -> bool> {
    Box::new(move |move_number: usize, _: &[SynchronousGameCradle]| move_number >= want_move_number)
}

#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::simulator::tests::potato_handler_sim::{
        run_spacepoker_container_with_action_list_with_success_predicate, GameRunOutcome,
    };
    use crate::test_support::game::ProposeTrigger;

    fn assert_stayed_off_chain(outcome: &GameRunOutcome, test_name: &str) {
        for (who, ui) in outcome.local_uis.iter().enumerate() {
            assert!(
                !ui.go_on_chain,
                "{test_name}: player {who} unexpectedly entered on-chain mode; got_error={} notifications={:?}",
                ui.got_error,
                ui.notifications
            );
            assert!(
                !ui.got_error,
                "{test_name}: player {who} reported an on-chain/error transition; go_on_chain={} notifications={:?}",
                ui.go_on_chain,
                ui.notifications
            );
        }
    }

    pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
        let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();

        res.push(("test_play_spacepoker_happy_path", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let num_moves = moves.len();
            let result = run_spacepoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&spacepoker_ran_all_the_moves_predicate(num_moves)),
                None,
            );
            match result {
                Ok(outcome) => {
                    assert_stayed_off_chain(&outcome, "test_play_spacepoker_happy_path");
                }
                Err(e) => {
                    panic!("spacepoker happy path failed; error={e:?}");
                }
            }
        }));

        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;
