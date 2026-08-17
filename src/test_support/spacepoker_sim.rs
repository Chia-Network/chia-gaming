use std::rc::Rc;

use crate::channel_state::types::ReadableMove;
use crate::common::types::GameID;
use crate::common::types::{AllocEncoder, Program};
use crate::game_session::GameSession;
use crate::test_support::sim_script::SimScriptAction;
use crate::transaction_manager::TransactionManager;

pub fn prefix_test_moves(_allocator: &mut AllocEncoder, game_id: GameID) -> Vec<SimScriptAction> {
    let nil_move = Program::from_hex("80").expect("should build nil move");
    let zero_raise = Program::from_hex("80").expect("should build zero raise");

    let mut moves = Vec::new();

    // Move 0: Alice commitA (automatic, local_move = nil)
    moves.push(SimScriptAction::Move(
        0,
        game_id,
        ReadableMove::from_program(Rc::new(nil_move.clone())),
        true,
    ));

    // Move 1: Bob commitB (automatic, local_move = nil)
    moves.push(SimScriptAction::Move(
        1,
        game_id,
        ReadableMove::from_program(Rc::new(nil_move.clone())),
        true,
    ));

    // 4 streets: begin_round (raise=0) + mid_round (call=nil)
    for _street in 0..4 {
        // Alice begin_round with raise=0
        moves.push(SimScriptAction::Move(
            0,
            game_id,
            ReadableMove::from_program(Rc::new(zero_raise.clone())),
            true,
        ));
        // Bob mid_round call (nil = call)
        moves.push(SimScriptAction::Move(
            1,
            game_id,
            ReadableMove::from_program(Rc::new(nil_move.clone())),
            true,
        ));
    }

    // Move 10: Alice end (automatic, local_move = nil — handler auto-selects best hand)
    moves.push(SimScriptAction::Move(
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
) -> Box<dyn Fn(usize, &[TransactionManager<GameSession>]) -> bool> {
    Box::new(
        move |move_number: usize, _: &[TransactionManager<GameSession>]| {
            move_number >= want_move_number
        },
    )
}

#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::session_phases::effects::{GameNotification, GameStatusKind, SettlementOutcome};
    use crate::simulator::tests::session_phases_sim::{
        run_spacepoker_container_with_action_list_with_seed,
        run_spacepoker_container_with_action_list_with_success_predicate, GameRunOutcome,
    };
    use crate::test_support::sim_script::ProposeTrigger;

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
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
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

        res.push((
            "test_spacepoker_on_chain_flag_finishes_without_playing_move",
            &|| {
                let mut allocator = AllocEncoder::new();
                let mut moves = vec![
                    SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                    SimScriptAction::AcceptProposal(1, GameID(1)),
                ];
                moves.extend(
                    prefix_test_moves(&mut allocator, GameID(1))
                        .into_iter()
                        .take(3),
                );
                moves.push(SimScriptAction::GoOnChain(1));
                moves.push(SimScriptAction::WaitBlocks(6, 0));
                moves.push(SimScriptAction::AcceptSettlement(1, GameID(1)));
                moves.push(SimScriptAction::WaitBlocks(20, 0));
                moves.push(SimScriptAction::WaitBlocks(5, 1));

                let outcome = run_spacepoker_container_with_action_list_with_success_predicate(
                    &mut allocator,
                    &moves,
                    None,
                    None,
                )
                .expect("on-chain Space Poker flag should settle");
                let winner = &outcome.local_uis[0].notifications;
                let accepter = &outcome.local_uis[1].notifications;
                let accepting_index = accepter
                    .iter()
                    .position(|notification| {
                        matches!(
                            notification,
                            GameNotification::GameStatus {
                                id: GameID(1),
                                status: GameStatusKind::OnChainMyTurn,
                                other_params: Some(params),
                                ..
                            } if params.game_finished == Some(true)
                        )
                    })
                    .unwrap_or_else(|| {
                        panic!("flagger should enter finishing state: {accepter:?}")
                    });

                assert!(
                    !accepter[accepting_index..]
                        .iter()
                        .any(|notification| matches!(
                            notification,
                            GameNotification::GameStatus {
                                id: GameID(1),
                                status: GameStatusKind::PlayingMove,
                                ..
                            }
                        )),
                    "flag must not be presented as an on-chain move: {accepter:?}"
                );
                assert!(
                    accepter.iter().any(|notification| matches!(
                        notification,
                        GameNotification::GameSettled {
                            id: GameID(1),
                            outcome: SettlementOutcome::WeAccepted,
                            ..
                        }
                    )),
                    "flagger should retain intentional accept semantics: {accepter:?}"
                );
                assert!(
                    winner.iter().any(|notification| matches!(
                        notification,
                        GameNotification::GameSettled {
                            id: GameID(1),
                            outcome: SettlementOutcome::OpponentTimedOut,
                            ..
                        }
                    )),
                    "winner should receive the authoritative opponent-timeout fact: {winner:?}"
                );
            },
        ));

        res.push(("test_spacepoker_bob_winning_final_move_on_chain", &|| {
            let mut allocator = AllocEncoder::new();
            let nil_move = Program::from_hex("80").expect("nil move");
            let move_for = |player| {
                SimScriptAction::Move(
                    player,
                    GameID(1),
                    ReadableMove::from_program(Rc::new(nil_move.clone())),
                    true,
                )
            };
            let mut moves = vec![
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
                move_for(0), // Alice commit
                move_for(1), // Bob commit
                move_for(0), // Alice pong; Bob opens
            ];
            for _ in 0..4 {
                moves.push(move_for(1)); // Bob checks
                moves.push(move_for(0)); // Alice calls
            }
            moves.push(SimScriptAction::GoOnChain(1));
            moves.push(SimScriptAction::WaitBlocks(6, 0));
            moves.push(move_for(1)); // Bob reveals his winning hand
            moves.push(SimScriptAction::WaitBlocks(20, 0));
            moves.push(SimScriptAction::WaitBlocks(5, 1));

            let outcome = run_spacepoker_container_with_action_list_with_seed(
                &mut allocator,
                &moves,
                None,
                None,
                [3; 32],
            )
            .expect("Bob's winning final move should settle on chain");

            let bob = &outcome.local_uis[1].notifications;
            assert!(
                bob.iter().any(|notification| matches!(
                    notification,
                    GameNotification::GameSettled {
                        id: GameID(1),
                        outcome: SettlementOutcome::SettledCleanly,
                        ..
                    }
                )),
                "Bob's winning reveal should settle cleanly: {bob:?}"
            );
            assert!(
                !bob.iter().any(|notification| matches!(
                    notification,
                    GameNotification::GameSettled {
                        id: GameID(1),
                        outcome: SettlementOutcome::ForfeitedSkippedReveal,
                        ..
                    }
                )),
                "Bob's winning reveal must not be treated as a zero-reward forfeit: {bob:?}"
            );
        }));

        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;
