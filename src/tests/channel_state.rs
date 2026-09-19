use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_state::types::{
    read_unroll_puzzle, ChannelEnv, UnrollCoin, UnrollCoinConditionInputs,
};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{
    get_standard_coin_puzzle, private_to_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{AllocEncoder, Amount, Hash, Puzzle, Sha256tree};

#[cfg(feature = "sim-tests")]
pub(crate) mod sim_tests {
    use super::*;
    use std::rc::Rc;

    use clvm_traits::ToClvm;

    use crate::channel_state::game_handler::GameHandler;
    use crate::channel_state::game_start_info::GameStartInfo;
    use crate::channel_state::types::{HistoricalUnrollSpendInfo, ValidationProgramRegistry};
    use crate::common::types::{
        aggregate_wallet_fee_bundle, Aggsig, CoinCondition, CoinID, CoinSpend, CoinString, GameID,
        Program, PuzzleHash, Spend, SpendBundle, Timeout, ToQuotedProgram,
    };
    use crate::test_support::sim_script::{ChannelHandlerGame, DEFAULT_UNROLL_TIME_LOCK};

    /// Helper: create a ChannelHandlerGame with completed handshake.
    fn setup_handshake(rng: &mut impl rand::Rng, env: &mut ChannelEnv<'_>) -> ChannelHandlerGame {
        let game_id = GameID(42);
        let launcher_coin = CoinID::default();

        let mut game = ChannelHandlerGame::new(
            rng,
            env,
            game_id,
            &launcher_coin,
            &[Amount::new(100), Amount::new(100)],
            (*DEFAULT_UNROLL_TIME_LOCK).clone(),
        )
        .expect("should build");

        game.finish_handshake(env, 1).expect("finish_handshake(1)");
        game.finish_handshake(env, 0).expect("finish_handshake(0)");
        game
    }

    fn assert_real_preemption_accepts_fee(env: &mut ChannelEnv<'_>, transaction: Spend) {
        let protocol_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([0xa1; 32])),
            &transaction.puzzle.sha256tree(env.allocator),
            &Amount::new(200),
        );
        let target = protocol_coin.to_coin_id();
        let protocol = SpendBundle {
            name: Some("real unroll preemption".to_string()),
            spends: vec![CoinSpend {
                coin: protocol_coin,
                bundle: transaction,
            }],
        };
        let fee_conditions = vec![
            (
                51_u8,
                (PuzzleHash::from_bytes([0xa2; 32]), (Amount::new(90), ())),
            )
                .to_clvm(env.allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(10), ()))
                .to_clvm(env.allocator)
                .expect("fee RESERVE_FEE"),
            (64_u8, (target.clone(), ()))
                .to_clvm(env.allocator)
                .expect("fee ASSERT_CONCURRENT_SPEND"),
        ];
        let conditions = fee_conditions
            .to_clvm(env.allocator)
            .expect("fee conditions");
        let puzzle: Puzzle = conditions
            .to_quoted_program(env.allocator)
            .expect("quoted fee puzzle")
            .into();
        let fee_bundle = SpendBundle {
            name: None,
            spends: vec![CoinSpend {
                coin: CoinString::from_parts(
                    &CoinID::new(Hash::from_bytes([0xa3; 32])),
                    &puzzle.sha256tree(env.allocator),
                    &Amount::new(100),
                ),
                bundle: Spend {
                    puzzle,
                    solution: Program::nil().into(),
                    signature: Aggsig::default(),
                },
            }],
        };

        aggregate_wallet_fee_bundle(
            protocol.clone(),
            fee_bundle.clone(),
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect("real unroll preemption accepts canonical fee aggregation");

        let mut invalid = protocol;
        invalid.spends[0].bundle.signature = Aggsig::default();
        let error = aggregate_wallet_fee_bundle(
            invalid,
            fee_bundle,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("invalid preemption signature must fail");
        assert!(format!("{error:?}").contains("invalid aggregate signature"));
    }

    fn setup_split_genesis_handshake(
        rng: &mut impl rand::Rng,
        env: &mut ChannelEnv<'_>,
    ) -> ChannelHandlerGame {
        let game_id = GameID(42);
        let launcher_coin = CoinID::default();
        let mut game = ChannelHandlerGame::new(
            rng,
            env,
            game_id,
            &launcher_coin,
            &[Amount::new(100), Amount::new(100)],
            (*DEFAULT_UNROLL_TIME_LOCK).clone(),
        )
        .expect("should build");

        assert!(!game.player(0).ch.have_potato());
        assert!(!game.player(1).ch.have_potato());

        let state_zero_signatures = game
            .player(1)
            .ch
            .get_initial_signatures()
            .expect("receiver state 0 signatures");
        let genesis = game
            .player(0)
            .ch
            .initialize_genesis_as_initiator(env, &state_zero_signatures)
            .expect("initiator establishes genesis states");
        game.player(1)
            .ch
            .initialize_genesis_as_receiver(env, &genesis.state_one_signatures)
            .expect("receiver establishes genesis state 1");
        game
    }

    #[test]
    fn later_member_failure_leaves_proposal_acceptance_unchanged() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([16; 32]);
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("referee puzzle");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("standard puzzle");
        let mut env = ChannelEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };
        let mut party = ChannelHandlerGame::new(
            &mut rng,
            &mut env,
            GameID(42),
            &CoinID::default(),
            &[Amount::new(100), Amount::new(100)],
            (*DEFAULT_UNROLL_TIME_LOCK).clone(),
        )
        .expect("channel");
        let proposal = crate::session_phases::proposal::GameProposal {
            sender_is_player_a: true,
            game_type: crate::common::types::GameType::from_hash(Hash::default()),
            timeout: Timeout::new(15),
            parameters: crate::session_phases::proposal::ProposalParameters::Null,
        };
        let local_id = party
            .player(0)
            .ch
            .create_outgoing_proposal(&proposal)
            .unwrap();
        let validator = Rc::new(Program::from_bytes(&[0x01]).expect("quoted validator"));
        let registry =
            ValidationProgramRegistry::new(env.allocator, &[validator]).expect("registry");
        let start = |id, initial_max_move_size| {
            Rc::new(GameStartInfo {
                amount: Amount::new(20),
                game_handler: GameHandler::MyTurnHandler(Program::nil().into()),
                player_a_contribution: Amount::new(10),
                player_b_contribution: Amount::new(10),
                my_contribution_this_game: Amount::new(10),
                their_contribution_this_game: Amount::new(10),
                validation_programs: registry.clone(),
                initial_state: Program::nil().into(),
                initial_move: vec![],
                initial_max_move_size,
                initial_mover_share: Amount::default(),
                game_id: GameID(id),
                timeout: Timeout::new(15),
            })
        };
        let starts = [start(0, 32), start(1, usize::MAX)];
        let before =
            bencodex::to_vec(&party.player(0).ch).expect("serialize channel before acceptance");

        let result = party
            .player(0)
            .ch
            .accept_proposal_games(&mut env, local_id, &starts, true);

        assert!(result.is_err(), "later invalid member must fail acceptance");
        let channel = &party.player(0).ch;
        assert_eq!(
            bencodex::to_vec(channel).expect("serialize channel after failed acceptance"),
            before,
            "failed acceptance changed channel state",
        );
        assert!(
            channel.is_proposal_pending(local_id),
            "proposal ledger changed"
        );
        assert_eq!(
            channel.next_game_id_for_testing(),
            GameID(0),
            "IDs advanced"
        );
        assert_eq!(
            (
                channel.my_out_of_game_balance(),
                channel.their_out_of_game_balance(),
                channel.my_allocated_balance(),
                channel.their_allocated_balance(),
            ),
            (
                Amount::new(100),
                Amount::new(100),
                Amount::default(),
                Amount::default(),
            ),
            "balances changed",
        );
        assert!(channel.live_game_ids().is_empty(), "live games changed");
        assert!(
            channel.pending_proposal_accept_game_ids().is_empty(),
            "redo entries changed"
        );
    }

    /// Helper: perform one full round-trip of empty potato exchanges.
    /// Player `sender` sends first, then `sender^1` sends back.
    fn empty_potato_round_trip(
        game: &mut ChannelHandlerGame,
        env: &mut ChannelEnv<'_>,
        sender: usize,
    ) {
        let sigs_a = game
            .player(sender)
            .ch
            .send_empty_potato(env)
            .expect("send_empty_potato");
        game.player(sender ^ 1)
            .ch
            .received_empty_potato(env, &sigs_a)
            .expect("received_empty_potato");

        let sigs_b = game
            .player(sender ^ 1)
            .ch
            .send_empty_potato(env)
            .expect("send_empty_potato");
        game.player(sender)
            .ch
            .received_empty_potato(env, &sigs_b)
            .expect("received_empty_potato");
    }

    /// Build a minimal CLVM conditions list containing a CREATE_COIN with
    /// the unroll puzzle hash for the given state number.  Looks up the
    /// puzzle hash from the handler's map.
    fn make_conditions_for_state(
        env: &mut ChannelEnv<'_>,
        handler: &crate::channel_state::ChannelState,
        state_number: usize,
    ) -> clvmr::NodePtr {
        use crate::common::constants::CREATE_COIN;
        use crate::common::types::Node;

        let ph = handler
            .unroll_puzzle_hash_map()
            .iter()
            .find_map(|(ph, info)| {
                if info.state_number == state_number {
                    Some(ph.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| panic!("no puzzle hash in map for state {state_number}"));

        let amount = Amount::new(200);
        let cond = (CREATE_COIN, (ph, (amount, ())));
        (Node(cond.to_clvm(env.allocator).expect("clvm")), ())
            .to_clvm(env.allocator)
            .expect("should build conditions")
    }

    fn payout_conditions_for_state(
        env: &mut ChannelEnv<'_>,
        handler: &crate::channel_state::ChannelState,
        state_number: usize,
    ) -> Vec<(crate::common::types::PuzzleHash, Amount)> {
        let historical = handler
            .unroll_puzzle_hash_map()
            .values()
            .find(|info| info.state_number == state_number)
            .unwrap_or_else(|| panic!("no historical unroll for state {state_number}"));
        let conditions = historical
            .timeout_conditions
            .to_nodeptr(env.allocator)
            .expect("timeout conditions");
        CoinCondition::from_nodeptr(env.allocator, conditions)
            .expect("parse timeout conditions")
            .into_iter()
            .filter_map(|condition| match condition {
                CoinCondition::CreateCoin(puzzle_hash, amount) => Some((puzzle_hash, amount)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn split_genesis_states_have_same_payout_and_state_one_preempts_zero() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([14; 32]);
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
        let mut env = ChannelEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };

        let game = setup_split_genesis_handshake(&mut rng, &mut env);
        let initiator = &game.players[0].ch;
        let receiver = &game.players[1].ch;
        assert_eq!(initiator.state_number(), 1);
        assert_eq!(receiver.state_number(), 1);
        assert!(!initiator.have_potato());
        assert!(receiver.have_potato());
        assert_eq!(initiator.unroll_target_state_number(), Some(0));
        assert_eq!(receiver.unroll_target_state_number(), Some(1));
        assert_eq!(
            payout_conditions_for_state(&mut env, initiator, 0),
            payout_conditions_for_state(&mut env, receiver, 1),
        );
        assert_eq!(receiver.preempting_state_number_for(0), Some(1));

        let state_zero = make_conditions_for_state(&mut env, receiver, 0);
        let result = receiver
            .channel_coin_spent(&mut env, state_zero)
            .expect("state 1 should preempt genesis");
        assert!(!result.timeout);
        assert_eq!(result.unrolling_state_number, 0);
    }

    #[test]
    fn receiver_genesis_failure_restores_pre_genesis_ownership() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([15; 32]);
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
        let mut env = ChannelEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };

        let game_id = GameID(42);
        let launcher_coin = CoinID::default();
        let mut game = ChannelHandlerGame::new(
            &mut rng,
            &mut env,
            game_id,
            &launcher_coin,
            &[Amount::new(100), Amount::new(100)],
            (*DEFAULT_UNROLL_TIME_LOCK).clone(),
        )
        .expect("should build");
        assert!(!game.player(1).ch.have_potato());

        let state_zero_signatures = game
            .player(1)
            .ch
            .get_initial_signatures()
            .expect("receiver state 0 signatures");
        let genesis = game
            .player(0)
            .ch
            .initialize_genesis_as_initiator(&mut env, &state_zero_signatures)
            .expect("initiator establishes genesis states");
        let mut invalid = genesis.state_one_signatures.clone();
        invalid.channel_half_sig = Aggsig::default();

        assert!(game
            .player(1)
            .ch
            .initialize_genesis_as_receiver(&mut env, &invalid)
            .is_err());
        assert_eq!(game.player(1).ch.state_number(), 0);
        assert!(!game.player(1).ch.have_potato());

        game.player(1)
            .ch
            .initialize_genesis_as_receiver(&mut env, &genesis.state_one_signatures)
            .expect("valid retry succeeds after rollback");
        assert_eq!(game.player(1).ch.state_number(), 1);
        assert!(game.player(1).ch.have_potato());
    }

    #[test]
    fn unroll_target_is_one_behind_after_sending_the_potato() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
        let mut env = ChannelEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };

        let mut game = setup_handshake(&mut rng, &mut env);
        let first_sender = if game.player(0).ch.have_potato() {
            0
        } else {
            1
        };
        empty_potato_round_trip(&mut game, &mut env, first_sender);

        let sender = if game.player(0).ch.have_potato() {
            0
        } else {
            1
        };
        let receiver = sender ^ 1;

        let before = game.player(sender).ch.state_number();
        assert!(before > 0);
        assert_eq!(
            game.player(sender).ch.unroll_target_state_number(),
            Some(before),
            "holding the potato, unroll target is the current state"
        );

        let sigs = game
            .player(sender)
            .ch
            .send_empty_potato(&mut env)
            .expect("send_empty_potato");
        assert!(!game.player(sender).ch.have_potato());
        assert_eq!(game.player(sender).ch.state_number(), before + 1);
        assert_eq!(
            game.player(sender).ch.unroll_target_state_number(),
            Some(before),
            "after sending, unroll target stays on the last co-signed state"
        );

        game.player(receiver)
            .ch
            .received_empty_potato(&mut env, &sigs)
            .expect("received_empty_potato");
        assert_eq!(
            game.player(receiver).ch.unroll_target_state_number(),
            Some(game.player(receiver).ch.state_number()),
            "receiver's unroll target matches the state they just co-signed"
        );

        let mut handshake_only = setup_handshake(&mut rng, &mut env);
        let handshake_sender = if handshake_only.player(0).ch.have_potato() {
            0
        } else {
            1
        };
        assert_eq!(
            handshake_only
                .player(handshake_sender)
                .ch
                .unroll_target_state_number(),
            Some(handshake_only.player(handshake_sender).ch.state_number())
        );
        handshake_only
            .player(handshake_sender)
            .ch
            .send_empty_potato(&mut env)
            .expect("send from handshake");
        assert_eq!(
            handshake_only
                .player(handshake_sender)
                .ch
                .unroll_target_state_number(),
            Some(0),
            "first send from handshake unrolls to state 0, not the bumped current state"
        );
    }

    /// Test the parity constraint in preemption unroll spends.
    ///
    /// After 3 round-trips of empty potato exchanges, player 0 has:
    ///   state_number           = 6
    ///   latest_sent_unroll.state_number     = 5 (no peer signature)
    ///   latest_received_unroll.state_number = 6 (has peer signature)
    ///
    /// Case 1 — ancient same-parity state:
    ///   on-chain = 4.  received parity: (6^4)&1=0 BAD. sent parity: (5^4)&1=1
    ///   but sent has no peer sig.  It must use the historical timeout.
    ///
    /// Case 2 — higher state, correct parity:
    ///   on-chain = 3.  received parity: (6^3)&1=1 GOOD, has peer sig.
    ///   Preemption must succeed.
    ///
    /// Case 3 — current state parity is not authoritative:
    ///   after sending state 7, on-chain = 5 has the same parity as current,
    ///   but received state 6 has opposite parity and a peer signature.
    ///   Preemption must use state 6.
    pub(crate) fn test_preemption_parity_constraint() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
        let mut env = ChannelEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };

        let mut game = setup_handshake(&mut rng, &mut env);

        // 3 round-trips: state goes 0 → 2 → 4 → 6
        for _ in 0..3 {
            empty_potato_round_trip(&mut game, &mut env, 0);
        }

        // Case 1: ancient same-parity state → historical timeout.
        {
            let p0 = &game.player(0).ch;
            let conditions = make_conditions_for_state(&mut env, p0, 4);
            let result = p0.channel_coin_spent(&mut env, conditions);
            assert!(
                result.is_ok(),
                "same-parity historical state should time out, got: {result:?}"
            );
            assert!(
                result.unwrap().timeout,
                "same-parity historical state must use timeout"
            );
        }

        // Case 2: on-chain=3, higher state with correct parity → must SUCCEED
        {
            let p0 = &game.player(0).ch;
            let conditions = make_conditions_for_state(&mut env, p0, 3);
            let result = p0.channel_coin_spent(&mut env, conditions);
            assert!(
                result.is_ok(),
                "preemption with different-parity on-chain state should succeed, got: {result:?}"
            );
            let info = result.unwrap();
            assert!(!info.timeout, "should be a preemption, not a timeout");
            assert_real_preemption_accepts_fee(&mut env, info.transaction);
        }

        // Case 3: current state → timeout.
        {
            let p0 = &game.player(0).ch;
            let conditions = make_conditions_for_state(&mut env, p0, 6);
            let result = p0
                .channel_coin_spent(&mut env, conditions)
                .expect("current state should resolve");
            assert!(result.timeout, "current state must use timeout");
        }

        // Case 4: current state has the stale state's parity, but the retained
        // co-signed adjacent state can preempt.
        {
            let state_7_signatures = game
                .player(0)
                .ch
                .send_empty_potato(&mut env)
                .expect("advance player 0 to state 7");
            {
                let p0 = &game.player(0).ch;
                assert_eq!(p0.state_number(), 7);
                let conditions = make_conditions_for_state(&mut env, p0, 5);
                let result = p0
                    .channel_coin_spent(&mut env, conditions)
                    .expect("co-signed adjacent state should preempt");
                assert!(
                    !result.timeout,
                    "preemption must use retained record parity, not current state parity"
                );
            }

            game.player(1)
                .ch
                .received_empty_potato(&mut env, &state_7_signatures)
                .expect("receive state 7");
            let state_8_signatures = game
                .player(1)
                .ch
                .send_empty_potato(&mut env)
                .expect("send state 8");
            game.player(0)
                .ch
                .received_empty_potato(&mut env, &state_8_signatures)
                .expect("complete round trip");
        }

        // Compact historical records round-trip without full unroll/signature fields.
        {
            let p0 = &game.player(0).ch;
            let historical = p0
                .unroll_puzzle_hash_map()
                .values()
                .find(|info| info.state_number == 3)
                .expect("state 3 history");
            let encoded = bencodex::to_vec(historical).expect("serialize history");
            let decoded: HistoricalUnrollSpendInfo =
                bencodex::from_slice(&encoded).expect("deserialize history");
            assert_eq!(decoded.state_number, historical.state_number);
            assert_eq!(decoded.conditions_hash, historical.conditions_hash);
            assert_eq!(decoded.timeout_conditions, historical.timeout_conditions);
            for forbidden in [
                b"signatures".as_slice(),
                b"conditions_without_hash".as_slice(),
                b"signature".as_slice(),
                b"coin".as_slice(),
            ] {
                assert!(
                    !encoded.windows(forbidden.len()).any(|w| w == forbidden),
                    "compact history serialized forbidden field {}",
                    String::from_utf8_lossy(forbidden)
                );
            }
        }

        // Historical growth follows the compact-entry slope rather than retaining
        // another full signed unroll for every old state.
        {
            let (before_count, before_size, compact_entry_size) = {
                let p0 = &game.player(0).ch;
                let historical = p0
                    .unroll_puzzle_hash_map()
                    .values()
                    .next()
                    .expect("historical entry");
                (
                    p0.unroll_puzzle_hash_map().len(),
                    bencodex::to_vec(p0)
                        .expect("serialize channel before growth")
                        .len(),
                    bencodex::to_vec(historical)
                        .expect("serialize compact entry")
                        .len(),
                )
            };

            for _ in 0..8 {
                empty_potato_round_trip(&mut game, &mut env, 0);
            }

            let p0 = &game.player(0).ch;
            let after_count = p0.unroll_puzzle_hash_map().len();
            let after_size = bencodex::to_vec(p0)
                .expect("serialize channel after growth")
                .len();
            let added_entries = after_count - before_count;
            assert_eq!(
                added_entries, 16,
                "each exchange should retain one compact state"
            );
            assert!(
                after_size - before_size <= added_entries * (compact_entry_size + 64) + 256,
                "historical serialization grew faster than compact entries: before={before_size}, after={after_size}, entries={added_entries}, compact_entry={compact_entry_size}"
            );
        }

        // Case 5: unknown puzzle hash (simulates a state we don't recognize) → must FAIL
        {
            use crate::common::constants::CREATE_COIN;
            use crate::common::types::{Node, PuzzleHash};
            let fake_ph = PuzzleHash::default();
            let amount = Amount::new(200);
            let cond = (CREATE_COIN, (fake_ph, (amount, ())));
            let conditions: clvmr::NodePtr = (Node(cond.to_clvm(env.allocator).expect("clvm")), ())
                .to_clvm(env.allocator)
                .expect("conditions");
            let p0 = &game.player(0).ch;
            let result = p0.channel_coin_spent(&mut env, conditions);
            assert!(
                result.is_err(),
                "unrecognized unroll puzzle hash should always fail, got: {result:?}"
            );
        }
    }
}

