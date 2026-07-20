use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::common::constants::{
    AGG_SIG_ME_ADDITIONAL_DATA, ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN, CREATE_COIN_ANNOUNCEMENT,
};
use crate::common::standard_coin::{sign_agg_sig_me, solution_for_conditions, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, GetCoinStringParts, Hash, IntoErr,
    PrivateKey, Program, PuzzleHash, Sha256Input, Sha256tree, Spend, SpendBundle, Timeout,
    ToQuotedProgram,
};
use crate::game_session::{DrainResult, WatchReport};
use crate::session_phases::effects::GameSessionEvent;
use crate::simulator::Simulator;
use crate::transaction_manager::{ManagedGameSession, TransactionManager};

/// A scripted [`ManagedGameSession`] for driving a [`TransactionManager`] over real
/// simulator coin state.  Pre-queued event batches are returned in order from
/// `session_flush_and_collect`; blocks are accepted and ignored.
#[derive(Default)]
struct ScriptedGameSession {
    drains: std::collections::VecDeque<Vec<GameSessionEvent>>,
}

impl ScriptedGameSession {
    fn queue(&mut self, events: Vec<GameSessionEvent>) {
        self.drains.push_back(events);
    }
}

impl ManagedGameSession for ScriptedGameSession {
    fn session_new_block(
        &mut self,
        _allocator: &mut AllocEncoder,
        _height: u64,
        _report: &WatchReport,
    ) -> Result<(), crate::common::types::Error> {
        Ok(())
    }

    fn session_flush_and_collect(
        &mut self,
        _allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, crate::common::types::Error> {
        Ok(DrainResult {
            events: self
                .drains
                .pop_front()
                .unwrap_or_default()
                .into_iter()
                .collect(),
            resync: None,
        })
    }
}

/// Build a signed transaction that spends `coin` (owned by `identity`) to
/// create a single output of `amount` at `target_ph`, returning the tx and the
/// resulting output coin string.
fn make_create_coin_tx(
    allocator: &mut AllocEncoder,
    identity: &ChiaIdentity,
    coin: &CoinString,
    target_ph: &PuzzleHash,
    amount: Amount,
) -> (CoinSpend, CoinString) {
    let conditions = ((CREATE_COIN, (target_ph.clone(), (amount.clone(), ()))), ())
        .to_clvm(allocator)
        .into_gen()
        .unwrap();
    let solution = solution_for_conditions(allocator, conditions).unwrap();
    let quoted = conditions.to_quoted_program(allocator).unwrap();
    let qhash = quoted.sha256tree(allocator);
    let sig = sign_agg_sig_me(
        &identity.synthetic_private_key,
        qhash.bytes(),
        &coin.to_coin_id(),
        &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
    );
    let tx = CoinSpend {
        coin: coin.clone(),
        bundle: Spend {
            puzzle: identity.puzzle.clone(),
            solution: Program::from_nodeptr(allocator, solution).unwrap().into(),
            signature: sig,
        },
    };
    let output = CoinString::from_parts(&coin.to_coin_id(), target_ph, &amount);
    (tx, output)
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();
    res.push(("test_sim", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("no");
        s.farm_block(&identity.puzzle_hash);

        let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

        let (_, _, amt) = coins[0].to_parts().unwrap();
        s.spend_coin_to_puzzle_hash(
            &mut allocator,
            &identity,
            &identity.puzzle,
            &coins[0],
            &[(identity.puzzle_hash.clone(), amt.clone())],
        )
        .expect("should spend");
    }));

