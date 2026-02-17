use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_handler::game::Game;
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{AllocEncoder, Program, Sha256Input};
use crate::common::types::{Error, GameID};
use crate::peer_container::SynchronousGameCradle;
use crate::test_support::game::GameAction;

pub fn load_calpoker(allocator: &mut AllocEncoder, game_id: GameID) -> Result<Game, Error> {
    Game::new(
        allocator,
        game_id,
        "clsp/games/calpoker-v0/calpoker_include_calpoker_template.hex",
    )
}

fn selected_cards_to_bitfield(hand: &[usize], selected: &[usize]) -> u8 {
    hand.iter().enumerate().fold(0u8, |acc, (idx, card)| {
        if selected.contains(card) {
            acc | (1u8 << idx)
        } else {
            acc
        }
    })
}

pub fn prefix_test_moves(allocator: &mut AllocEncoder, v1: bool) -> Vec<GameAction> {
    let alice_word = b"0alice6789abcdef";
    let bob_seed = b"0bob456789abcdef";
    let alice_word_hash = Sha256Input::Bytes(alice_word)
        .hash()
        .to_clvm(allocator)
        .expect("should work");
    let bob_word = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(bob_seed))
        .expect("should work");
    let nil_move = Program::from_hex("80").expect("should build nil move");
    // Golden fixture for v1: choose exact card IDs, then derive bitfield by hand order.
    // Inputs to handler remain card lists; this bitfield check is only a fixture sanity check.
    // Runtime v1 fixture hands observed in the current deterministic path.
    let alice_v1_hand: [usize; 8] = [0, 7, 10, 11, 32, 36, 41, 49];
    let bob_v1_hand: [usize; 8] = [2, 6, 9, 13, 18, 19, 23, 47];
    // Keep parity with origin/main intent where v1 used bitfields:
    // alice=0x55 => positions [0,2,4,6], bob=0xaa => positions [1,3,5,7].
    let alice_v1_discards = vec![0usize, 10, 32, 41];
    let bob_v1_discards = vec![6usize, 13, 19, 47];
    let _alice_v1_discards_bitfield =
        selected_cards_to_bitfield(&alice_v1_hand, &alice_v1_discards);
    let _bob_v1_discards_bitfield = selected_cards_to_bitfield(&bob_v1_hand, &bob_v1_discards);
    if v1 {
        assert_eq!(_alice_v1_discards_bitfield, 0b0101_0101);
        assert_eq!(_bob_v1_discards_bitfield, 0b1010_1010);
    }
    let alice_picks = if v1 {
        alice_v1_discards.to_clvm(allocator)
    } else {
        [0, 1, 0, 1, 0, 1, 0, 1].to_clvm(allocator)
    }
    .expect("should work");
    let bob_picks = if v1 {
        bob_v1_discards.to_clvm(allocator)
    } else {
        [1, 0, 1, 0, 1, 0, 1, 0].to_clvm(allocator)
    }
    .expect("should work");
    let mut actions = vec![
        GameAction::Move(
            0,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, alice_word_hash).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            1,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, bob_word).expect("good"),
            )),
            true,
        ),
        // Alice's reveal of her card generating seed and her commit to discards.
        GameAction::Move(
            0,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, alice_picks).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            1,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, bob_picks).expect("good"),
            )),
            true,
        ),
    ];

    // v1 final move protocol semantics:
    // - local input can be nil (this is just the UX trigger)
    // - handler_e ignores local_move and emits curried NEXT_MOVE = salt+discards+selects
    // - handler_e also emits the precomputed SPLIT from handler_d
    if v1 {
        actions.push(GameAction::Move(
            0,
            ReadableMove::from_program(Rc::new(nil_move)),
            true,
        ));
    } else {
        // v0 final move is declared split amount.
        let win_move_200 = 200.to_clvm(allocator).expect("should work");
        actions.push(GameAction::Move(
            0,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, win_move_200).expect("good"),
            )),
            true,
        ));
    }

    actions
}

// TODO: Add a bit of infra: helper fnctions for testing move results, and GameRunOutcome

#[allow(clippy::type_complexity)]
pub fn calpoker_ran_all_the_moves_predicate(
    want_move_number: usize,
) -> Box<dyn Fn(usize, &[SynchronousGameCradle]) -> bool> {
    Box::new(move |move_number: usize, _: &[SynchronousGameCradle]| move_number >= want_move_number)
}

