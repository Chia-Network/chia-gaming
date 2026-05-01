use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::types::{
    read_unroll_metapuzzle, read_unroll_puzzle, ChannelHandlerEnv, UnrollCoin,
    UnrollCoinConditionInputs,
};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{
    get_standard_coin_puzzle, private_to_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{AllocEncoder, Amount, Hash, Puzzle, Sha256tree};

#[cfg(feature = "sim-tests")]
pub(crate) mod sim_tests {
    use super::*;

    use clvm_traits::ToClvm;

    use crate::common::types::{CoinID, GameID};
    use crate::test_support::game::{ChannelHandlerGame, DEFAULT_UNROLL_TIME_LOCK};

    /// Helper: create a ChannelHandlerGame with completed handshake.
    fn setup_handshake(
        rng: &mut impl rand::Rng,
        env: &mut ChannelHandlerEnv<'_>,
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

        game.finish_handshake(env, 1).expect("finish_handshake(1)");
        game.finish_handshake(env, 0).expect("finish_handshake(0)");
        game
    }

    /// Helper: perform one full round-trip of empty potato exchanges.
    /// Player `sender` sends first, then `sender^1` sends back.
    fn empty_potato_round_trip(
        game: &mut ChannelHandlerGame,
        env: &mut ChannelHandlerEnv<'_>,
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
        env: &mut ChannelHandlerEnv<'_>,
        handler: &crate::channel_handler::ChannelHandler,
        state_number: usize,
    ) -> clvmr::NodePtr {
        use crate::common::constants::CREATE_COIN;
        use crate::common::types::Node;

        let ph = handler
            .unroll_puzzle_hash_map()
            .iter()
            .find_map(|(ph, info)| {
                if info.coin.state_number == state_number {
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

    /// Test the parity constraint in preemption unroll spends.
    ///
    /// After 3 round-trips of empty potato exchanges, player 0 has:
    ///   state_number           = 6
    ///   latest_sent_unroll.state_number     = 5 (no peer signature)
    ///   latest_received_unroll.state_number = 6 (has peer signature)
    ///
    /// Case 1 — higher state, wrong parity for preemption:
    ///   on-chain = 4.  received parity: (6^4)&1=0 BAD. sent parity: (5^4)&1=1
    ///   but sent has no peer sig.  Preemption must fail.
    ///
    /// Case 2 — higher state, correct parity:
    ///   on-chain = 3.  received parity: (6^3)&1=1 GOOD, has peer sig.
    ///   Preemption must succeed.
    ///
    /// Case 3 — state from the future:
    ///   on-chain = 8 > our 6.  Must fail regardless of parity.
    pub(crate) fn test_preemption_parity_constraint() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);
        let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
        let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
        let nil = allocator.allocator().nil();
        let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
        let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
        let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
        let mut env = ChannelHandlerEnv {
            allocator: &mut allocator,
            referee_coin_puzzle: ref_coin_puz,
            referee_coin_puzzle_hash: ref_coin_ph,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        };

        let mut game = setup_handshake(&mut rng, &mut env);

        // 3 round-trips: state goes 0 → 2 → 4 → 6
        for _ in 0..3 {
            empty_potato_round_trip(&mut game, &mut env, 0);
        }

        // Case 1: on-chain=4, higher state but wrong parity → must FAIL
        {
            let p0 = &game.player(0).ch;
            let conditions = make_conditions_for_state(&mut env, p0, 4);
            let result = p0.channel_coin_spent(&mut env, false, conditions);
            assert!(
                result.is_err(),
                "preemption with matching-parity on-chain state should fail, got: {result:?}"
            );
            let err_msg = format!("{:?}", result.unwrap_err());
            assert!(
                err_msg.contains("parity") || err_msg.contains("signature"),
                "error should mention parity or signature, got: {err_msg}"
            );
        }

        // Case 2: on-chain=3, higher state with correct parity → must SUCCEED
        {
            let p0 = &game.player(0).ch;
            let conditions = make_conditions_for_state(&mut env, p0, 3);
            let result = p0.channel_coin_spent(&mut env, false, conditions);
            assert!(
                result.is_ok(),
                "preemption with different-parity on-chain state should succeed, got: {result:?}"
            );
            let info = result.unwrap();
            assert!(!info.timeout, "should be a preemption, not a timeout");
        }

        // Case 3: unknown puzzle hash (simulates a state we don't recognize) → must FAIL
        {
            use crate::common::constants::CREATE_COIN;
            use crate::common::types::{Node, PuzzleHash};
            let fake_ph = PuzzleHash::default();
            let amount = Amount::new(200);
            let cond = (CREATE_COIN, (fake_ph, (amount, ())));
            let conditions: clvmr::NodePtr =
                (Node(cond.to_clvm(env.allocator).expect("clvm")), ())
                    .to_clvm(env.allocator)
                    .expect("conditions");
            let p0 = &game.player(0).ch;
            let result = p0.channel_coin_spent(&mut env, false, conditions);
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

    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let nil = allocator.allocator().nil();
    let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
    let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        referee_coin_puzzle: ref_coin_puz,
        referee_coin_puzzle_hash: ref_coin_ph.clone(),
        unroll_metapuzzle,
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
        unroll_timeout: 0,
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
    let mut v: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = vec![(
        "test_unroll_can_verify_own_signature",
        &test_unroll_can_verify_own_signature,
    )];
    #[cfg(feature = "sim-tests")]
    {
        v.push((
            "test_preemption_parity_constraint",
            &sim_tests::test_preemption_parity_constraint,
        ));
    }
    v
}
