#[cfg(feature = "sim-server")]
pub mod service;
#[cfg(test)]
pub mod tests;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use chia_consensus::consensus_constants::ConsensusConstants;
use chia_consensus::flags::MEMPOOL_MODE;
use chia_consensus::spendbundle_validation::{
    get_flags_for_height_and_constants, validate_clvm_and_signature,
};
use chia_consensus::validation_error::ErrorCode;
use clvm_traits::{ClvmEncoder, ToClvm};

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    agg_sig_me_message, sign_agg_sig_me, solution_for_conditions, standard_solution_partial,
    ChiaIdentity,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, Error, GetCoinStringParts, Hash,
    IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend, ToQuotedProgram,
    MAX_BLOCK_COST_CLVM,
};

use crate::utils::map_m;

#[cfg(test)]
use crate::simulator::tests::potato_handler_sim::test_funs as potato_handler_sim_tests;
#[cfg(test)]
use crate::simulator::tests::simulator_tests::test_funs as simulator_tests;
#[cfg(test)]
use crate::test_support::calpoker::test_funs as calpoker_tests;
#[cfg(test)]
use crate::test_support::spacepoker::test_funs as spacepoker_tests;

#[cfg(test)]
use crate::common::types::divmod::test_funs as divmod_tests;
#[cfg(test)]
use crate::test_support::debug_game::test_funs as debug_game_tests;
#[cfg(test)]
use crate::test_support::peer::potato_handler::test_funs as potato_handler_tests;
#[cfg(test)]
use crate::tests::calpoker_handlers::test_funs as calpoker_handler_tests;
#[cfg(test)]
use crate::tests::calpoker_validation::test_funs as calpoker_validation_tests;
#[cfg(test)]
use crate::tests::spacepoker_validation::test_funs as spacepoker_validation_tests;
#[cfg(test)]
use crate::tests::spacepoker_handlers::test_funs as spacepoker_handler_tests;
#[cfg(test)]
use crate::tests::krunk_handlers::test_funs as krunk_handler_tests;
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
    fingerprint: Hash,
    removals: Vec<CoinID>,
    additions: Vec<(CoinID, PuzzleHash, Amount)>,
    puzzle_solutions: Vec<(CoinID, Program, Program)>,
}