pub(crate) fn test_unroll_can_verify_own_signature() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut unroll_coin_1 = UnrollCoin {
        started_with_potato: true,
        state_number: 1,
        ..UnrollCoin::default()
    };

    let mut unroll_coin_2 = UnrollCoin {
        state_number: 1,
        ..UnrollCoin::default()
    };

    let private_key_1 = rng.random();
    let private_key_2 = rng.random();
    let public_key_1 = private_to_public_key(&private_key_1);
    let public_key_2 = private_to_public_key(&private_key_2);
    let ref_puzzle_hash_1 = puzzle_hash_for_pk(&mut allocator, &public_key_1).expect("should work");
    let ref_puzzle_hash_2 = puzzle_hash_for_pk(&mut allocator, &public_key_2).expect("should work");

    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let nil = allocator.allocator().nil();
    let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
    let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelEnv {
        allocator: &mut allocator,
        referee_coin_puzzle: ref_coin_puz,
        referee_coin_puzzle_hash: ref_coin_ph.clone(),
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
    };

    let inputs_1 = UnrollCoinConditionInputs {
        my_reward_puzzle_hash: ref_puzzle_hash_1.clone(),
        their_reward_puzzle_hash: ref_puzzle_hash_2.clone(),
        my_balance: Amount::new(0),
        their_balance: Amount::new(100),
        puzzle_hashes_and_amounts: vec![],
        unroll_timeout: 15,
    };

    let _sig1 = unroll_coin_1
        .update(&mut env, &private_key_1, &public_key_2, &inputs_1)
        .expect("should work");

    let inputs_2 = UnrollCoinConditionInputs {
        my_reward_puzzle_hash: ref_puzzle_hash_2.clone(),
        their_reward_puzzle_hash: ref_puzzle_hash_1.clone(),
        my_balance: inputs_1.their_balance.clone(),
        their_balance: inputs_1.my_balance.clone(),
        ..inputs_1
    };

    let sig2 = unroll_coin_2
        .update(&mut env, &private_key_2, &public_key_1, &inputs_2)
        .expect("should work");

    let aggregate_unroll_public_key = public_key_1.clone() + public_key_2.clone();

    assert!(unroll_coin_1
        .verify(&mut env, &aggregate_unroll_public_key, &sig2,)
        .expect("should verify"));
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    #[cfg(feature = "sim-tests")]
    {
        vec![
            (
                "test_unroll_can_verify_own_signature",
                &test_unroll_can_verify_own_signature,
            ),
            (
                "test_preemption_parity_constraint",
                &sim_tests::test_preemption_parity_constraint,
            ),
        ]
    }
    #[cfg(not(feature = "sim-tests"))]
    {
        vec![(
            "test_unroll_can_verify_own_signature",
            &test_unroll_can_verify_own_signature,
        )]
    }
}