/// ----------------- Tests start here ------------------
#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::common::types::{Amount, Hash};
    use crate::games::calpoker::decode_calpoker_readable;
    use crate::games::calpoker::WinDirectionUser;
    use crate::games::calpoker::{CalpokerHandValue, CalpokerResult, RawCalpokerHandValue};
    use crate::games::calpoker_v1::decode_readable_card_choices as decode_v1_readable_card_choices;
    use crate::shutdown::BasicShutdownConditions;
    use crate::simulator::tests::potato_handler_sim::{
        run_calpoker_container_with_action_list,
        run_calpoker_container_with_action_list_with_success_predicate, GameRunOutcome,
    };
    use crate::simulator::tests::simenv::SimulatorEnvironment;
    use crate::test_support::game::GameActionResult;
    use log::debug;
    use rand::prelude::*;
    use rand_chacha::ChaCha8Rng;

    fn run_calpoker_play_test(
        allocator: &mut AllocEncoder,
        moves: &[GameAction],
    ) -> Result<Vec<GameActionResult>, Error> {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let game_id_data: Hash = rng.gen();
        let game_id = GameID::new(game_id_data.bytes().to_vec());
        let calpoker = load_calpoker(allocator, game_id).expect("should load");
        let contributions = [Amount::new(100), Amount::new(100)];

        let mut simenv = SimulatorEnvironment::new(allocator, &mut rng, &calpoker, &contributions)
            .expect("should get a sim env");

        simenv.play_game(moves)
    }

    fn extract_info_from_messages(
        game_results: &[GameActionResult],
    ) -> Result<ReadableMove, Error> {
        game_results
            .iter()
            .find_map(|x| {
                if let GameActionResult::MoveResult(_, _, Some(clvm_data), _) = x {
                    Some(clvm_data.clone())
                } else {
                    None
                }
            })
            .ok_or_else(|| Error::StrErr("no message payload found in game results".to_string()))
    }

    fn game_run_outcome_to_move_results(g: &GameRunOutcome) -> Vec<GameActionResult> {
        debug!("UI 0: {:?}", g.local_uis[0]);
        debug!("UI 1: {:?}", g.local_uis[1]);
        let mut output: Vec<GameActionResult> = Vec::new();

        let alice_iter = g.local_uis[0].opponent_moves.iter().enumerate();
        let bob_iter = g.local_uis[1].opponent_moves.iter().enumerate();
        let mut iters = [alice_iter, bob_iter];
        let mut who: usize = 1;

        #[allow(clippy::while_let_on_iterator)]
        while let Some((index, (_game_id, _state_number, readable_move, _amount))) =
            iters[who].next()
        {
            debug!("processing move {who} {index}: {readable_move:?}, g.local_uis[{who}].opponent_messages {:?}", g.local_uis[who].opponent_messages);
            let message = g.local_uis[who].opponent_messages.iter().find_map(|m| {
                if index + 1 == m.opponent_move_size {
                    return Some(m.opponent_message.clone());
                }

                None
            });
            output.push(GameActionResult::MoveResult(
                readable_move.clone(),
                Vec::new(),
                message,
                Hash::default(),
            ));
            who ^= 1;
        }

        output
    }

    fn assert_stayed_off_chain(outcome: &GameRunOutcome, test_name: &str) {
        for (who, ui) in outcome.local_uis.iter().enumerate() {
            assert!(
                !ui.go_on_chain,
                "{test_name}: player {who} unexpectedly entered on-chain mode; got_error={} finished={:?}",
                ui.got_error,
                ui.game_finished
            );
            assert!(
                !ui.got_error,
                "{test_name}: player {who} reported an on-chain/error transition; go_on_chain={} finished={:?}",
                ui.go_on_chain,
                ui.game_finished
            );
        }
    }

    pub fn test_funs() -> Vec<(&'static str, &'static dyn Fn())> {
        let mut res: Vec<(&'static str, &'static dyn Fn())> = Vec::new();
        res.push(("test_load_calpoker", &|| {
            let mut allocator = AllocEncoder::new();
            let seed: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed);
            let game_id_data: Hash = rng.gen();
            let game_id = GameID::new(game_id_data.bytes().to_vec());
            let calpoker = load_calpoker(&mut allocator, game_id).expect("should load");
            let contributions = [Amount::new(100), Amount::new(100)];

            let _simenv =
                SimulatorEnvironment::new(&mut allocator, &mut rng, &calpoker, &contributions)
                    .expect("should get a sim env");
        }));

        res.push(("test_play_calpoker_happy_path_v0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, false).to_vec();
            let outcome = run_calpoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                false,
                Some(&calpoker_ran_all_the_moves_predicate(moves.len())),
            )
            .expect("test");
            assert_stayed_off_chain(&outcome, "test_play_calpoker_happy_path_v0");
        }));

        res.push(("test_play_calpoker_happy_path_v1", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, true).to_vec();
            let result = run_calpoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                true,
                Some(&calpoker_ran_all_the_moves_predicate(moves.len())),
            );
            match result {
                Ok(outcome) => {
                    assert_stayed_off_chain(&outcome, "test_play_calpoker_happy_path_v1");
                }
                Err(e) => {
                    panic!("v1 happy path failed; scripted moves={moves:?}; error={e:?}",);
                }
            }
        }));

        res.push(("test_v1_fixture_revealed_hands_match", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator, true).to_vec();
            moves.truncate(2);
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves, true)
                    .expect("v1 opening moves should complete");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let revealed_cards = extract_info_from_messages(&game_results)
                .expect("expected v1 revealed message payload");
            let (alice_cards, bob_cards) =
                decode_v1_readable_card_choices(&mut allocator, revealed_cards)
                    .expect("should decode v1 revealed cards");

            assert_eq!(alice_cards, vec![0usize, 7, 10, 11, 32, 36, 41, 49,]);
            assert_eq!(bob_cards, vec![2usize, 6, 9, 13, 18, 19, 23, 47,]);
        }));
        res.push(("test_v1_opening_parity_with_main_vectors", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, true).to_vec();
            assert!(moves.len() >= 2, "expected at least two opening moves");

            let expected_alice_commit = {
                let n = Sha256Input::Bytes(b"0alice6789abcdef")
                    .hash()
                    .to_clvm(&mut allocator)
                    .expect("should build alice commit");
                Program::from_nodeptr(&mut allocator, n).expect("should build alice commit program")
            };
            let expected_bob_seed = {
                let n = allocator
                    .encode_atom(clvm_traits::Atom::Borrowed(b"0bob456789abcdef"))
                    .expect("should build bob seed atom");
                Program::from_nodeptr(&mut allocator, n).expect("should build bob seed program")
            };

            match &moves[0] {
                GameAction::Move(player, readable_move, _) => {
                    assert_eq!(*player, 0, "opening move 1 should be Alice");
                    assert_eq!(
                        readable_move.to_program().to_hex(),
                        expected_alice_commit.to_hex()
                    );
                }
                other => panic!("unexpected opening action #1: {other:?}"),
            }
            match &moves[1] {
                GameAction::Move(player, readable_move, _) => {
                    assert_eq!(*player, 1, "opening move 2 should be Bob");
                    assert_eq!(
                        readable_move.to_program().to_hex(),
                        expected_bob_seed.to_hex()
                    );
                }
                other => panic!("unexpected opening action #2: {other:?}"),
            }

            let mut opening_moves = moves[..2].to_vec();
            opening_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            opening_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &opening_moves, true)
                    .expect("v1 opening moves should complete");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let revealed_cards = extract_info_from_messages(&game_results)
                .expect("expected v1 revealed message payload");
            let (alice_cards, bob_cards) =
                decode_v1_readable_card_choices(&mut allocator, revealed_cards)
                    .expect("should decode v1 revealed cards");

            assert_eq!(alice_cards, vec![0usize, 7, 10, 11, 32, 36, 41, 49,]);
            assert_eq!(bob_cards, vec![2usize, 6, 9, 13, 18, 19, 23, 47,]);
        }));
        res.push(("test_v1_discard_to_bitfield_parity_with_main", &|| {
            // Preserve parity with historical main vectors where v1 discards were represented as 0x55 and 0xaa.
            let alice_hand: [usize; 8] = [0, 7, 10, 11, 32, 36, 41, 49];
            let bob_hand: [usize; 8] = [2, 6, 9, 13, 18, 19, 23, 47];
            let alice_discards = [0usize, 10, 32, 41];
            let bob_discards = [6usize, 13, 19, 47];

            assert!(
                alice_discards.iter().all(|c| alice_hand.contains(c)),
                "alice discard cards must be members of alice hand"
            );
            assert!(
                bob_discards.iter().all(|c| bob_hand.contains(c)),
                "bob discard cards must be members of bob hand"
            );

            let alice_bits = selected_cards_to_bitfield(&alice_hand, &alice_discards);
            let bob_bits = selected_cards_to_bitfield(&bob_hand, &bob_discards);
            assert_eq!(
                alice_bits, 0x55,
                "alice discards should map to bitfield 0x55"
            );
            assert_eq!(bob_bits, 0xaa, "bob discards should map to bitfield 0xaa");
        }));

        res.push(("test_verify_endgame_data_v0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, false);
            let game_action_results =
                run_calpoker_play_test(&mut allocator, &moves).expect("should work");
            debug!("play_result {game_action_results:?}");
            if let GameActionResult::MoveResult(penultimate_game_data, _, _, _) =
                game_action_results[game_action_results.len() - 1].clone()
            {
                let is_bob_move: bool = true;
                let readable_node = penultimate_game_data
                    .to_nodeptr(&mut allocator)
                    .expect("failed to convert to nodepointer");
                let decoded = decode_calpoker_readable(
                    &mut allocator,
                    readable_node,
                    Amount::new(200),
                    is_bob_move,
                )
                .expect("should work");
                // decoded is a description of Alice's result, from Bob's point of view
                // Bob won this game
                // Bob should get a reward coin for 200
                // Alice should get 0
                assert_eq!(
                    decoded,
                    CalpokerResult {
                        raw_alice_selects: 170, // me.raw_selects
                        raw_bob_picks: 205,
                        raw_alice_picks: 185,
                        alice_hand_result: CalpokerHandValue::TwoPair(4, 2, 12),
                        alice_hand_value: RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 4, 2, 12]),
                        bob_hand_result: CalpokerHandValue::Pair(3, vec![3, 14, 13, 11]),
                        bob_hand_value: RawCalpokerHandValue::SimpleList(vec![
                            2, 1, 1, 1, 3, 14, 13, 11
                        ]),
                        your_share: 200,
                        game_amount: 200,
                        raw_win_direction: 1,
                        win_direction: Some(WinDirectionUser::Alice),
                    }
                );
            } else {
                panic!("{:?}", game_action_results);
            };
        }));
        res.push(("test_verify_bob_message_v0", &|| {
            // Ensure the bytes being passed on are structured correctly
            // Verify message decoding
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves, false)
                    .expect("should work");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let bob_clvm_data =
                extract_info_from_messages(&game_results).expect("expected v0 message payload");
            assert_ne!(bob_clvm_data.to_program().to_hex(), "80");
            debug!("play_result {game_results:?}");
        }));
        res.push(("test_verify_bob_message", &|| {
            // Ensure the bytes being passed on are structured correctly
            // Verify message decoding
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator, true).to_vec();
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves, true)
                    .expect("should work");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let bob_clvm_data =
                extract_info_from_messages(&game_results).expect("expected v1 message payload");
            assert_ne!(bob_clvm_data.to_program().to_hex(), "80");
            debug!("play_result {game_results:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_1_move_p1_v0", &|| {
            let mut allocator = AllocEncoder::new();

            // Make a prototype go on chain scenario by starting with move 1.
            // The second player receives the move, and then observes the first player
            // going on chain.
            let moves = prefix_test_moves(&mut allocator, false);
            let mut on_chain_moves_1: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves_1.push(GameAction::GoOnChain(true as usize));
            let test2 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_1).expect("should work");
            debug!("play_result {test2:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_1_move_p1", &|| {
            let mut allocator = AllocEncoder::new();

            // Make a prototype go on chain scenario by starting with move 1.
            // The second player receives the move, and then observes the first player
            // going on chain.
            let moves = prefix_test_moves(&mut allocator, true);
            let mut on_chain_moves_1: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves_1.push(GameAction::GoOnChain(true as usize));
            let test2 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_1).expect("should work");
            debug!("play_result {test2:?}");
        }));
        res.push((
            "test_play_calpoker_on_chain_after_1_move_p0_lost_message_v0",
            &|| {
                let mut allocator = AllocEncoder::new();
                let moves = prefix_test_moves(&mut allocator, false);
                let mut on_chain_moves_2: Vec<GameAction> =
                    moves.into_iter().take(1).map(|x| x.lose()).collect();
                on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
                let test3 =
                    run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
                debug!("play_result {test3:?}");
            },
        ));
        res.push((
            "test_play_calpoker_on_chain_after_1_move_p0_lost_message",
            &|| {
                let mut allocator = AllocEncoder::new();
                let moves = prefix_test_moves(&mut allocator, true);
                let mut on_chain_moves_2: Vec<GameAction> =
                    moves.into_iter().take(1).map(|x| x.lose()).collect();
                on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
                let test3 =
                    run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
                debug!("play_result {test3:?}");
            },
        ));
        res.push(("test_play_calpoker_on_chain_after_1_move_p0_v0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, false);
            let mut on_chain_moves_2: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
            let test3 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
            debug!("play_result {test3:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_1_move_p0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, true);
            let mut on_chain_moves_2: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
            let test3 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
            debug!("play_result {test3:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_2_moves_p0_v0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, false);
            // Alice moves, then bob, then bob spends the channel coin.
            let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves_3.push(GameAction::GoOnChain(false as usize));
            let test4 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_3).expect("should work");
            debug!("play_result {test4:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_2_moves_p0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, true);
            // Alice moves, then bob, then bob spends the channel coin.
            let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves_3.push(GameAction::GoOnChain(false as usize));
            let test4 =
                run_calpoker_play_test(&mut allocator, &on_chain_moves_3).expect("should work");
            debug!("play_result {test4:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_2_moves_p1_v0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, false);
            // Alice moves, then bob, then bob spends the channel coin.
            let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves_3.push(GameAction::GoOnChain(true as usize));
            let test4 = run_calpoker_play_test(&mut allocator, &on_chain_moves_3);
            assert!(test4.is_err());
            assert!(format!("{:?}", test4).contains("from the past"));
            debug!("play_result {test4:?}");
        }));
        res.push(("test_play_calpoker_on_chain_after_2_moves_p1", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator, true);
            // Alice moves, then bob, then bob spends the channel coin.
            let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves_3.push(GameAction::GoOnChain(true as usize));
            let test4 = run_calpoker_play_test(&mut allocator, &on_chain_moves_3);
            assert!(test4.is_err());
            assert!(format!("{:?}", test4).contains("from the past"));
            debug!("play_result {test4:?}");
        }));
        res.push(("test_play_calpoker_end_game_reward_v0", &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            moves.push(GameAction::Accept(1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));

            debug!("running moves {moves:?}");
            let _game_action_results =
                run_calpoker_play_test(&mut allocator, &moves).expect("should work");
        }));
        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;

// Bram: slashing tests
//
// I think this is a decent list of slashing tests: Alice attempts to give
// herself too much with honest cards and Bob successfully slashes with honest
// cards. Alice attempts to give herself too much with bad cards and Bob
// successfully slashes with honest cards. Alice gives herself an honest amount
// and Bob fails to slash with honest cards. Alice gives herself an honest
// amount and Bob fails to slash with bad cards. That's four tests which should
// be run each with the Alice wins, Bob wins, and tie scenarios with the caveat
// that Alice can't 'cheat' when she's already supposed to win everything and
// Bob can't cheat when he's supposed to win everything. We can fuzz to find the
// three hands then inspect manually to sanity check the hand evals and find bad
// cards
//
// Test that we can't move off chain when validation puzzle hash is nil.
//
// Move without receive
//
// Also have to test forcing an out of date version on chain which requires some behavior which the code can't be prompted to do
//
// About game creation:
//
// give game parameters to factory.
// start game info: parameters should be included here as well
//
// factory produces initial move, initial share etc.
//
// Pass parameters over the wire instead of outputs to game factory.
//
// Pass game handler its own mod hash.