struct SimulatorState {
    coins: HashMap<CoinID, CoinRecord>,
    mempool: Vec<PendingSpend>,
    spent_puzzle_solutions: HashMap<CoinID, (Program, Program)>,
    confirmed_spend_fingerprints: HashSet<Hash>,
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
            confirmed_spend_fingerprints: HashSet::new(),
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
            self.confirmed_spend_fingerprints.insert(spend.fingerprint);
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

fn make_sim_consensus_constants() -> ConsensusConstants {
    let agg_sig_data = chia_protocol::Bytes32::from(AGG_SIG_ME_ADDITIONAL_DATA);
    let zero32 = chia_protocol::Bytes32::from([0u8; 32]);
    ConsensusConstants {
        slot_blocks_target: 32,
        min_blocks_per_challenge_block: 16,
        max_sub_slot_blocks: 128,
        num_sps_sub_slot: 64,
        sub_slot_iters_starting: 1 << 27,
        difficulty_constant_factor: 1 << 67,
        difficulty_starting: 7,
        difficulty_change_max_factor: 3,
        sub_epoch_blocks: 384,
        epoch_blocks: 4608,
        significant_bits: 8,
        discriminant_size_bits: 1024,
        number_zero_bits_plot_filter_v1: 9,
        number_zero_bits_plot_filter_v2: 9,
        min_plot_size_v1: 32,
        max_plot_size_v1: 59,
        plot_size_v2: 30,
        sub_slot_time_target: 600,
        num_sp_intervals_extra: 3,
        max_future_time2: 120,
        number_of_timestamps: 11,
        genesis_challenge: zero32,
        agg_sig_me_additional_data: agg_sig_data,
        agg_sig_parent_additional_data: zero32,
        agg_sig_puzzle_additional_data: zero32,
        agg_sig_amount_additional_data: zero32,
        agg_sig_puzzle_amount_additional_data: zero32,
        agg_sig_parent_amount_additional_data: zero32,
        agg_sig_parent_puzzle_additional_data: zero32,
        genesis_pre_farm_pool_puzzle_hash: zero32,
        genesis_pre_farm_farmer_puzzle_hash: zero32,
        max_vdf_witness_size: 8,
        mempool_block_buffer: 10,
        max_coin_amount: u64::MAX,
            max_block_cost_clvm: MAX_BLOCK_COST_CLVM,
        cost_per_byte: 12000,
        weight_proof_threshold: 2,
        weight_proof_recent_blocks: 1000,
        max_block_count_per_requests: 32,
        blocks_cache_size: 4608 + 128 * 4,
        max_generator_ref_list_size: 512,
        pool_sub_slot_iters: 37_600_000_000,
        hard_fork_height: 0,
        hard_fork2_height: 0,
        soft_fork8_height: 0,
        plot_v1_phase_out_epoch_bits: 0,
        plot_filter_128_height: u32::MAX,
        plot_filter_64_height: u32::MAX,
        plot_filter_32_height: u32::MAX,
        min_plot_strength: 0,
        max_plot_strength: 0,
        plot_filter_v2_first_adjustment_height: 0,
        plot_filter_v2_second_adjustment_height: 0,
        plot_filter_v2_third_adjustment_height: 0,
    }
}

fn to_protocol_spend_bundle(
    allocator: &mut AllocEncoder,
    txs: &[CoinSpend],
) -> Result<chia_protocol::SpendBundle, Error> {
    let mut protocol_spends = Vec::with_capacity(txs.len());
    let mut agg_sig = Aggsig::default();

    for (i, tx) in txs.iter().enumerate() {
        let (parent, ph, amount) = tx.coin.get_coin_string_parts()?;
        let parent_arr: [u8; 32] = parent
            .bytes()
            .try_into()
            .map_err(|_| Error::StrErr("bad parent".into()))?;
        let ph_arr: [u8; 32] = ph
            .bytes()
            .try_into()
            .map_err(|_| Error::StrErr("bad ph".into()))?;
        let coin = chia_protocol::Coin {
            parent_coin_info: chia_protocol::Bytes32::from(parent_arr),
            puzzle_hash: chia_protocol::Bytes32::from(ph_arr),
            amount: amount.to_u64(),
        };
        let puzzle_bytes = tx.bundle.puzzle.to_program().bytes().to_vec();
        let solution_node = tx.bundle.solution.to_clvm(allocator).into_gen()?;
        let solution_bytes = Program::from_nodeptr(allocator, solution_node)?
            .bytes()
            .to_vec();
        protocol_spends.push(chia_protocol::CoinSpend {
            coin,
            puzzle_reveal: chia_protocol::Bytes::from(puzzle_bytes).into(),
            solution: chia_protocol::Bytes::from(solution_bytes).into(),
        });
        if i == 0 {
            agg_sig = tx.bundle.signature.clone();
        } else {
            agg_sig += tx.bundle.signature.clone();
        }
    }

    Ok(chia_protocol::SpendBundle {
        coin_spends: protocol_spends,
        aggregated_signature: agg_sig.to_bls(),
    })
}

fn format_validation_error(code: ErrorCode) -> String {
    let desc = match code {
        ErrorCode::DuplicateOutput => {
            "duplicate output (two CREATE_COINs with same puzzle_hash and amount)"
        }
        ErrorCode::BadAggregateSignature => "bad aggregate signature",
        ErrorCode::InvalidCoinSolution => "invalid coin solution",
        ErrorCode::InvalidBlockSolution => "invalid puzzle reveal",
        ErrorCode::WrongPuzzleHash => "wrong puzzle hash",
        ErrorCode::MintingCoin => "minting coin (outputs exceed input amount)",
        ErrorCode::CostExceeded => "cost exceeded",
        ErrorCode::InvalidCondition => "invalid condition",
        ErrorCode::InvalidPublicKey => "invalid public key in condition",
        ErrorCode::InvalidMessage => "invalid message in condition",
        ErrorCode::InvalidCoinAmount => "invalid coin amount",
        ErrorCode::ReserveFeeConditionFailed => "RESERVE_FEE condition failed",
        ErrorCode::AssertCoinAnnouncementFailed => "ASSERT_COIN_ANNOUNCEMENT failed",
        ErrorCode::AssertPuzzleAnnouncementFailed => "ASSERT_PUZZLE_ANNOUNCEMENT failed",
        ErrorCode::AssertHeightRelativeFailed => "ASSERT_HEIGHT_RELATIVE failed",
        ErrorCode::AssertHeightAbsoluteFailed => "ASSERT_HEIGHT_ABSOLUTE failed",
        ErrorCode::AssertSecondsAbsoluteFailed => "ASSERT_SECONDS_ABSOLUTE failed",
        ErrorCode::AssertSecondsRelativeFailed => "ASSERT_SECONDS_RELATIVE failed",
        ErrorCode::AssertMyCoinIdFailed => "ASSERT_MY_COIN_ID failed",
        ErrorCode::AssertMyPuzzleHashFailed => "ASSERT_MY_PUZZLEHASH failed",
        ErrorCode::AssertMyAmountFailed => "ASSERT_MY_AMOUNT failed",
        ErrorCode::GeneratorRuntimeError => "CLVM runtime error",
        ErrorCode::DoubleSpend => "double spend",
        _ => "validation error",
    };
    format!("{desc} ({code:?})")
}

impl Simulator {
    fn fingerprint_spend_bundle(spends: &[CoinSpend]) -> Hash {
        let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(spends.len() * 4);
        for spend in spends {
            chunks.push(spend.coin.to_bytes().to_vec());
            chunks.push(spend.bundle.puzzle.to_program().bytes().to_vec());
            chunks.push(spend.bundle.solution.pref().bytes().to_vec());
            chunks.push(spend.bundle.signature.0.to_vec());
        }
        let parts: Vec<Sha256Input<'_>> = chunks
            .iter()
            .map(|chunk| Sha256Input::Bytes(chunk))
            .collect();
        Sha256Input::Array(parts).hash()
    }

