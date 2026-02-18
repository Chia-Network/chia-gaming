use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_handler::types::ReadableMove;
use crate::common::types::{AllocEncoder, Program, Sha256Input};
use crate::peer_container::SynchronousGameCradle;
use crate::test_support::game::GameAction;

fn selected_cards_to_bitfield(hand: &[usize], selected: &[usize]) -> u8 {
    hand.iter().enumerate().fold(0u8, |acc, (idx, card)| {
        if selected.contains(card) {
            acc | (1u8 << idx)
        } else {
            acc
        }
    })
}

pub fn prefix_test_moves(allocator: &mut AllocEncoder) -> Vec<GameAction> {
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
    // Golden fixture: choose exact card IDs, then derive bitfield by hand order.
    // Runtime fixture hands observed in the current deterministic path.
    let alice_hand: [usize; 8] = [0, 7, 10, 11, 32, 36, 41, 49];
    let bob_hand: [usize; 8] = [2, 6, 9, 13, 18, 19, 23, 47];
    // alice=0x55 => positions [0,2,4,6], bob=0xaa => positions [1,3,5,7].
    let alice_discards = vec![0usize, 10, 32, 41];
    let bob_discards = vec![6usize, 13, 19, 47];
    assert_eq!(selected_cards_to_bitfield(&alice_hand, &alice_discards), 0b0101_0101);
    assert_eq!(selected_cards_to_bitfield(&bob_hand, &bob_discards), 0b1010_1010);
    let alice_picks = alice_discards.to_clvm(allocator).expect("should work");
    let bob_picks = bob_discards.to_clvm(allocator).expect("should work");
    vec![
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
        // Final move: local input can be nil (just a UX trigger).
        // handler_e ignores local_move and emits curried NEXT_MOVE = salt+discards+selects
        // handler_e also emits the precomputed SPLIT from handler_d
        GameAction::Move(
            0,
            ReadableMove::from_program(Rc::new(nil_move)),
            true,
        ),
    ]
}

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

    use crate::common::types::Error;
    use crate::common::types::Hash;
    use crate::games::calpoker::decode_readable_card_choices;
    use crate::games::calpoker::{
        decode_calpoker_readable,
        RawCalpokerHandValue as RawCalpokerHandValueV1,
    };
    use crate::shutdown::BasicShutdownConditions;
    use crate::simulator::tests::potato_handler_sim::{
        run_calpoker_container_with_action_list,
        run_calpoker_container_with_action_list_with_success_predicate, GameRunOutcome,
    };
    use crate::test_support::game::GameActionResult;
    use log::debug;

    fn extract_info_from_messages(game_results: &[GameActionResult]) -> Result<ReadableMove, Error> {
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

        res.push(("test_play_calpoker_happy_path", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator).to_vec();
            let result = run_calpoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&calpoker_ran_all_the_moves_predicate(moves.len())),
            );
            match result {
                Ok(outcome) => {
                    assert_stayed_off_chain(&outcome, "test_play_calpoker_happy_path");
                }
                Err(e) => {
                    panic!("happy path failed; scripted moves={moves:?}; error={e:?}");
                }
            }
        }));

        res.push(("test_fixture_revealed_hands_match", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.truncate(2);
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves)
                    .expect("opening moves should complete");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let revealed_cards = extract_info_from_messages(&game_results)
                .expect("expected revealed message payload");
            let (alice_cards, bob_cards) =
                decode_readable_card_choices(&mut allocator, revealed_cards)
                    .expect("should decode revealed cards");

            assert_eq!(alice_cards, vec![0usize, 7, 10, 11, 32, 36, 41, 49]);
            assert_eq!(bob_cards, vec![2usize, 6, 9, 13, 18, 19, 23, 47]);
        }));

        res.push(("test_opening_parity_with_main_vectors", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator).to_vec();
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
                    assert_eq!(readable_move.to_program().to_hex(), expected_alice_commit.to_hex());
                }
                other => panic!("unexpected opening action #1: {other:?}"),
            }
            match &moves[1] {
                GameAction::Move(player, readable_move, _) => {
                    assert_eq!(*player, 1, "opening move 2 should be Bob");
                    assert_eq!(readable_move.to_program().to_hex(), expected_bob_seed.to_hex());
                }
                other => panic!("unexpected opening action #2: {other:?}"),
            }

            let mut opening_moves = moves[..2].to_vec();
            opening_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            opening_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &opening_moves)
                    .expect("opening moves should complete");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let revealed_cards = extract_info_from_messages(&game_results)
                .expect("expected revealed message payload");
            let (alice_cards, bob_cards) =
                decode_readable_card_choices(&mut allocator, revealed_cards)
                    .expect("should decode revealed cards");

            assert_eq!(alice_cards, vec![0usize, 7, 10, 11, 32, 36, 41, 49]);
            assert_eq!(bob_cards, vec![2usize, 6, 9, 13, 18, 19, 23, 47]);
        }));

        res.push(("test_discard_to_bitfield_parity_with_main", &|| {
            let alice_hand: [usize; 8] = [0, 7, 10, 11, 32, 36, 41, 49];
            let bob_hand: [usize; 8] = [2, 6, 9, 13, 18, 19, 23, 47];
            let alice_discards = [0usize, 10, 32, 41];
            let bob_discards = [6usize, 13, 19, 47];

            assert!(alice_discards.iter().all(|c| alice_hand.contains(c)));
            assert!(bob_discards.iter().all(|c| bob_hand.contains(c)));

            let alice_bits = selected_cards_to_bitfield(&alice_hand, &alice_discards);
            let bob_bits = selected_cards_to_bitfield(&bob_hand, &bob_discards);
            assert_eq!(alice_bits, 0x55, "alice discards should map to bitfield 0x55");
            assert_eq!(bob_bits, 0xaa, "bob discards should map to bitfield 0xaa");
        }));

        res.push(("test_verify_endgame_data", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.push(GameAction::Accept(1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves)
                    .expect("game should complete");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            debug!("endgame game_results count={}", game_results.len());

            let revealed_cards = extract_info_from_messages(&game_results)
                .expect("expected revealed message payload");
            let (alice_mod52, bob_mod52) =
                decode_readable_card_choices(&mut allocator, revealed_cards)
                    .expect("should decode revealed cards");
            assert_eq!(alice_mod52, vec![0, 7, 10, 11, 32, 36, 41, 49]);
            assert_eq!(bob_mod52, vec![2, 6, 9, 13, 18, 19, 23, 47]);

            let last_result = &game_results[game_results.len() - 1];
            if let GameActionResult::MoveResult(readable_data, _, _, _) = last_result {
                let readable_node = readable_data
                    .to_nodeptr(&mut allocator)
                    .expect("failed to convert to nodeptr");
                let decoded = decode_calpoker_readable(
                    &mut allocator,
                    readable_node,
                    false,
                    0xaa,
                    &alice_mod52,
                    &bob_mod52,
                )
                .expect("should decode readable");
                debug!("decoded outcome: {decoded:?}");

                assert!(
                    decoded.alice_hand_value != RawCalpokerHandValueV1::SimpleList(vec![]),
                    "alice hand value should not be empty"
                );
                assert!(
                    decoded.bob_hand_value != RawCalpokerHandValueV1::SimpleList(vec![]),
                    "bob hand value should not be empty"
                );
                assert!(
                    decoded.win_direction.is_some(),
                    "there should be a winner (not a tie with these seeds)"
                );
                assert_eq!(decoded.alice_final_hand.len(), 5, "alice should have 5-card hand");
                assert_eq!(decoded.bob_final_hand.len(), 5, "bob should have 5-card hand");
            } else {
                panic!("expected MoveResult for final game action, got: {:?}", last_result);
            }
        }));

        res.push(("test_verify_bob_message", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves)
                    .expect("should work");
            let game_results = game_run_outcome_to_move_results(&game_outcome);
            let bob_clvm_data =
                extract_info_from_messages(&game_results).expect("expected message payload");
            assert_ne!(bob_clvm_data.to_program().to_hex(), "80");
            debug!("play_result {game_results:?}");
        }));

        res.push(("test_play_calpoker_on_chain_after_1_move_p1", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves.push(GameAction::GoOnChain(true as usize));
            on_chain_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            on_chain_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome =
                run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                    .expect("should work");
            debug!("play_result {:?}", outcome.local_uis);
        }));

        res.push(("test_play_calpoker_on_chain_after_1_move_p0_lost_message", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> =
                moves.into_iter().take(1).map(|x| x.lose()).collect();
            on_chain_moves.push(GameAction::GoOnChain(true as usize));
            on_chain_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            on_chain_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome =
                run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                    .expect("should work");
            debug!("play_result {:?}", outcome.local_uis);
        }));

        res.push(("test_play_calpoker_on_chain_after_1_move_p0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(1).collect();
            on_chain_moves.push(GameAction::GoOnChain(true as usize));
            on_chain_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            on_chain_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome =
                run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                    .expect("should work");
            debug!("play_result {:?}", outcome.local_uis);
        }));

        res.push(("test_play_calpoker_on_chain_after_2_moves_p0", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves.push(GameAction::GoOnChain(false as usize));
            on_chain_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            on_chain_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome =
                run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                    .expect("should work");
            debug!("play_result {:?}", outcome.local_uis);
        }));

        res.push(("test_play_calpoker_on_chain_after_2_moves_p1", &|| {
            let mut allocator = AllocEncoder::new();
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves.push(GameAction::GoOnChain(true as usize));
            on_chain_moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            on_chain_moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome =
                run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                    .expect("should work");
            debug!("play_result {:?}", outcome.local_uis);
        }));

        res.push(("test_play_calpoker_end_game_reward", &|| {
            let mut allocator = AllocEncoder::new();
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.push(GameAction::Accept(1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));

            debug!("running moves {moves:?}");
            let game_outcome =
                run_calpoker_container_with_action_list(&mut allocator, &moves)
                    .expect("end game reward should work");
            assert_stayed_off_chain(&game_outcome, "test_play_calpoker_end_game_reward");
        }));

        res
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::test_funs;
