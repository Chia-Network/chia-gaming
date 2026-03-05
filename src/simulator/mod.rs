#[cfg(feature = "sim-server")]
pub mod service;
#[cfg(test)]
pub mod tests;

use std::cell::RefCell;
use std::collections::HashMap;

use chia_bls::signature::aggregate_verify;
use clvm_traits::{ClvmEncoder, ToClvm};
use log::debug;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    agg_sig_me_message, sign_agg_sig_me, solution_for_conditions, standard_solution_partial,
    ChiaIdentity,
};
use crate::common::types::CoinCondition;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, Error, GetCoinStringParts, Hash,
    IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend, ToQuotedProgram,
};

use crate::utils::map_m;

#[cfg(test)]
use crate::simulator::tests::potato_handler_sim::test_funs as potato_handler_sim_tests;
#[cfg(test)]
use crate::simulator::tests::simulator_tests::test_funs as simulator_tests;
#[cfg(test)]
use crate::test_support::calpoker::test_funs as calpoker_tests;

#[cfg(test)]
use crate::common::types::divmod::test_funs as divmod_tests;
#[cfg(test)]
use crate::games::calpoker::test_funs as calpoker_game_tests;
#[cfg(test)]
use crate::test_support::debug_game::test_funs as debug_game_tests;
#[cfg(test)]
use crate::test_support::peer::potato_handler::test_funs as potato_handler_tests;
#[cfg(test)]
use crate::tests::calpoker_handlers::test_funs as calpoker_handler_tests;
#[cfg(test)]
use crate::tests::calpoker_validation::test_funs as calpoker_validation_tests;
#[cfg(test)]
use crate::tests::channel_handler::test_funs as channel_handler_tests;
#[cfg(test)]
use crate::tests::chialisp::test_funs as chialisp_tests;
#[cfg(test)]
use crate::tests::standard_coin::test_funs as standard_coin_tests;

#[derive(Debug, Clone)]
pub struct IncludeTransactionResult {
    pub code: u32,
    pub e: Option<u32>,
    pub diagnostic: String,
}

const POOL_REWARD_AMOUNT: u64 = 1_750_000_000_000;
const FARMER_REWARD_AMOUNT: u64 = 250_000_000_000;

#[derive(Debug, Clone)]
struct CoinRecord {
    coin: CoinString,
    puzzle_hash: PuzzleHash,
    created_height: u32,
    spent_height: Option<u32>,
    coinbase: bool,
}

struct PendingSpend {
    removals: Vec<CoinID>,
    additions: Vec<(CoinID, PuzzleHash, Amount)>,
    puzzle_solutions: Vec<(CoinID, Program, Program)>,
}

struct SimulatorState {
    coins: HashMap<CoinID, CoinRecord>,
    mempool: Vec<PendingSpend>,
    spent_puzzle_solutions: HashMap<CoinID, (Program, Program)>,
    height: u32,
}

pub struct Simulator {
    state: RefCell<SimulatorState>,
    strict: bool,
}

impl SimulatorState {
    fn new() -> Self {
        SimulatorState {
            coins: HashMap::new(),
            mempool: Vec::new(),
            spent_puzzle_solutions: HashMap::new(),
            height: 0,
        }
    }

    fn add_coin(
        &mut self,
        parent_id: &CoinID,
        puzzle_hash: &PuzzleHash,
        amount: &Amount,
        coinbase: bool,
    ) {
        let coin = CoinString::from_parts(parent_id, puzzle_hash, amount);
        let coin_id = coin.to_coin_id();
        self.coins.insert(
            coin_id,
            CoinRecord {
                coin,
                puzzle_hash: puzzle_hash.clone(),
                created_height: self.height,
                spent_height: None,
                coinbase,
            },
        );
    }

    fn reward_parent_id(prefix: &[u8], height: u32) -> CoinID {
        let h = Sha256Input::Array(vec![
            Sha256Input::Bytes(prefix),
            Sha256Input::Bytes(&height.to_be_bytes()),
        ])
        .hash();
        CoinID::new(h)
    }

