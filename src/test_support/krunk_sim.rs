use std::rc::Rc;

use clvm_traits::ClvmEncoder;

use crate::channel_state::types::ReadableMove;
use crate::common::types::GameID;
use crate::common::types::{AllocEncoder, Program};
use crate::game_session::GameSession;
use crate::test_support::sim_script::SimScriptAction;
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
pub fn prefix_test_moves(allocator: &mut AllocEncoder, game_id: GameID) -> Vec<SimScriptAction> {
    test_moves_for_picker(allocator, game_id, 0)
}

fn test_moves_for_picker(
    allocator: &mut AllocEncoder,
    game_id: GameID,
    picker: usize,
) -> Vec<SimScriptAction> {
    // Dictionary entries are uppercase (see krunkwords.txt).
    let alice_word = word_program(allocator, b"CRANE");
    let bob_guess = word_program(allocator, b"CRANE");
    let nil_move = Program::from_hex("80").expect("nil move");
    let guesser = 1 - picker;

    vec![
        // Move 0: Alice commits her secret word.
        SimScriptAction::Move(
            picker,
            game_id,
            ReadableMove::from_program(Rc::new(alice_word)),
            true,
        ),
        // Move 1: Bob guesses (he picks "crane" and wins on first try).
        SimScriptAction::Move(
            guesser,
            game_id,
            ReadableMove::from_program(Rc::new(bob_guess)),
            true,
        ),
        // Move 2: Alice's handler sees the matching guess and reveals
        // automatically; local_move is unused for the terminal reveal path.
        SimScriptAction::Move(
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

    use crate::session_phases::effects::{ChannelStatus, GameNotification, GameStatusKind};
    use crate::simulator::tests::session_phases_sim::{
        run_krunk_container_with_action_list_with_success_predicate, GameRunOutcome,
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

    fn full_group_moves(allocator: &mut AllocEncoder) -> Vec<SimScriptAction> {
        let mut moves = vec![
            SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
            SimScriptAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(test_moves_for_picker(allocator, GameID(1), 0));
        moves.extend(test_moves_for_picker(allocator, GameID(3), 1));
        moves
    }

    fn third_guess_terminal_moves(
        allocator: &mut AllocEncoder,
        game_id: GameID,
    ) -> Vec<SimScriptAction> {
        let nil_move = Program::from_hex("80").expect("nil move");
        let mut moves = vec![SimScriptAction::Move(
            0,
            game_id,
            ReadableMove::from_program(Rc::new(word_program(allocator, b"CRANE"))),
            true,
        )];
        for guess in [b"WORLD", b"BLADE", b"CRANE"] {
            moves.push(SimScriptAction::Move(
                1,
                game_id,
                ReadableMove::from_program(Rc::new(word_program(allocator, guess))),
                true,
            ));
            moves.push(SimScriptAction::Move(
                0,
                game_id,
                ReadableMove::from_program(Rc::new(nil_move.clone())),
                true,
            ));
        }
        moves
    }

    pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
        let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();

        res.push(("test_play_krunk_happy_path", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = vec![
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
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
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
                SimScriptAction::Move(
                    0,
                    GameID(1),
                    ReadableMove::from_program(Rc::new(invalid_word)),
                    true,
                ),
                SimScriptAction::WaitBlocks(1, 0),
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
            assert!(!notifications
                .iter()
                .any(|notification| matches!(notification, GameNotification::ActionFailed { .. })));
            assert!(!notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::GameSettled { .. }
                    | GameNotification::GameStatus {
                        status: crate::session_phases::effects::GameStatusKind::EndedCancelled
                            | crate::session_phases::effects::GameStatusKind::EndedError,
                        ..
                    }
            )));
        }));

        res.push(("test_play_krunk_clean_shutdown", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = full_group_moves(&mut allocator);
            moves.push(SimScriptAction::CleanShutdown(1));

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
            moves.push(SimScriptAction::GoOnChain(0));

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
                            state: ChannelStatus::DoneUnrolling,
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
                            state: ChannelStatus::Failed,
                            ..
                        }
                    )),
                    "player {who} should not fail unroll recognition: {:?}",
                    ui.notifications
                );
            }
        }));

        res.push(("test_krunk_split_terminal_move_finishes_for_both", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = vec![
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
            ];
            let mut game_moves = third_guess_terminal_moves(&mut allocator, GameID(1));
            let terminal_reveal = game_moves.pop().expect("terminal reveal");
            moves.extend(game_moves);
            moves.push(SimScriptAction::GoOnChain(0));
            moves.push(terminal_reveal);
            moves.push(SimScriptAction::WaitBlocks(120, 1));
            moves.push(SimScriptAction::WaitBlocks(5, 0));

            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|_, sessions| {
                    for session in sessions {
                        let has_unspent_timeout_claim = session
                            .snapshot_watched_coins()
                            .iter()
                            .filter_map(|coin| session.watched_coin(coin))
                            .any(|watched| {
                                watched.birthday.is_some()
                                    && watched.spent_confirmed_at.is_none()
                                    && watched.timeout_spend.is_some()
                            });
                        if session.channel_status_terminal() && has_unspent_timeout_claim {
                            assert!(
                                !session.is_fully_resolved(),
                                "terminal channel must keep polling while a timeout claim is pending"
                            );
                        }
                    }
                    false
                }),
                None,
            )
            .expect("split Krunk terminal should resolve on chain");

            let picker = &outcome.local_uis[0].notifications;
            let guesser = &outcome.local_uis[1].notifications;
            assert!(
                picker.iter().any(|notification| matches!(
                    notification,
                    GameNotification::GameStatus {
                        id,
                        status: GameStatusKind::OnChainTheirTurn,
                        other_params: Some(params),
                        ..
                    } if *id == GameID(1) && params.game_finished == Some(true)
                )),
                "picker should mark the terminal coin as finishing: {picker:?}"
            );
            assert!(
                guesser.iter().any(|notification| matches!(
                    notification,
                    GameNotification::GameStatus {
                        id,
                        status: GameStatusKind::OnChainMyTurn,
                        other_params: Some(params),
                        ..
                    } if *id == GameID(1) && params.game_finished == Some(true)
                )),
                "guesser should mark the terminal coin as finishing: {guesser:?}"
            );
            for (side, notifications) in [("picker", picker), ("guesser", guesser)] {
                assert!(
                    notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::GameSettled {
                            id,
                            our_share,
                            ..
                        } if *id == GameID(1)
                            && *our_share > crate::common::types::Amount::default()
                    )),
                    "{side} should receive its positive terminal payout: {notifications:?}"
                );
            }
        }));

        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;
