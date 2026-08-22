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

    use std::collections::{HashMap, VecDeque};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    use crate::channel_state::types::{ChannelEnv, OnChainGameState, TimeoutClaimState};
    use crate::common::types::{Amount, CoinString, Hash, PuzzleHash, Timeout};
    use crate::session_phases::effects::{
        ChannelStatus, ChannelStatusSnapshot, GameNotification, GameStatusKind, LocalActionKind,
        SettlementOutcome,
    };
    use crate::session_phases::on_chain::{OnChainPhase, OnChainPhaseArgs};
    use crate::session_phases::types::{GameAction, PeerMessage, PotatoState};
    use crate::simulator::tests::session_phases_sim::{
        run_krunk_container_with_action_list_with_success_predicate, GameRunOutcome, TestEvent,
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

    fn first_wrong_guess_moves(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        picker: usize,
    ) -> Vec<SimScriptAction> {
        let guesser = 1 - picker;
        vec![
            SimScriptAction::Move(
                picker,
                game_id,
                ReadableMove::from_program(Rc::new(word_program(allocator, b"CRANE"))),
                true,
            ),
            SimScriptAction::Move(
                guesser,
                game_id,
                ReadableMove::from_program(Rc::new(word_program(allocator, b"WORLD"))),
                true,
            ),
            SimScriptAction::Move(
                picker,
                game_id,
                ReadableMove::from_program(Rc::new(
                    Program::from_hex("80").expect("nil clue move"),
                )),
                true,
            ),
        ]
    }

    fn assert_single_scripted_nil(moves: &[SimScriptAction], picker: usize, game_id: GameID) {
        let count = moves
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    SimScriptAction::Move(who, id, readable, _)
                        if *who == picker
                            && *id == game_id
                            && readable.to_program().bytes() == [0x80]
                )
            })
            .count();
        assert_eq!(
            count, 1,
            "the simulator script must submit the picker nil command exactly once"
        );
    }

    fn assert_cached_nil_redo(outcome: &GameRunOutcome, picker: usize, game_id: GameID) {
        let picker_ui = &outcome.local_uis[picker];
        let replay_coin = picker_ui
            .notifications
            .iter()
            .find_map(|notification| match notification {
                GameNotification::GameStatus {
                    id,
                    status: GameStatusKind::Replaying,
                    coin_id: Some(coin),
                    ..
                } if *id == game_id => Some(coin),
                _ => None,
            })
            .unwrap_or_else(|| {
                panic!(
                    "picker {picker} must report Replaying for {game_id:?}: {:?}",
                    picker_ui.notifications
                )
            });
        assert_eq!(
            outcome.transaction_submission_count_for_coin(picker, replay_coin),
            1,
            "picker {picker} must submit exactly one redo spend for {game_id:?}"
        );
        assert_eq!(
            picker_ui
                .notifications
                .iter()
                .filter(|notification| matches!(
                    notification,
                    GameNotification::GameStatus {
                        id,
                        status: GameStatusKind::OnChainTheirTurn,
                        other_params: Some(params),
                        ..
                    } if *id == game_id && params.moved_by_us == Some(true)
                ))
                .count(),
            1,
            "picker {picker} must confirm exactly one internally redone nil move"
        );
        assert!(
            !picker_ui.notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::GameSettled {
                    id,
                    outcome: SettlementOutcome::TimedOutWaitingForOurMove,
                    ..
                } if *id == game_id
            )),
            "picker {picker} must not time out waiting for the cached nil move"
        );

        let resolved_index = picker_ui
            .events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    TestEvent::Notification(GameNotification::ChannelStatus(
                        ChannelStatusSnapshot {
                            state: ChannelStatus::ResolvedUnrolled,
                            ..
                        }
                    ))
                )
            })
            .expect("picker must observe unroll resolution");
        assert!(
            !picker_ui.events[resolved_index + 1..]
                .iter()
                .any(|event| matches!(
                    event,
                    TestEvent::OpponentMoved { id, .. } if *id == game_id
                )),
            "Rust redo must not emit a readable event asking the picker UI to replay nil"
        );

        let guesser = 1 - picker;
        assert_eq!(
            outcome.local_uis[guesser]
                .opponent_moves
                .iter()
                .filter(|(id, ..)| *id == game_id)
                .count(),
            2,
            "guesser must see the original commit and exactly one on-chain clue"
        );
    }

    fn run_cached_nil_redo_case(picker: usize, game_id: GameID) {
        let mut allocator = AllocEncoder::new();
        let mut round = first_wrong_guess_moves(&mut allocator, game_id, picker);
        let nil_move = round.pop().expect("nil clue");
        let mut moves = vec![
            SimScriptAction::ProposeKrunkGroup(0, ProposeTrigger::Channel),
            SimScriptAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(round);
        moves.push(SimScriptAction::NerfMessages(picker));
        moves.push(nil_move);
        moves.push(SimScriptAction::GoOnChain(picker));
        moves.push(SimScriptAction::WaitBlocks(45, 0));
        assert_single_scripted_nil(&moves, picker, game_id);

        let outcome = run_krunk_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            None,
        )
        .expect("cached Krunk nil must redo on chain");
        assert_cached_nil_redo(&outcome, picker, game_id);
    }

    fn phase_for_move_validation(
        game_id: GameID,
        our_turn: bool,
        game_action_queue: VecDeque<GameAction>,
    ) -> OnChainPhase {
        let game_map = HashMap::from([(
            CoinString::default(),
            OnChainGameState {
                game_id,
                puzzle_hash: PuzzleHash::default(),
                our_turn,
                state_number: 0,
                timeout_claim: TimeoutClaimState::Waiting,
                pending_slash_amount: None,
                cheating_move_mover_share: None,
                timeout_claim_armed: false,
                notification_sent: false,
                game_timeout: Timeout::new(15),
                game_finished: false,
            },
        )]);
        let mut rng = ChaCha8Rng::from_seed([0; 32]);
        OnChainPhase::new(OnChainPhaseArgs {
            have_potato: PotatoState::Present,
            channel_timeout: Timeout::new(15),
            game_action_queue,
            game_map,
            pending_moves: HashMap::new(),
            private_keys: rng.random(),
            reward_puzzle_hash: PuzzleHash::default(),
            their_reward_puzzle_hash: PuzzleHash::default(),
            my_out_of_game_balance: Amount::default(),
            their_out_of_game_balance: Amount::default(),
            my_allocated_balance: Amount::default(),
            their_allocated_balance: Amount::default(),
            live_games: Vec::new(),
            pending_settlements: Vec::new(),
            unroll_advance_timeout: Timeout::new(15),
            is_initial_potato: true,
            state_number: 0,
            was_stale: false,
            resolved_clean: false,
            terminal_reward_coin: None,
            game_payout_coins: Vec::new(),
        })
    }

    fn assert_phase_move_panics(mut phase: OnChainPhase, game_id: GameID, expected: &str) {
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let mut allocator = AllocEncoder::new();
            let mut env = ChannelEnv::new(&mut allocator).expect("channel environment");
            let readable = ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
            let _ = phase.make_move(&mut env, &game_id, &readable, Hash::default());
        }))
        .expect_err("phase API must fail loudly");
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("<non-string panic>");
        assert!(
            message.contains(expected),
            "expected panic containing {expected:?}, got {message:?}"
        );
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
                    let player_0_moves = outcome.local_uis[0]
                        .notifications
                        .iter()
                        .filter(|notification| matches!(
                            notification,
                            GameNotification::LocalActionApplied {
                                id: GameID(1),
                                action: LocalActionKind::MakeMove,
                            }
                        ))
                        .count();
                    let player_1_moves = outcome.local_uis[1]
                        .notifications
                        .iter()
                        .filter(|notification| matches!(
                            notification,
                            GameNotification::LocalActionApplied {
                                id: GameID(1),
                                action: LocalActionKind::MakeMove,
                            }
                        ))
                        .count();
                    assert_eq!(player_0_moves, 1);
                    assert_eq!(player_1_moves, 1);
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
                GameNotification::LocalActionApplied {
                    id: GameID(1),
                    action: LocalActionKind::MakeMove,
                }
            )));
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

        res.push(("test_krunk_move_applies_after_potato_returns", &|| {
            let mut allocator = AllocEncoder::new();
            let valid_word = word_program(&mut allocator, b"CRANE");
            let request_potato =
                bencodex::to_vec(&PeerMessage::RequestPotato(())).expect("serialize request");
            let moves = vec![
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
                // Give away the potato without changing the game turn, then
                // queue the move while player 0 still has move authority.
                SimScriptAction::InjectRawMessage(0, request_potato),
                SimScriptAction::Move(
                    0,
                    GameID(1),
                    ReadableMove::from_program(Rc::new(valid_word)),
                    true,
                ),
                SimScriptAction::WaitBlocks(1, 0),
            ];
            let move_count = moves.len();
            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|move_number, cradles| {
                    move_number >= move_count
                        && cradles[0]
                            .historical_unroll_count()
                            .is_some_and(|count| count >= 5)
                }),
                None,
            )
            .expect("queued move should apply after the potato returns");

            let notifications = &outcome.local_uis[0].notifications;
            assert_eq!(
                notifications
                    .iter()
                    .filter(|notification| matches!(
                        notification,
                        GameNotification::LocalActionApplied {
                            id: GameID(1),
                            action: LocalActionKind::MakeMove,
                        }
                    ))
                    .count(),
                1,
                "queued move should emit once after potato return: {notifications:?}"
            );
        }));

        res.push(("test_krunk_rejection_after_potato_returns_is_not_applied", &|| {
            let mut allocator = AllocEncoder::new();
            let invalid_word = word_program(&mut allocator, b"XXXXX");
            let request_potato =
                bencodex::to_vec(&PeerMessage::RequestPotato(())).expect("serialize request");
            let moves = vec![
                SimScriptAction::ProposeNewGame(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
                SimScriptAction::InjectRawMessage(0, request_potato),
                SimScriptAction::Move(
                    0,
                    GameID(1),
                    ReadableMove::from_program(Rc::new(invalid_word)),
                    true,
                ),
                SimScriptAction::AcceptSettlement(0, GameID(1)),
                SimScriptAction::WaitBlocks(1, 0),
            ];
            let move_count = moves.len();
            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|move_number, cradles| {
                    move_number >= move_count
                        && cradles[0]
                            .historical_unroll_count()
                            .is_some_and(|count| count >= 5)
                }),
                None,
            )
            .expect("queued rejection should remain recoverable");

            let notifications = &outcome.local_uis[0].notifications;
            assert!(notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::MoveRejected { id: GameID(1), .. }
            )));
            assert!(!notifications.iter().any(|notification| matches!(
                notification,
                GameNotification::LocalActionApplied {
                    id: GameID(1),
                    action: LocalActionKind::MakeMove,
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
            let moves = vec![
                SimScriptAction::ProposeKrunkGroup(0, ProposeTrigger::Channel),
                SimScriptAction::AcceptProposal(1, GameID(1)),
                SimScriptAction::GoOnChain(0),
                SimScriptAction::WaitBlocks(120, 0),
            ];

            let outcome = run_krunk_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                None,
                None,
            )
            .expect("krunk on-chain resolution should complete");
            for (who, ui) in outcome.local_uis.iter().enumerate() {
                let drain_trace = outcome.host_drain_trace(who);
                let terminal_events: Vec<_> = drain_trace
                    .iter()
                    .flat_map(|drain| {
                        drain.notifications.iter().filter_map(move |notification| {
                            if let GameNotification::GameSettled { id, outcome, .. } = notification {
                                Some((drain.terminal, *id, outcome.clone()))
                            } else {
                                None
                            }
                        })
                    })
                    .collect();
                let expected_by_id = if who == 0 {
                    [
                        (
                            true,
                            GameID(1),
                            SettlementOutcome::TimedOutWaitingForOurMove,
                        ),
                        (true, GameID(3), SettlementOutcome::OpponentTimedOut),
                    ]
                } else {
                    [
                        (true, GameID(1), SettlementOutcome::OpponentTimedOut),
                        (
                            true,
                            GameID(3),
                            SettlementOutcome::TimedOutWaitingForOurMove,
                        ),
                    ]
                };
                assert!(
                    terminal_events == expected_by_id
                        || terminal_events == [expected_by_id[1].clone(), expected_by_id[0].clone()],
                    "player {who} host drain must preserve one complete timeout-event permutation: {terminal_events:?}"
                );
                assert_eq!(
                    drain_trace
                        .iter()
                        .filter(|drain| {
                            drain.notifications.iter().any(
                                |notification| matches!(notification, GameNotification::GameSettled { .. }),
                            )
                        })
                        .count(),
                    1,
                    "player {who} should receive both timeout events in one terminal host drain"
                );
                assert!(
                    ui.notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::ChannelStatus(ChannelStatusSnapshot {
                            state: ChannelStatus::ResolvedUnrolled,
                            ..
                        })
                    )),
                    "player {who} should resolve through the known unroll: {:?}",
                    ui.notifications
                );
                assert!(
                    !ui.notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::ChannelStatus(ChannelStatusSnapshot {
                            state: ChannelStatus::Failed,
                            ..
                        })
                    )),
                    "player {who} should not fail unroll recognition: {:?}",
                    ui.notifications
                );
                for game_id in [GameID(1), GameID(3)] {
                    let terminal_count = ui
                        .notifications
                        .iter()
                        .filter(|notification| {
                            matches!(
                                notification,
                                GameNotification::GameSettled { id, .. } if *id == game_id
                            )
                        })
                        .count();
                    assert_eq!(
                        terminal_count, 1,
                        "player {who} should receive exactly one terminal event for {game_id:?}: {:?}",
                        ui.notifications
                    );
                }
            }
        }));

        res.push(("test_krunk_player_0_picker_cached_nil_redo_id_1", &|| {
            run_cached_nil_redo_case(0, GameID(1));
        }));

        res.push(("test_krunk_player_1_picker_cached_nil_redo_id_3", &|| {
            run_cached_nil_redo_case(1, GameID(3));
        }));

        res.push((
            "test_krunk_nil_queued_during_channel_spend_executes_once",
            &|| {
                let picker = 0;
                let game_id = GameID(1);
                let mut allocator = AllocEncoder::new();
                let mut round = first_wrong_guess_moves(&mut allocator, game_id, picker);
                let nil_move = round.pop().expect("nil clue");
                let mut moves = vec![
                    SimScriptAction::ProposeKrunkGroup(0, ProposeTrigger::Channel),
                    SimScriptAction::AcceptProposal(1, GameID(1)),
                ];
                moves.extend(round);
                moves.push(SimScriptAction::GoOnChain(picker));
                moves.push(nil_move);
                moves.push(SimScriptAction::WaitBlocks(45, 0));
                assert_single_scripted_nil(&moves, picker, game_id);

                let outcome = run_krunk_container_with_action_list_with_success_predicate(
                    &mut allocator,
                    &moves,
                    None,
                    None,
                )
                .expect("queued Krunk nil must transfer into on-chain execution");
                let notifications = &outcome.local_uis[picker].notifications;
                assert!(
                    !notifications.iter().any(|notification| matches!(
                        notification,
                        GameNotification::GameStatus {
                            id,
                            status: GameStatusKind::Replaying,
                            ..
                        } if *id == game_id
                    )),
                    "a newly queued move must not be labeled cached replay"
                );
                let move_coin = notifications
                    .iter()
                    .find_map(|notification| match notification {
                        GameNotification::GameStatus {
                            id,
                            status: GameStatusKind::OnChainMyTurn,
                            coin_id: Some(coin),
                            ..
                        } if *id == game_id => Some(coin),
                        _ => None,
                    })
                    .expect("queued move must first expose its actionable game coin");
                assert_eq!(
                    outcome.transaction_submission_count_for_coin(picker, move_coin),
                    1,
                    "queued nil must execute exactly once after phase transfer"
                );
                assert_eq!(
                    notifications
                        .iter()
                        .filter(|notification| matches!(
                            notification,
                            GameNotification::GameStatus {
                                id,
                                status: GameStatusKind::OnChainTheirTurn,
                                other_params: Some(params),
                                ..
                            } if *id == game_id && params.moved_by_us == Some(true)
                        ))
                        .count(),
                    1,
                    "queued nil must confirm exactly once without a second UI command"
                );
            },
        ));

        res.push((
            "test_phase_api_rejects_wrong_turn_and_queued_moves",
            &|| {
                let game_id = GameID(7);
                assert_phase_move_panics(
                    phase_for_move_validation(game_id, false, VecDeque::new()),
                    game_id,
                    "does not give us the turn",
                );
                let queued = GameAction::Move(
                    game_id,
                    ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80]))),
                    Hash::default(),
                );
                assert_phase_move_panics(
                    phase_for_move_validation(game_id, true, VecDeque::from([queued])),
                    game_id,
                    "already queued",
                );
            },
        ));

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
                Some(&|_, cradles| {
                    for cradle in cradles {
                        let has_unspent_timeout_claim = cradle
                            .snapshot_watched_coins()
                            .iter()
                            .filter_map(|coin| cradle.watched_coin(coin))
                            .any(|watched| {
                                watched.birthday.is_some()
                                    && watched.spent_confirmed_at.is_none()
                                    && watched.timeout_spend.is_some()
                            });
                        if cradle.channel_status_terminal() && has_unspent_timeout_claim {
                            assert!(
                                !cradle.is_fully_resolved(),
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
                        status: GameStatusKind::FinishingWaitingTimeout,
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
                        status: GameStatusKind::FinishingWaitingTimeout,
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