    fn farm_block_inner(&mut self, puzzle_hash: &PuzzleHash) {
        let next_height = if self.coins.is_empty() && self.height == 0 {
            0
        } else {
            self.height + 1
        };

        let pool_parent = Self::reward_parent_id(b"pool_reward", next_height);
        let farmer_parent = Self::reward_parent_id(b"farmer_reward", next_height);

        self.add_coin(
            &pool_parent,
            puzzle_hash,
            &Amount::new(POOL_REWARD_AMOUNT),
            true,
        );
        self.add_coin(
            &farmer_parent,
            puzzle_hash,
            &Amount::new(FARMER_REWARD_AMOUNT),
            true,
        );

        let pending: Vec<PendingSpend> = self.mempool.drain(..).collect();
        for spend in pending {
            for removal in &spend.removals {
                if let Some(record) = self.coins.get_mut(removal) {
                    record.spent_height = Some(next_height);
                }
            }
            for (parent_id, ph, amt) in &spend.additions {
                let coin = CoinString::from_parts(parent_id, ph, amt);
                let coin_id = coin.to_coin_id();
                self.coins.insert(
                    coin_id,
                    CoinRecord {
                        coin,
                        puzzle_hash: ph.clone(),
                        created_height: next_height,
                        spent_height: None,
                        coinbase: false,
                    },
                );
            }
            for (coin_id, puzzle, solution) in spend.puzzle_solutions {
                self.spent_puzzle_solutions
                    .insert(coin_id, (puzzle, solution));
            }
        }

        self.height = next_height;
    }
}

impl Default for Simulator {
    fn default() -> Self {
        Simulator::new(false)
    }
}

impl Simulator {
    pub fn new(strict: bool) -> Self {
        let mut state = SimulatorState::new();
        let zero_ph = PuzzleHash::from_hash(Hash::from_slice(&[0u8; 32]));
        state.farm_block_inner(&zero_ph);
        Simulator {
            state: RefCell::new(state),
            strict,
        }
    }

    pub fn new_strict() -> Self {
        Simulator::new(true)
    }

    pub fn farm_block(&self, puzzle_hash: &PuzzleHash) {
        self.state.borrow_mut().farm_block_inner(puzzle_hash);
    }

    pub fn get_current_height(&self) -> usize {
        self.state.borrow().height as usize
    }

    pub fn get_all_coins(&self) -> Result<Vec<CoinString>, Error> {
        let state = self.state.borrow();
        Ok(state
            .coins
            .values()
            .filter(|r| r.spent_height.is_none() && !r.coinbase)
            .map(|r| r.coin.clone())
            .collect())
    }

    pub fn get_my_coins(&self, puzzle_hash: &PuzzleHash) -> Result<Vec<CoinString>, Error> {
        let state = self.state.borrow();
        Ok(state
            .coins
            .values()
            .filter(|r| r.spent_height.is_none() && &r.puzzle_hash == puzzle_hash)
            .map(|r| r.coin.clone())
            .collect())
    }

    pub fn get_puzzle_and_solution(
        &self,
        coin_id: &CoinID,
    ) -> Result<Option<(Program, Program)>, Error> {
        let state = self.state.borrow();
        if let Some(record) = state.coins.get(coin_id) {
            if record.spent_height.is_none() {
                return Ok(None);
            }
        }
        Ok(state.spent_puzzle_solutions.get(coin_id).cloned())
    }

    pub fn is_coin_spendable(&self, coin: &CoinString) -> bool {
        let state = self.state.borrow();
        let coin_id = coin.to_coin_id();
        match state.coins.get(&coin_id) {
            Some(r) => r.spent_height.is_none(),
            None => false,
        }
    }

    pub fn push_tx(
        &self,
        allocator: &mut AllocEncoder,
        txs: &[CoinSpend],
    ) -> Result<IncludeTransactionResult, Error> {
        if txs.is_empty() {
            return Ok(IncludeTransactionResult {
                code: 3,
                e: Some(1),
                diagnostic: "Empty spend bundle".to_string(),
            });
        }

        let state = self.state.borrow();
        let mut removals = Vec::new();
        let mut additions = Vec::new();
        let mut puzzle_solutions = Vec::new();
        let mut agg_sig_pairs: Vec<(chia_bls::PublicKey, Vec<u8>)> = Vec::new();
        let mut aggregate_signature = Aggsig::default();
        let mut total_input = Amount::default();
        let mut total_output = Amount::default();
        let mut total_reserve_fee = Amount::default();

        for (i, tx) in txs.iter().enumerate() {
            let coin_id = tx.coin.to_coin_id();

            let record = match state.coins.get(&coin_id) {
                Some(r) => r,
                None => {
                    if self.strict {
                        panic!("Strict mode: Coin not found: {coin_id:?}",);
                    }
                    return Ok(IncludeTransactionResult {
                        code: 3,
                        e: Some(5),
                        diagnostic: format!("Coin not found: {:?}", coin_id),
                    });
                }
            };

            if record.spent_height.is_some() {
                if self.strict {
                    panic!("Strict mode: Coin already spent: {coin_id:?}",);
                }
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(5),
                    diagnostic: format!("Coin already spent: {:?}", coin_id),
                });
            }

