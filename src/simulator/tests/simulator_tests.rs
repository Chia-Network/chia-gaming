use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN};
use crate::common::standard_coin::{sign_agg_sig_me, solution_for_conditions, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, GetCoinStringParts, Hash, IntoErr,
    PrivateKey, Program, PuzzleHash, Sha256tree, Spend, ToQuotedProgram,
};
use crate::simulator::Simulator;

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();
    res.push(("test_sim", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.gen();
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
        let private_key: PrivateKey = rng.gen();
        let identity1 =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
        let pk2: PrivateKey = rng.gen();
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
        let private_key: PrivateKey = rng.gen();
        let identity =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

        s.farm_block(&identity.puzzle_hash);

        let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

        s.combine_coins(&mut allocator, &identity, &identity.puzzle_hash, &coins)
            .expect("should transfer");

        let pk2: PrivateKey = rng.gen();
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
        let pk: PrivateKey = rng.gen();
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

    res.push(("test_simulator_push_tx_and_farm", &|| {
        let seed: [u8; 32] = [3; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let pk2: PrivateKey = rng.gen();
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

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
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
        let pk: PrivateKey = rng.gen();
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
        let r1 = s.push_tx(&mut allocator, &[tx1]).expect("ok");
        assert_eq!(r1.code, 1, "first spend should succeed");

        s.farm_block(&identity.puzzle_hash);

        let tx2 = spend_coin(&mut allocator);
        let r2 = s.push_tx(&mut allocator, &[tx2]).expect("ok");
        assert_eq!(r2.code, 3, "second spend of same coin should be rejected");
    }));

    res.push(("test_simulator_nonexistent_coin_rejected", &|| {
        let seed: [u8; 32] = [5; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new(false);
        let pk: PrivateKey = rng.gen();
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

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
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
        let pk: PrivateKey = rng.gen();
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

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 3, "bad signature should be rejected");
    }));

    res.push(("test_simulator_get_puzzle_and_solution", &|| {
        let seed: [u8; 32] = [7; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
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
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];

        let pk2: PrivateKey = rng.gen();
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

    res
}