    res.push(("test_simulator_transfer_coin", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.random();
        let identity1 =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");

        s.farm_block(&identity1.puzzle_hash);

        let coins1 = s.get_my_coins(&identity1.puzzle_hash).expect("got coins");
        let coins2_empty = s
            .get_my_coins(&identity2.puzzle_hash)
            .expect("got coin list");

        assert!(coins2_empty.is_empty());
        s.transfer_coin_amount(
            &mut allocator,
            &identity2.puzzle_hash,
            &identity1,
            &coins1[0],
            Amount::new(100),
        )
        .expect("should transfer");

        s.farm_block(&identity1.puzzle_hash);
        let coins2 = s.get_my_coins(&identity2.puzzle_hash).expect("got coins");
        assert_eq!(coins2.len(), 1);
    }));

    res.push(("test_simulator_combine_coins", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.random();
        let identity =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

        s.farm_block(&identity.puzzle_hash);

        let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

        s.combine_coins(&mut allocator, &identity, &identity.puzzle_hash, &coins)
            .expect("should transfer");

        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");
        s.farm_block(&identity2.puzzle_hash);
        let one_coin = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

        let (_, _, a1) = coins[0].to_parts().expect("should parse");
        let (_, _, a2) = coins[1].to_parts().expect("should parse");
        let (_, _, amt) = one_coin[0].to_parts().expect("should parse");

        assert_eq!(one_coin.len(), coins.len() - 1);
        assert_eq!(a1 + a2, amt);
    }));

    res.push(("test_simulator_farm_block_height", &|| {
        let s = Simulator::new_strict();
        assert_eq!(s.get_current_height(), 0usize);

        let ph = PuzzleHash::from_hash(Hash::from_bytes([1u8; 32]));
        s.farm_block(&ph);
        assert_eq!(s.get_current_height(), 1usize);

        s.farm_block(&ph);
        assert_eq!(s.get_current_height(), 2usize);
    }));

    res.push(("test_simulator_farm_creates_coins", &|| {
        let mut allocator = AllocEncoder::new();
        let seed: [u8; 32] = [1; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        let before = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(before.is_empty());

        s.farm_block(&identity.puzzle_hash);
        let after = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert_eq!(
            after.len(),
            2,
            "farm_block should create pool + farmer reward"
        );

        let total: u64 = after
            .iter()
            .map(|c| {
                let (_, _, amt) = c.get_coin_string_parts().unwrap();
                let v: u64 = amt.into();
                v
            })
            .sum();
        assert_eq!(total, 2_000_000_000_000, "total reward should be 2 XCH");
    }));

    res.push(("test_simulator_get_all_coins_excludes_coinbase", &|| {
        let s = Simulator::new_strict();
        let ph = PuzzleHash::from_hash(Hash::from_bytes([2u8; 32]));
        s.farm_block(&ph);

        let all = s.get_all_coins().expect("ok");
        assert!(
            all.is_empty(),
            "get_all_coins should exclude coinbase/reward coins"
        );

        let my = s.get_my_coins(&ph).expect("ok");
        assert_eq!(my.len(), 2, "get_my_coins should include reward coins");
    }));

    res.push(("test_simulator_push_transactions_and_farm", &|| {
        let seed: [u8; 32] = [3; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        let conditions = (
            (
                CREATE_COIN,
                (identity2.puzzle_hash.clone(), (amt.clone(), ())),
            ),
            (),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();
        let quoted = conditions.to_quoted_program(&mut allocator).unwrap();
        let qhash = quoted.sha256tree(&mut allocator);
        let sig = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash.bytes(),
            &coin.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution)
                    .unwrap()
                    .into(),
                signature: sig,
            },
        };

        let result = s.push_transactions(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 1, "should be accepted into mempool");

        // Before farming: old coin still visible, new coin not yet
        let still_there = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(
            still_there
                .iter()
                .any(|c| c.to_coin_id() == coin.to_coin_id()),
            "coin should still exist before farming"
        );

        s.farm_block(&identity.puzzle_hash);

        // After farming: old coin gone (spent), new coin exists
        let id1_coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(
            !id1_coins
                .iter()
                .any(|c| c.to_coin_id() == coin.to_coin_id()),
            "spent coin should be gone after farming"
        );

        let id2_coins = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert_eq!(id2_coins.len(), 1, "new coin should exist");
        let (_, _, new_amt) = id2_coins[0].get_coin_string_parts().unwrap();
        assert_eq!(new_amt, amt, "new coin should have the transferred amount");
    }));

    res.push(("test_simulator_double_spend_rejected", &|| {
        let seed: [u8; 32] = [4; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new(false);
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let spend_coin = |allocator: &mut AllocEncoder| -> CoinSpend {
            let conditions = (
                (
                    CREATE_COIN,
                    (identity.puzzle_hash.clone(), (amt.clone(), ())),
                ),
                (),
            )
                .to_clvm(allocator)
                .into_gen()
                .unwrap();
            let solution = solution_for_conditions(allocator, conditions).unwrap();
            let quoted = conditions.to_quoted_program(allocator).unwrap();
            let qhash = quoted.sha256tree(allocator);
            let sig = sign_agg_sig_me(
                &identity.synthetic_private_key,
                qhash.bytes(),
                &coin.to_coin_id(),
                &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            );
            CoinSpend {
                coin: coin.clone(),
                bundle: Spend {
                    puzzle: identity.puzzle.clone(),
                    solution: Program::from_nodeptr(allocator, solution).unwrap().into(),
                    signature: sig,
                },
            }
        };

        let tx1 = spend_coin(&mut allocator);
        let r1 = s.push_transactions(&mut allocator, &[tx1]).expect("ok");
        assert_eq!(r1.code, 1, "first spend should succeed");

        s.farm_block(&identity.puzzle_hash);

        let tx2 = spend_coin(&mut allocator);
        let r2 = s.push_transactions(&mut allocator, &[tx2]).expect("ok");
        assert_eq!(
            r2.code, 1,
            "re-submitting the exact same transaction should de-duplicate"
        );

        let altered_conditions = (
            (
                CREATE_COIN,
                (
                    identity.puzzle_hash.clone(),
                    (Amount::new(amt.to_u64().saturating_sub(1)), ()),
                ),
            ),
            (),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let altered_solution = solution_for_conditions(&mut allocator, altered_conditions).unwrap();
        let altered_quoted = altered_conditions
            .to_quoted_program(&mut allocator)
            .unwrap();
        let altered_qhash = altered_quoted.sha256tree(&mut allocator);
        let altered_sig = sign_agg_sig_me(
            &identity.synthetic_private_key,
            altered_qhash.bytes(),
            &coin.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let altered_tx = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, altered_solution)
                    .unwrap()
                    .into(),
                signature: altered_sig,
            },
        };
        let r3 = s
            .push_transactions(&mut allocator, &[altered_tx])
            .expect("ok");
        assert_eq!(
            r3.code, 3,
            "re-submitting a different transaction for an already-spent coin should be rejected"
        );
    }));

    res.push(("test_simulator_nonexistent_coin_rejected", &|| {
        let seed: [u8; 32] = [5; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new(false);
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        let fake_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([99u8; 32])),
            &identity.puzzle_hash,
            &Amount::new(1000),
        );

        let conditions = (
            (
                CREATE_COIN,
                (identity.puzzle_hash.clone(), (Amount::new(1000), ())),
            ),
            (),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();
        let quoted = conditions.to_quoted_program(&mut allocator).unwrap();
        let qhash = quoted.sha256tree(&mut allocator);
        let sig = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash.bytes(),
            &fake_coin.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            coin: fake_coin,
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution)
                    .unwrap()
                    .into(),
                signature: sig,
            },
        };

        let result = s.push_transactions(&mut allocator, &[tx]).expect("ok");
        assert_eq!(
            result.code, 3,
            "spending non-existent coin should be rejected"
        );
    }));

    res.push(("test_simulator_bad_signature_rejected", &|| {
        let seed: [u8; 32] = [6; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new(false);
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let conditions = (
            (
                CREATE_COIN,
                (identity.puzzle_hash.clone(), (amt.clone(), ())),
            ),
            (),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();

        let tx = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution)
                    .unwrap()
                    .into(),
                signature: Aggsig::default(),
            },
        };

        let result = s.push_transactions(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 3, "bad signature should be rejected");
    }));

    res.push(("test_simulator_get_puzzle_and_solution", &|| {
        let seed: [u8; 32] = [7; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let coin_id = coin.to_coin_id();

        let ps_before = s.get_puzzle_and_solution(&coin_id).expect("ok");
        assert!(
            ps_before.is_none(),
            "unspent coin should have no puzzle/solution"
        );

        let (_, _, coin_amt) = coin.get_coin_string_parts().unwrap();
        s.spend_coin_to_puzzle_hash(
            &mut allocator,
            &identity,
            &identity.puzzle,
            coin,
            &[(identity.puzzle_hash.clone(), coin_amt)],
        )
        .expect("should spend");
        s.farm_block(&identity.puzzle_hash);

        let ps_after = s.get_puzzle_and_solution(&coin_id).expect("ok");
        assert!(
            ps_after.is_some(),
            "spent coin should have puzzle/solution stored"
        );

        let (puzzle, solution) = ps_after.unwrap();
        assert!(!puzzle.to_hex().is_empty(), "puzzle should have content");
        assert!(
            !solution.to_hex().is_empty(),
            "solution should have content"
        );
    }));

    res.push(("test_simulator_mempool_not_applied_before_farm", &|| {
        let seed: [u8; 32] = [8; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];

        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        s.transfer_coin_amount(
            &mut allocator,
            &identity2.puzzle_hash,
            &identity,
            coin,
            Amount::new(100),
        )
        .expect("should transfer");

        let id2_before_farm = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert!(
            id2_before_farm.is_empty(),
            "new coins should not exist before farm_block"
        );

        s.farm_block(&identity.puzzle_hash);

        let id2_after_farm = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert_eq!(
            id2_after_farm.len(),
            1,
            "new coin should exist after farm_block"
        );
    }));

    res.push(("test_simulator_assert_coin_announcement_enforced", &|| {
        let seed: [u8; 32] = [9; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new(false);
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(coins.len() >= 2, "expected at least two spendable coins");
        let coin_a = coins[0].clone();
        let coin_b = coins[1].clone();
        let (_, _, amt_a) = coin_a.get_coin_string_parts().expect("parts");
        let (_, _, amt_b) = coin_b.get_coin_string_parts().expect("parts");

        let announcement_msg = Hash::from_bytes([0xAB; 32]);
        let announcement_id = Sha256Input::Array(vec![
            Sha256Input::Bytes(coin_a.to_coin_id().bytes()),
            Sha256Input::Bytes(announcement_msg.bytes()),
        ])
        .hash();

        let conds_a = (
            (CREATE_COIN_ANNOUNCEMENT, (announcement_msg.clone(), ())),
            (
                (
                    CREATE_COIN,
                    (identity.puzzle_hash.clone(), (amt_a.clone(), ())),
                ),
                (),
            ),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .expect("conds_a");
        let sol_a = solution_for_conditions(&mut allocator, conds_a).expect("sol_a");
        let quoted_a = conds_a.to_quoted_program(&mut allocator).expect("quoted_a");
        let qhash_a = quoted_a.sha256tree(&mut allocator);
        let sig_a = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash_a.bytes(),
            &coin_a.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );

        let conds_b = (
            (ASSERT_COIN_ANNOUNCEMENT, (announcement_id.clone(), ())),
            (
                (
                    CREATE_COIN,
                    (identity.puzzle_hash.clone(), (amt_b.clone(), ())),
                ),
                (),
            ),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .expect("conds_b");
        let sol_b = solution_for_conditions(&mut allocator, conds_b).expect("sol_b");
        let quoted_b = conds_b.to_quoted_program(&mut allocator).expect("quoted_b");
        let qhash_b = quoted_b.sha256tree(&mut allocator);
        let sig_b = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash_b.bytes(),
            &coin_b.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );

        let tx_a = CoinSpend {
            coin: coin_a.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, sol_a)
                    .expect("prog_a")
                    .into(),
                signature: sig_a,
            },
        };
        let tx_b = CoinSpend {
            coin: coin_b.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, sol_b)
                    .expect("prog_b")
                    .into(),
                signature: sig_b,
            },
        };

        let ok = s
            .push_transactions(&mut allocator, &[tx_a, tx_b])
            .expect("push");
        assert_eq!(
            ok.code, 1,
            "assertion should pass when announcement is created in same bundle"
        );
    }));

    res.push((
        "test_simulator_assert_coin_announcement_rejects_missing",
        &|| {
            let seed: [u8; 32] = [10; 32];
            let mut rng = ChaCha8Rng::from_seed(seed);
            let mut allocator = AllocEncoder::new();
            let s = Simulator::new(false);
            let pk: PrivateKey = rng.random();
            let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

            s.farm_block(&identity.puzzle_hash);
            let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
            let coin = coins[0].clone();
            let (_, _, amt) = coin.get_coin_string_parts().expect("parts");

            let bogus_announcement_id = Hash::from_bytes([0x42; 32]);
            let conds = (
                (
                    ASSERT_COIN_ANNOUNCEMENT,
                    (bogus_announcement_id.clone(), ()),
                ),
                (
                    (
                        CREATE_COIN,
                        (identity.puzzle_hash.clone(), (amt.clone(), ())),
                    ),
                    (),
                ),
            )
                .to_clvm(&mut allocator)
                .into_gen()
                .expect("conds");
            let solution = solution_for_conditions(&mut allocator, conds).expect("solution");
            let quoted = conds.to_quoted_program(&mut allocator).expect("quoted");
            let qhash = quoted.sha256tree(&mut allocator);
            let sig = sign_agg_sig_me(
                &identity.synthetic_private_key,
                qhash.bytes(),
                &coin.to_coin_id(),
                &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            );
            let tx = CoinSpend {
                coin,
                bundle: Spend {
                    puzzle: identity.puzzle.clone(),
                    solution: Program::from_nodeptr(&mut allocator, solution)
                        .expect("program")
                        .into(),
                    signature: sig,
                },
            };

            let res = s.push_transactions(&mut allocator, &[tx]).expect("push");
            assert_eq!(res.code, 3, "missing announcement should be rejected");
            assert!(
                res.diagnostic.contains("ASSERT_COIN_ANNOUNCEMENT failed"),
                "diagnostic should mention failed announcement assertion: {:?}",
                res
            );
        },
    ));

    res.push(("test_simulator_reorg_uncreates_and_unspends", &|| {
        let seed: [u8; 32] = [11; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");
        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        // Block 1: reward coins for identity.
        s.farm_block(&identity.puzzle_hash);
        let parent = s.get_my_coins(&identity.puzzle_hash).expect("ok")[0].clone();
        let (_, _, amt) = parent.get_coin_string_parts().unwrap();

        // Spend parent -> child, confirmed at block 2.
        let (tx, child) = make_create_coin_tx(
            &mut allocator,
            &identity,
            &parent,
            &identity2.puzzle_hash,
            amt,
        );
        assert_eq!(
            s.push_transactions(&mut allocator, &[tx]).expect("ok").code,
            1
        );
        s.farm_block(&identity.puzzle_hash);
        assert_eq!(s.get_current_height(), 2);

        let before = s.get_coin_states(&[child.clone(), parent.clone()]);
        assert_eq!(before[0].created_height, Some(2), "child created at 2");
        assert_eq!(before[1].spent_height, Some(2), "parent spent at 2");

        // Reorg back to block 1: child un-created, parent un-spent.
        s.reorg(1);
        assert_eq!(s.get_current_height(), 1);
        let after = s.get_coin_states(&[child.clone(), parent.clone()]);
        assert_eq!(after[0].created_height, None, "child should be gone");
        assert_eq!(after[1].spent_height, None, "parent spend reverted");
        assert_eq!(
            after[1].created_height,
            Some(0),
            "parent (a block-0 reward) survives"
        );
    }));

    res.push(("test_manager_reorg_resubmits_and_recovers", &|| {
        let seed: [u8; 32] = [12; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");
        let pk2: PrivateKey = rng.random();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let parent = s.get_my_coins(&identity.puzzle_hash).expect("ok")[0].clone();
        let (_, _, amt) = parent.get_coin_string_parts().unwrap();
        let (tx, child) = make_create_coin_tx(
            &mut allocator,
            &identity,
            &parent,
            &identity2.puzzle_hash,
            amt,
        );
        let creating_tx = SpendBundle {
            name: Some("create-child".to_string()),
            spends: vec![tx.clone()],
        };

        // The cradle wants to watch the child and submit the creating tx.
        let mut cradle = ScriptedGameSession::default();
        cradle.queue(vec![
            GameSessionEvent::WatchCoin {
                coin_name: child.to_coin_id(),
                coin_string: child.clone(),
                timeout: Timeout::new(100),
                spend: None,
            },
            GameSessionEvent::OutboundTransaction(creating_tx.clone(), None),
        ]);
        let mut mgr = TransactionManager::new(cradle);
        mgr.flush_and_collect(&mut allocator).expect("flush");

        // Submit the creating tx the manager captured; confirm child at block 2.
        let subs = mgr.drain_submissions();
        assert_eq!(subs.len(), 1);
        assert_eq!(
            s.push_transactions(&mut allocator, &tx_spends(&subs[0]))
                .expect("ok")
                .code,
            1
        );
        s.farm_block(&identity.puzzle_hash);

        let poll = mgr.snapshot_watched_coins();
        mgr.report_coin_states(&mut allocator, 2, &s.get_coin_states(&poll))
            .expect("report");
        mgr.flush_and_collect(&mut allocator).expect("flush");
        assert_eq!(mgr.watched_coin(&child).unwrap().birthday, Some(2));
        assert!(
            mgr.drain_submissions().is_empty(),
            "no resubmission while confirmed"
        );

        // Reorg the chain back past the child's creation.
        s.reorg(1);
        mgr.report_coin_states(&mut allocator, 1, &s.get_coin_states(&poll))
            .expect("report");
        mgr.flush_and_collect(&mut allocator).expect("flush");
        assert!(
            mgr.vanished_coins().contains(&child),
            "child flagged vanished"
        );

        // The manager re-queued the creating tx; resubmit it and recover.
        let resubs = mgr.drain_submissions();
        assert_eq!(resubs.len(), 1, "creating tx resubmitted");
        assert_eq!(
            s.push_transactions(&mut allocator, &tx_spends(&resubs[0]))
                .expect("ok")
                .code,
            1,
            "resubmission accepted after reorg"
        );
        s.farm_block(&identity.puzzle_hash);

        mgr.report_coin_states(&mut allocator, 2, &s.get_coin_states(&poll))
            .expect("report");
        mgr.flush_and_collect(&mut allocator).expect("flush");
        assert_eq!(
            mgr.watched_coin(&child).unwrap().birthday,
            Some(2),
            "child reappeared"
        );
        assert!(!mgr.vanished_coins().contains(&child), "no longer vanished");
    }));

    res
}

/// Pull the [`CoinSpend`]s out of a [`SpendBundle`] for submission.
fn tx_spends(bundle: &SpendBundle) -> Vec<CoinSpend> {
    bundle.spends.clone()
}