            let (_, _, coin_amount) = tx.coin.get_coin_string_parts()?;
            total_input += coin_amount;

            let puzzle_program: Program = (*tx.bundle.puzzle.to_program()).clone();
            let computed_ph = puzzle_program.sha256tree(allocator);
            if computed_ph != record.puzzle_hash {
                if self.strict {
                    panic!(
                        "Strict mode: puzzle hash MISMATCH for coin {i}: coin_id={coin_id:?} coin_ph={:?} computed_ph={computed_ph:?}",
                        record.puzzle_hash,
                    );
                }
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(6),
                    diagnostic: format!(
                        "Puzzle hash mismatch for coin {}: expected {:?}, got {computed_ph:?}",
                        i, record.puzzle_hash,
                    ),
                });
            }
            let solution_bytes = tx.bundle.solution.to_clvm(allocator).into_gen()?;
            let solution_program = Program::from_nodeptr(allocator, solution_bytes)?;

            let conditions = match CoinCondition::from_puzzle_and_solution(
                allocator,
                &puzzle_program,
                &solution_program,
            ) {
                Ok(c) => c,
                Err(e) => {
                    let puzzle_hex = puzzle_program.to_hex();
                    let sol_hex = solution_program.to_hex();
                    if self.strict {
                        panic!(
                            "Strict mode: CLVM execution error for coin {i}: \
                             coin_id={coin_id:?} coin_ph={:?} computed_ph={computed_ph:?}\n  \
                             puzzle_len={} solution_len={}\n  err={e:?}",
                            record.puzzle_hash,
                            puzzle_hex.len() / 2,
                            sol_hex.len() / 2,
                        );
                    }
                    eprintln!(
                        "PUSH_TX: CLVM error for coin {i}: coin_id={:?} coin_ph={:?} computed_ph={computed_ph:?}\n  puzzle_len={} solution_len={}\n  err={e:?}",
                        coin_id, record.puzzle_hash, puzzle_hex.len() / 2, sol_hex.len() / 2,
                    );
                    let _ = std::fs::write("/tmp/failing_puzzle.hex", &puzzle_hex);
                    let _ = std::fs::write("/tmp/failing_solution.hex", &sol_hex);
                    return Ok(IncludeTransactionResult {
                        code: 3,
                        e: Some(7),
                        diagnostic: format!("CLVM execution error for coin {}: {:?}", i, e),
                    });
                }
            };

            for cond in &conditions {
                match cond {
                    CoinCondition::CreateCoin(ph, amt) => {
                        total_output += amt.clone();
                        additions.push((coin_id.clone(), ph.clone(), amt.clone()));
                    }
                    CoinCondition::AggSigMe(pk, msg) => {
                        let full_msg = agg_sig_me_message(
                            msg,
                            &coin_id,
                            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
                        );
                        agg_sig_pairs.push((pk.to_bls(), full_msg));
                    }
                    CoinCondition::AggSigUnsafe(pk, msg) => {
                        agg_sig_pairs.push((pk.to_bls(), msg.clone()));
                    }
                    CoinCondition::ReserveFee(amt) => {
                        total_reserve_fee += amt.clone();
                    }
                    CoinCondition::AssertHeightRelative(blocks) => {
                        let elapsed = state.height.saturating_sub(record.created_height);
                        if (elapsed as u64) < *blocks {
                            if self.strict {
                                panic!(
                                    "Strict mode: ASSERT_HEIGHT_RELATIVE violated: \
                                     coin {:?} created at height {}, current height {}, \
                                     elapsed {} but required {}",
                                    coin_id, record.created_height, state.height, elapsed, blocks,
                                );
                            }
                            return Ok(IncludeTransactionResult {
                                code: 3,
                                e: Some(8),
                                diagnostic: format!(
                                    "Relative timelock not satisfied: elapsed {} < required {}",
                                    elapsed, blocks,
                                ),
                            });
                        }
                    }
                    _ => {}
                }
            }

            removals.push(coin_id.clone());
            puzzle_solutions.push((coin_id, puzzle_program, solution_program));

            if i == 0 {
                aggregate_signature = tx.bundle.signature.clone();
            } else {
                aggregate_signature += tx.bundle.signature.clone();
            }
        }

        if total_output > total_input {
            if self.strict {
                panic!(
                    "Strict mode: Minting coins: outputs ({}) exceed inputs ({})",
                    total_output.to_u64(),
                    total_input.to_u64(),
                );
            }
            return Ok(IncludeTransactionResult {
                code: 3,
                e: Some(20),
                diagnostic: format!(
                    "Minting coins: outputs ({}) exceed inputs ({})",
                    total_output.to_u64(),
                    total_input.to_u64()
                ),
            });
        }

        let implicit_fee = Amount::new(total_input.to_u64() - total_output.to_u64());
        if total_reserve_fee > implicit_fee {
            if self.strict {
                panic!(
                    "Strict mode: RESERVE_FEE not satisfied: declared {} but only {} available",
                    total_reserve_fee.to_u64(),
                    implicit_fee.to_u64(),
                );
            }
            return Ok(IncludeTransactionResult {
                code: 3,
                e: Some(21),
                diagnostic: format!(
                    "RESERVE_FEE not satisfied: declared {} but only {} available",
                    total_reserve_fee.to_u64(),
                    implicit_fee.to_u64()
                ),
            });
        }

        if self.strict && implicit_fee != total_reserve_fee {
            return Ok(IncludeTransactionResult {
                code: 3,
                e: Some(22),
                diagnostic: format!(
                    "Strict mode: implicit fee ({}) != declared RESERVE_FEE ({}). \
                     All fees must be explicitly declared.",
                    implicit_fee.to_u64(),
                    total_reserve_fee.to_u64()
                ),
            });
        }

        // Check for duplicate or conflicting transactions already in the mempool.
        for existing in state.mempool.iter() {
            let overlap: Vec<&CoinID> = removals
                .iter()
                .filter(|r| existing.removals.contains(r))
                .collect();
            if !overlap.is_empty() {
                if existing.removals == removals && existing.additions == additions {
                    // Identical transaction already in mempool -- de-duplicate.
                    return Ok(IncludeTransactionResult {
                        code: 1,
                        e: None,
                        diagnostic: "duplicate transaction de-duplicated".to_string(),
                    });
                }
                if self.strict {
                    panic!(
                        "Strict mode: conflicting transactions in mempool: existing tx and new tx both \
                         spend {:?}. Existing removals={:?}, new removals={:?}",
                        overlap, existing.removals, removals,
                    );
                }
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(9),
                    diagnostic: format!(
                        "Conflicting transaction: overlapping spends {:?}",
                        overlap,
                    ),
                });
            }
        }

        drop(state);

        if !agg_sig_pairs.is_empty() {
            let pairs: Vec<(&chia_bls::PublicKey, &[u8])> = agg_sig_pairs
                .iter()
                .map(|(pk, msg)| (pk, msg.as_slice()))
                .collect();
            if !aggregate_verify(&aggregate_signature.to_bls(), pairs.clone()) {
                if self.strict {
                    panic!(
                        "Strict mode: Aggregate signature verification failed \
                         ({} sig pairs, {} coin spends)",
                        agg_sig_pairs.len(),
                        txs.len(),
                    );
                }
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(10),
                    diagnostic: "Aggregate signature verification failed".to_string(),
                });
            }
        }

        self.state.borrow_mut().mempool.push(PendingSpend {
            removals,
            additions,
            puzzle_solutions,
        });

        Ok(IncludeTransactionResult {
            code: 1,
            e: None,
            diagnostic: String::new(),
        })
    }

    pub fn spend_coin_to_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
        identity: &ChiaIdentity,
        puzzle: &Puzzle,
        coin: &CoinString,
        target_coins: &[(PuzzleHash, Amount)],
    ) -> Result<Vec<CoinString>, Error> {
        let agg_sig_me_additional_data = Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA);
        let (_first_coin_parent, first_coin_ph, _first_coin_amt) = coin.get_coin_string_parts()?;
        assert_eq!(puzzle.sha256tree(allocator), first_coin_ph);

        let conditions_vec = map_m(
            |(ph, amt): &(PuzzleHash, Amount)| -> Result<Node, Error> {
                Ok(Node(
                    (CREATE_COIN, (ph.clone(), (amt.clone(), ())))
                        .to_clvm(allocator)
                        .into_gen()?,
                ))
            },
            target_coins,
        )?;
        let conditions = conditions_vec.to_clvm(allocator).into_gen()?;

        let coin_spend_info = standard_solution_partial(
            allocator,
            &identity.synthetic_private_key,
            &coin.to_coin_id(),
            conditions,
            &identity.synthetic_public_key,
            &agg_sig_me_additional_data,
            false,
        )
        .expect("should build");

        let quoted_conds = conditions
            .to_quoted_program(allocator)
            .expect("should work");
        let hashed_conds = quoted_conds.sha256tree(allocator);
        let agg_sig_me_message = agg_sig_me_message(
            hashed_conds.bytes(),
            &coin.to_coin_id(),
            &agg_sig_me_additional_data,
        );
        debug!("our message {agg_sig_me_message:?}");
        let signature2 = identity.synthetic_private_key.sign(&agg_sig_me_message);
        assert_eq!(coin_spend_info.signature, signature2);

        let specific = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: coin_spend_info.solution.clone(),
                signature: coin_spend_info.signature,
            },
        };

        let status = self.push_tx(allocator, &[specific])?;
        if status.code == 3 {
            return Err(Error::StrErr("failed to spend coin".to_string()));
        }

        Ok(target_coins
            .iter()
            .map(|(ph, amt)| CoinString::from_parts(&coin.to_coin_id(), ph, amt))
            .collect())
    }

    pub fn transfer_coin_amount(
        &self,
        allocator: &mut AllocEncoder,
        identity_target: &PuzzleHash,
        identity_source: &ChiaIdentity,
        source_coin: &CoinString,
        target_amt: Amount,
    ) -> Result<(CoinString, CoinString), Error> {
        let (_parent, _, amt) = source_coin.get_coin_string_parts()?;

        let change_amt = amt.clone() - target_amt.clone();
        let first_coin =
            CoinString::from_parts(&source_coin.to_coin_id(), identity_target, &target_amt);
        let second_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_source.puzzle_hash,
            &change_amt,
        );

        let conditions = (
            (
                CREATE_COIN,
                (identity_target.clone(), (target_amt.clone(), ())),
            ),
            (
                (
                    CREATE_COIN,
                    (identity_source.puzzle_hash.clone(), (change_amt, ())),
                ),
                (),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;
        let quoted_conditions = conditions.to_quoted_program(allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
        let standard_solution = solution_for_conditions(allocator, conditions)?;
        let signature = sign_agg_sig_me(
            &identity_source.synthetic_private_key,
            quoted_conditions_hash.bytes(),
            &source_coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            bundle: Spend {
                puzzle: identity_source.puzzle.clone(),
                solution: Program::from_nodeptr(allocator, standard_solution)?.into(),
                signature,
            },
            coin: source_coin.clone(),
        };
        let included = self.push_tx(allocator, &[tx])?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend: {included:?}")));
        }
        Ok((first_coin, second_coin))
    }

    pub fn combine_coins(
        &self,
        allocator: &mut AllocEncoder,
        owner: &ChiaIdentity,
        target_ph: &PuzzleHash,
        coins: &[CoinString],
    ) -> Result<CoinString, Error> {
        let mut amount = Amount::default();
        let mut spends = Vec::new();
        let nil = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[]))
            .into_gen()?;

        if coins.is_empty() {
            return Err(Error::StrErr("no coins".to_string()));
        }

        for (i, c) in coins.iter().enumerate() {
            let (_, _, amt) = c.get_coin_string_parts()?;
            amount += amt.clone();
            let conditions = if i == coins.len() - 1 {
                ((CREATE_COIN, (target_ph.clone(), (amount.clone(), ()))), ())
                    .to_clvm(allocator)
                    .into_gen()?
            } else {
                nil
            };
            let solution = solution_for_conditions(allocator, conditions)?;
            let quoted_conditions = conditions.to_quoted_program(allocator)?;
            let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
            let signature = sign_agg_sig_me(
                &owner.synthetic_private_key,
                quoted_conditions_hash.bytes(),
                &c.to_coin_id(),
                &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
            );
            spends.push(CoinSpend {
                bundle: Spend {
                    puzzle: owner.puzzle.clone(),
                    solution: Program::from_nodeptr(allocator, solution)?.into(),
                    signature,
                },
                coin: c.clone(),
            });
        }

        let included = self.push_tx(allocator, &spends)?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend: {included:?}")));
        }

        Ok(CoinString::from_parts(
            &coins[coins.len() - 1].to_coin_id(),
            target_ph,
            &amount,
        ))
    }
}