    pub fn new(strict: bool) -> Self {
        let mut state = SimulatorState::new();
        let zero_ph = PuzzleHash::from_hash(Hash::from_bytes([0u8; 32]));
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

    pub fn select_coins(
        &self,
        puzzle_hash: &PuzzleHash,
        amount: &Amount,
    ) -> Result<Option<CoinString>, Error> {
        let coins = self.get_my_coins(puzzle_hash)?;
        for coin in coins {
            if let Some((_, _, coin_amount)) = coin.to_parts() {
                if &coin_amount >= amount {
                    return Ok(Some(coin));
                }
            }
        }
        Ok(None)
    }

    pub fn find_coin_by_id(&self, coin_id: &CoinID) -> Result<Option<CoinString>, Error> {
        let state = self.state.borrow();
        match state.coins.get(coin_id) {
            Some(record) if record.spent_height.is_none() => Ok(Some(record.coin.clone())),
            _ => Ok(None),
        }
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

    pub fn is_coin_spent(&self, coin: &CoinString) -> bool {
        let state = self.state.borrow();
        let coin_id = coin.to_coin_id();
        match state.coins.get(&coin_id) {
            Some(r) => r.spent_height.is_some(),
            None => false,
        }
    }

    /// Coin state for a watched coin id (including spent coins still in the map).
    /// Used by the gaming FE to mirror WalletConnect `getCoinRecordsByNames`.
    pub fn get_watched_coin_snapshot(
        &self,
        coin_id: &CoinID,
    ) -> Option<(CoinString, u32, Option<u32>)> {
        let state = self.state.borrow();
        state
            .coins
            .get(coin_id)
            .map(|r| (r.coin.clone(), r.created_height, r.spent_height))
    }

    pub fn push_transactions(
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

        let tx_fingerprint = Self::fingerprint_spend_bundle(txs);
        let state = self.state.borrow();
        if state.confirmed_spend_fingerprints.contains(&tx_fingerprint) {
            return Ok(IncludeTransactionResult {
                code: 1,
                e: None,
                diagnostic: "duplicate confirmed transaction re-submitted".to_string(),
            });
        }

        // --- Intrinsic validation via chia-consensus ---
        // This catches: CLVM errors, bad puzzle hashes, duplicate outputs,
        // invalid conditions, bad aggregate signature, overspend, etc.
        let protocol_bundle = to_protocol_spend_bundle(allocator, txs)?;
        let constants = make_sim_consensus_constants();
        let flags = get_flags_for_height_and_constants(state.height, &constants) | MEMPOOL_MODE;
        let validated = match validate_clvm_and_signature(
            &protocol_bundle,
            constants.max_block_cost_clvm,
            &constants,
            flags,
        ) {
            Ok(v) => v.0,
            Err(err) => {
                let msg = format_validation_error(err.1);
                if self.strict {
                    panic!("Strict mode: spend bundle rejected: {msg}");
                }
                let code_num: u32 = err.1.into();
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(code_num),
                    diagnostic: msg,
                });
            }
        };

        // --- State-dependent checks (need coin store / mempool) ---
        let mut removals = Vec::new();
        let mut additions = Vec::new();
        let mut puzzle_solutions = Vec::new();
        let mut ephemeral_coins: HashMap<CoinID, PuzzleHash> = HashMap::new();

        for (i, tx) in txs.iter().enumerate() {
            let coin_id = tx.coin.to_coin_id();

            let record_created_height = if let Some(record) = state.coins.get(&coin_id) {
                if record.spent_height.is_some() {
                    if self.strict {
                        panic!("Strict mode: Coin already spent: {coin_id:?}");
                    }
                    return Ok(IncludeTransactionResult {
                        code: 3,
                        e: Some(5),
                        diagnostic: format!("Coin already spent: {:?}", coin_id),
                    });
                }
                record.created_height
            } else if ephemeral_coins.remove(&coin_id).is_some() {
                state.height
            } else {
                if self.strict {
                    panic!("Strict mode: Coin not found: {coin_id:?}");
                }
                return Ok(IncludeTransactionResult {
                    code: 3,
                    e: Some(5),
                    diagnostic: format!("Coin not found: {:?}", coin_id),
                });
            };

            // Use validated conditions for state tracking.
            if let Some(spend_conds) = validated.spends.get(i) {
                for (ph_bytes, amt, _memo) in &spend_conds.create_coin {
                    let ph = PuzzleHash::from_hash(Hash::from_bytes(ph_bytes.to_bytes()));
                    let amount = Amount::new(*amt);
                    let child = CoinString::from_parts(&coin_id, &ph, &amount);
                    ephemeral_coins.insert(child.to_coin_id(), ph.clone());
                    additions.push((coin_id.clone(), ph, amount));
                }

                // ASSERT_HEIGHT_RELATIVE needs the actual creation height.
                if let Some(required) = spend_conds.height_relative {
                    let elapsed = state.height.saturating_sub(record_created_height);
                    if elapsed < required {
                        if self.strict {
                            panic!(
                                "Strict mode: ASSERT_HEIGHT_RELATIVE violated: \
                                 coin {:?} created at height {}, current height {}, \
                                 elapsed {} but required {}",
                                coin_id, record_created_height, state.height, elapsed, required,
                            );
                        }
                        return Ok(IncludeTransactionResult {
                            code: 3,
                            e: Some(8),
                            diagnostic: format!(
                                "Relative timelock not satisfied: elapsed {} < required {}",
                                elapsed, required,
                            ),
                        });
                    }
                }
            }

            removals.push(coin_id.clone());
            let puzzle_program: Program = (*tx.bundle.puzzle.to_program()).clone();
            let solution_node = tx.bundle.solution.to_clvm(allocator).into_gen()?;
            let solution_program = Program::from_nodeptr(allocator, solution_node)?;
            puzzle_solutions.push((coin_id, puzzle_program, solution_program));
        }

        if self.strict {
            let total_input = validated.removal_amount;
            let total_output = validated.addition_amount;
            let implicit_fee = total_input - total_output;
            if implicit_fee != validated.reserve_fee as u128 {
                panic!(
                    "Strict mode: implicit fee ({}) != declared RESERVE_FEE ({}). \
                     All fees must be explicitly declared.",
                    implicit_fee, validated.reserve_fee,
                );
            }
        }

        // Check for duplicate or conflicting transactions already in the mempool.
        for existing in state.mempool.iter() {
            if existing.fingerprint == tx_fingerprint {
                return Ok(IncludeTransactionResult {
                    code: 1,
                    e: None,
                    diagnostic: "duplicate transaction de-duplicated".to_string(),
                });
            }
            let overlap: Vec<&CoinID> = removals
                .iter()
                .filter(|r| existing.removals.contains(r))
                .collect();
            if !overlap.is_empty() {
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

        self.state.borrow_mut().mempool.push(PendingSpend {
            fingerprint: tx_fingerprint,
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
        let agg_sig_me_additional_data = Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA);
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

        let status = self.push_transactions(allocator, &[specific])?;
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

        let change_amt = amt.checked_sub(&target_amt)?;
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
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            bundle: Spend {
                puzzle: identity_source.puzzle.clone(),
                solution: Program::from_nodeptr(allocator, standard_solution)?.into(),
                signature,
            },
            coin: source_coin.clone(),
        };
        let included = self.push_transactions(allocator, &[tx])?;
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
                &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
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

        let included = self.push_transactions(allocator, &spends)?;
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
thread_local! {
    static CURRENT_TEST_NAME: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn current_test_name() -> Option<String> {
    CURRENT_TEST_NAME.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
pub fn run_simulation_tests() {
    use std::backtrace::Backtrace;
    std::panic::set_hook(Box::new(|panic_info| {
        let test_name = CURRENT_TEST_NAME.with(|cell| cell.borrow().clone());
        if let Some(name) = &test_name {
            eprintln!("PANIC IN TEST: {name}");
        }
        if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            eprintln!("panic payload: {s}");
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            eprintln!("panic payload: {s}");
        } else {
            eprintln!("panic payload: <non-string>");
        }
        let trace = Backtrace::force_capture();
        eprintln!("{trace}");
        if test_name.is_none() {
            std::process::exit(1);
        }
    }));
    let ref_lists: Vec<Vec<(&str, &(dyn Fn() + Send + Sync))>> = vec![
        divmod_tests(),
        standard_coin_tests(),
        chialisp_tests(),
        calpoker_validation_tests(),
        spacepoker_validation_tests(),
        spacepoker_handler_tests(),
        krunk_handler_tests(),
        calpoker_handler_tests(),
        channel_handler_tests(),
        debug_game_tests(),
        potato_handler_tests(),
        simulator_tests(),
        calpoker_tests(),
        spacepoker_tests(),
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
            CURRENT_TEST_NAME.with(|cell| *cell.borrow_mut() = Some(name.to_string()));
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
    let failures: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let total_start = std::time::Instant::now();

    std::thread::scope(|s| {
        let handles: Vec<_> = (0..n_threads)
            .map(|_| {
                let queue = std::sync::Arc::clone(&queue);
                let failures = std::sync::Arc::clone(&failures);
                s.spawn(move || loop {
                    let task = queue.lock().unwrap().pop();
                    let Some((name, f)) = task else { break };
                    CURRENT_TEST_NAME.with(|cell| *cell.borrow_mut() = Some(name.to_string()));
                    eprintln!("RUNNING TEST {name} ...");
                    let start = std::time::Instant::now();
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f()));
                    let elapsed = start.elapsed();
                    match result {
                        Ok(()) => eprintln!("{name} ... ok ({elapsed:.2?})"),
                        Err(payload) => {
                            let msg = if let Some(s) = payload.downcast_ref::<String>() {
                                s.clone()
                            } else if let Some(s) = payload.downcast_ref::<&str>() {
                                s.to_string()
                            } else {
                                "(non-string panic)".to_string()
                            };
                            eprintln!("PANIC IN TEST: {name}\npanic payload: {msg}");
                            failures.lock().unwrap().push((name.to_string(), msg));
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    });

    let failed = failures.lock().unwrap();
    if failed.is_empty() {
        eprintln!(
            "All {} tests passed in {:.2?}",
            all_tests.len(),
            total_start.elapsed()
        );
    } else {
        eprintln!("\n--- {} FAILED TEST(S) ---", failed.len());
        for (name, msg) in failed.iter() {
            eprintln!("\n  FAIL: {name}\n  {msg}");
        }
        eprintln!(
            "\n{} passed, {} failed in {:.2?}",
            all_tests.len() - failed.len(),
            failed.len(),
            total_start.elapsed()
        );
        panic!("{} test(s) failed", failed.len());
    }
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
