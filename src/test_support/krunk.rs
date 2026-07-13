use std::rc::Rc;

use clvm_traits::ClvmEncoder;

use crate::channel_handler::types::ReadableMove;
use crate::common::types::GameID;
use crate::common::types::{AllocEncoder, Program};
use crate::peer_container::SynchronousGameCradle;
use crate::test_support::game::GameAction;
use crate::transaction_manager::TransactionManager;

/// Build a Program holding a single 5-byte atom (a krunk word).
fn word_program(allocator: &mut AllocEncoder, word: &[u8; 5]) -> Program {
    let node = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(word))
        .expect("encode word atom");
    Program::from_nodeptr(allocator, node).expect("word -> program")
}

/// Happy-path krunk moves: Alice commits "crane", Bob guesses "crane",
/// Alice's clue handler auto-detects the match and reveals.
pub fn prefix_test_moves(allocator: &mut AllocEncoder, game_id: GameID) -> Vec<GameAction> {
    test_moves_for_picker(allocator, game_id, 0)
}

fn test_moves_for_picker(
    allocator: &mut AllocEncoder,
    game_id: GameID,
    picker: usize,
) -> Vec<GameAction> {
    // Dictionary entries are uppercase (see krunkwords.txt).
    let alice_word = word_program(allocator, b"CRANE");
    let bob_guess = word_program(allocator, b"CRANE");
    let nil_move = Program::from_hex("80").expect("nil move");
    let guesser = 1 - picker;

    vec![
        // Move 0: Alice commits her secret word.
        GameAction::Move(
            picker,
            game_id,
            ReadableMove::from_program(Rc::new(alice_word)),
            true,
        ),
        // Move 1: Bob guesses (he picks "crane" and wins on first try).
        GameAction::Move(
            guesser,
            game_id,
            ReadableMove::from_program(Rc::new(bob_guess)),
            true,
        ),
        // Move 2: Alice's handler sees the matching guess and reveals
        // automatically; local_move is unused for the terminal reveal path.
        GameAction::Move(
            picker,
            game_id,
            ReadableMove::from_program(Rc::new(nil_move)),
            true,
        ),
    ]
}

#[allow(clippy::type_complexity)]
pub fn krunk_ran_all_the_moves_predicate(
    want_move_number: usize,
) -> Box<dyn Fn(usize, &[TransactionManager<SynchronousGameCradle>]) -> bool> {
    Box::new(
        move |move_number: usize, _: &[TransactionManager<SynchronousGameCradle>]| {
            move_number >= want_move_number
        },
    )
}

#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::potato_handler::effects::{ChannelState, GameNotification};
    use crate::simulator::tests::potato_handler_sim::{
        run_krunk_container_with_action_list_with_success_predicate, GameRunOutcome,
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

    fn full_group_moves(allocator: &mut AllocEncoder) -> Vec<GameAction> {
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(test_moves_for_picker(allocator, GameID(1), 0));
        moves.extend(test_moves_for_picker(allocator, GameID(3), 1));
        moves
    }

    pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
        let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();

        res.push(("test_play_krunk_happy_path", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let num_moves = moves.len();
            let result = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&krunk_ran_all_the_moves_predicate(num_moves)),
                None,
            );
            match result {
                Ok(outcome) => {
                    assert_stayed_off_chain(&outcome, "test_play_krunk_happy_path");
                }
                Err(e) => {
                    panic!("krunk happy path failed; error={e:?}");
                }
            }
        }));

        res.push(("test_krunk_rejected_local_move_stays_live", &|| {
            let mut allocator = AllocEncoder::new();
            let invalid_word = word_program(&mut allocator, b"XXXXX");
            let moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
                GameAction::Move(
                    0,
                    GameID(1),
                    ReadableMove::from_program(Rc::new(invalid_word)),
                    true,
                ),
                GameAction::WaitBlocks(1, 0),
            ];
            let move_count = moves.len();
            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&krunk_ran_all_the_moves_predicate(move_count)),
                None,
            )
            .expect("rejected local Krunk move should remain recoverable");

            assert_stayed_off_chain(&outcome, "test_krunk_rejected_local_move_stays_live");
            let notifications = &outcome.local_uis[0].notifications;
            assert!(notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::MoveRejected { id, tag, message }
                    if *id == GameID(1)
                        && tag == "not_in_dictionary"
                        && message == "XXXXX"
            )));
            assert!(!notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::ActionFailed { .. }
            )));
            assert!(!notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::GameStatus {
                    status:
                        crate::potato_handler::effects::GameStatusKind::EndedWeTimedOut
                        | crate::potato_handler::effects::GameStatusKind::EndedOpponentTimedOut
                        | crate::potato_handler::effects::GameStatusKind::EndedWeSlashedOpponent
                        | crate::potato_handler::effects::GameStatusKind::EndedOpponentSlashedUs
                        | crate::potato_handler::effects::GameStatusKind::EndedOpponentSuccessfullyCheated
                        | crate::potato_handler::effects::GameStatusKind::EndedCancelled
                        | crate::potato_handler::effects::GameStatusKind::EndedError,
                    ..
                }
            )));
        }));

        res.push(("test_play_krunk_clean_shutdown", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = full_group_moves(&mut allocator);
            moves.push(GameAction::CleanShutdown(1));

            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                None,
                None,
            )
            .expect("krunk clean shutdown should complete");
            for (who, ui) in outcome.local_uis.iter().enumerate() {
                assert!(
                    ui.clean_shutdown_complete && !ui.got_error,
                    "player {who} should recognize the clean shutdown: {:?}",
                    ui.notifications
                );
            }
        }));

        res.push(("test_play_krunk_go_on_chain", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = full_group_moves(&mut allocator);
            moves.push(GameAction::GoOnChain(0));

            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                None,
                None,
            )
            .expect("krunk on-chain resolution should complete");
            for (who, ui) in outcome.local_uis.iter().enumerate() {
                assert!(
                    ui.notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::ChannelStatus {
                            state: ChannelState::ResolvedUnrolled,
                            ..
                        }
                    )),
                    "player {who} should resolve through the known unroll: {:?}",
                    ui.notifications
                );
                assert!(
                    !ui.notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::ChannelStatus {
                            state: ChannelState::Failed,
                            ..
                        }
                    )),
                    "player {who} should not fail unroll recognition: {:?}",
                    ui.notifications
                );
            }
        }));

        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;