#[cfg(test)]
pub fn run_simulation_tests() {
    use std::backtrace::Backtrace;
    std::panic::set_hook(Box::new(|panic_info| {
        if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            eprintln!("panic payload: {s}");
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            eprintln!("panic payload: {s}");
        } else {
            eprintln!("panic payload: <non-string>");
        }
        let trace = Backtrace::force_capture();
        eprintln!("{trace}");
        std::process::exit(1);
    }));
    let ref_lists: Vec<Vec<(&str, &(dyn Fn() + Send + Sync))>> = vec![
        divmod_tests(),
        standard_coin_tests(),
        chialisp_tests(),
        calpoker_game_tests(),
        calpoker_validation_tests(),
        calpoker_handler_tests(),
        channel_handler_tests(),
        debug_game_tests(),
        potato_handler_tests(),
        simulator_tests(),
        calpoker_tests(),
        potato_handler_sim_tests(),
    ];

    let from_filter: Option<String> = std::env::var("SIM_TEST_FROM")
        .ok()
        .filter(|s| !s.is_empty());
    let only_filter: Option<String> = std::env::var("SIM_TEST_ONLY")
        .ok()
        .filter(|s| !s.is_empty());

    let all_tests: Vec<_> = ref_lists.iter().flat_map(|set| set.iter()).collect();

    if let Some(ref f) = only_filter {
        let matched: Vec<_> = all_tests
            .iter()
            .filter(|(name, _)| name.contains(f.as_str()))
            .cloned()
            .collect();
        if matched.is_empty() {
            eprintln!("ERROR: no test name contains '{f}'");
            eprintln!("Available tests:");
            for (name, _) in &all_tests {
                eprintln!("  {name}");
            }
            panic!("SIM_TEST_ONLY='{f}' matched no tests");
        }
        eprintln!("Running {} test(s) matching '{f}'", matched.len());
        let total_start = std::time::Instant::now();
        for (name, func) in &matched {
            eprintln!("RUNNING TEST {name} ...");
            let start = std::time::Instant::now();
            func();
            eprintln!("{name} ... ok ({:.2?})", start.elapsed());
        }
        eprintln!(
            "All {} tests passed in {:.2?}",
            matched.len(),
            total_start.elapsed()
        );
        return;
    }

    let start_idx = if let Some(ref f) = from_filter {
        match all_tests
            .iter()
            .position(|(name, _)| name.contains(f.as_str()))
        {
            Some(idx) => idx,
            None => {
                eprintln!("ERROR: no test name contains '{f}'");
                eprintln!("Available tests:");
                for (name, _) in &all_tests {
                    eprintln!("  {name}");
                }
                panic!("SIM_TEST_FROM='{f}' matched no tests");
            }
        }
    } else {
        0
    };

    let rotated: Vec<_> = all_tests[start_idx..]
        .iter()
        .chain(all_tests[..start_idx].iter())
        .cloned()
        .collect();

    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    eprintln!("Running {} tests with {} threads", rotated.len(), n_threads);

    let queue = std::sync::Arc::new(std::sync::Mutex::new(rotated));
    let total_start = std::time::Instant::now();

    std::thread::scope(|s| {
        let handles: Vec<_> = (0..n_threads)
            .map(|_| {
                let queue = std::sync::Arc::clone(&queue);
                s.spawn(move || loop {
                    let task = queue.lock().unwrap().pop();
                    let Some((name, f)) = task else { break };
                    eprintln!("RUNNING TEST {name} ...");
                    let start = std::time::Instant::now();
                    f();
                    let elapsed = start.elapsed();
                    eprintln!("{name} ... ok ({elapsed:.2?})");
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    });

    eprintln!(
        "All {} tests passed in {:.2?}",
        all_tests.len(),
        total_start.elapsed()
    );
}

#[cfg(test)]
mod test {
    use super::*;

    /// Run simulation tests. Set `SIM_TEST_FROM=<substring>` to start from
    /// the first matching test and wraparound through all tests.
    /// Use `./ct.sh`: `./ct.sh` runs all, `./ct.sh accept_finished` starts there.
    #[test]
    fn sim_tests() {
        run_simulation_tests();
    }
}
