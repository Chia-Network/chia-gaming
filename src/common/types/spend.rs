use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::NodePtr;
use serde::{Deserialize, Serialize};
use std::mem::MaybeUninit;

use chia_consensus::allocator::make_allocator;
use chia_consensus::conditions::{
    process_single_spend, MempoolVisitor, ParseState, SpendBundleConditions,
};
use chia_consensus::consensus_constants::ConsensusConstants;
use chia_consensus::flags::{ConsensusFlags, MEMPOOL_MODE};
use chia_consensus::run_block_generator::subtract_cost;
use chia_consensus::solution_generator::calculate_generator_length;
use chia_consensus::spendbundle_conditions::run_spendbundle;
use chia_consensus::spendbundle_validation::get_flags_for_height_and_constants;
use chia_protocol::{Bytes, Bytes32};
use clvm_utils::tree_hash;
use clvmr::chia_dialect::ChiaDialect;
use clvmr::reduction::Reduction;
#[cfg(test)]
use clvmr::run_program;
use clvmr::run_program_with_diagnostics;
use clvmr::serde::node_from_bytes;

use crate::clvm_execution::{clvm_error_from_failure, MAX_CAPTURED_FRAMES};
use crate::common::types::atom_from_clvm;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinID, CoinString, Error, GetCoinStringParts,
    Hash, IntoErr, Node, Program, ProgramRef, Puzzle, PuzzleHash, Sha256Input, Sha256tree,
};
use crate::utils::proper_list;

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct Spend {
    pub puzzle: Puzzle,
    pub solution: ProgramRef,
    pub signature: Aggsig,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Spend {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        (
            self.puzzle.clone(),
            (self.solution.clone(), (self.signature.clone(), ())),
        )
            .to_clvm(encoder)
    }
}

impl Spend {
    pub fn from_clvm(allocator: &AllocEncoder, data: NodePtr) -> Result<Spend, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator_ref(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("not list".to_string()));
        };

        if lst.len() < 3 {
            return Err(Error::StrErr("bad length".to_string()));
        }

        let puzzle = Puzzle::from_nodeptr(allocator, lst[0])?;
        let solution = Program::from_nodeptr(allocator, lst[1])?;
        let signature_atom = if let Some(s) = atom_from_clvm(allocator, lst[2]) {
            s
        } else {
            return Err(Error::StrErr("bad sig".to_string()));
        };

        let signature = Aggsig::from_slice(&signature_atom)?;
        Ok(Spend {
            puzzle,
            solution: solution.into(),
            signature,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct CoinSpend {
    pub coin: CoinString,
    pub bundle: Spend,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for CoinSpend {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        let cs_bytes = self.coin.to_bytes();
        let cs_atom = encoder.encode_atom(clvm_traits::Atom::Borrowed(cs_bytes))?;
        (Node(cs_atom), (self.bundle.clone(), ())).to_clvm(encoder)
    }
}

impl CoinSpend {
    pub fn from_clvm(allocator: &AllocEncoder, data: NodePtr) -> Result<CoinSpend, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator_ref(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("bad list".to_string()));
        };

        if lst.len() < 2 {
            return Err(Error::StrErr("bad length".to_string()));
        }

        let coin_bytes = if let Some(by) = atom_from_clvm(allocator, lst[0]) {
            by
        } else {
            return Err(Error::StrErr("bad coin".to_string()));
        };

        let coin = CoinString::from_bytes(&coin_bytes);
        let bundle = Spend::from_clvm(allocator, lst[1])?;

        Ok(CoinSpend { coin, bundle })
    }
}

impl Default for Spend {
    fn default() -> Self {
        Spend {
            puzzle: Program::nil().into(),
            solution: Program::nil().into(),
            signature: Aggsig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct SpendBundle {
    pub name: Option<String>,
    pub spends: Vec<CoinSpend>,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for SpendBundle {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.spends.to_clvm(encoder)
    }
}

impl SpendBundle {
    pub fn from_clvm(allocator: &AllocEncoder, data: NodePtr) -> Result<SpendBundle, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator_ref(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("bad list".to_string()));
        };

        let mut spends = Vec::new();
        for b in lst.iter() {
            let cs = CoinSpend::from_clvm(allocator, *b)?;
            spends.push(cs);
        }

        Ok(SpendBundle { name: None, spends })
    }

    /// Run Chia's intrinsic mempool validation over this exact bundle.
    ///
    /// This validates all spends together, including aggregate signatures,
    /// duplicate removals, and announcement creation/assertion relationships.
    /// Coin-store state and current-height time-lock checks remain the host
    /// node's responsibility.
    pub fn validate_consensus(
        &self,
        agg_sig_me_additional_data: &Hash,
        height: u64,
    ) -> Result<(), Error> {
        if self.spends.is_empty() {
            return Err(Error::StrErr("empty spend bundle".to_string()));
        }

        let mut coin_spends = Vec::with_capacity(self.spends.len());
        let mut aggregated_signature = Aggsig::default();
        for spend in &self.spends {
            let (parent, puzzle_hash, amount) = spend.coin.get_coin_string_parts()?;
            let parent: [u8; 32] = parent
                .bytes()
                .try_into()
                .map_err(|_| Error::StrErr("invalid coin parent length".to_string()))?;
            let puzzle_hash: [u8; 32] = puzzle_hash
                .bytes()
                .try_into()
                .map_err(|_| Error::StrErr("invalid coin puzzle hash length".to_string()))?;
            coin_spends.push(chia_protocol::CoinSpend {
                coin: chia_protocol::Coin {
                    parent_coin_info: Bytes32::from(parent),
                    puzzle_hash: Bytes32::from(puzzle_hash),
                    amount: amount.to_u64(),
                },
                puzzle_reveal: Bytes::from(spend.bundle.puzzle.to_program().bytes().to_vec())
                    .into(),
                solution: Bytes::from(spend.bundle.solution.pref().bytes().to_vec()).into(),
            });
            aggregated_signature += spend.bundle.signature.clone();
        }

        let protocol_bundle = chia_protocol::SpendBundle {
            coin_spends,
            aggregated_signature: aggregated_signature.to_bls(),
        };
        let constants = validation_consensus_constants(agg_sig_me_additional_data);
        let height = u32::try_from(height)
            .map_err(|_| Error::StrErr(format!("validation height {height} exceeds u32")))?;
        let flags = get_flags_for_height_and_constants(height, &constants) | MEMPOOL_MODE;
        let mut allocator = make_allocator(ConsensusFlags::LIMIT_HEAP);
        let consensus_result = run_spendbundle(
            &mut allocator,
            &protocol_bundle,
            constants.max_block_cost_clvm,
            flags,
            &constants,
            None,
        );
        let (_conditions, signature_pairs) = match consensus_result {
            Ok(result) => result,
            Err(err) => {
                if let Some(clvm_error) = replay_consensus_eval_error(
                    &protocol_bundle,
                    constants.max_block_cost_clvm,
                    flags,
                    &constants,
                    &format!("{:?}", err.error_code()),
                ) {
                    return Err(clvm_error);
                }
                return Err(Error::StrErr(format!(
                    "spend bundle consensus validation failed: {:?}",
                    err.error_code()
                )));
            }
        };
        if !aggregate_verify_aligned(
            &protocol_bundle.aggregated_signature,
            signature_pairs
                .iter()
                .map(|(public_key, message)| (public_key, message.as_ref())),
        ) {
            return Err(Error::StrErr(
                "spend bundle has an invalid aggregate signature".to_string(),
            ));
        }
        Ok(())
    }
}

/// Replay the per-spend portion of `run_spendbundle` after it has failed.
///
/// This deliberately mirrors byte, execution, and condition cost accounting
/// only far enough to recover an `EvalErr`. Any serialization or consensus
/// condition failure returns `None`, preserving the original `ErrorCode`.
fn replay_consensus_eval_error(
    spend_bundle: &chia_protocol::SpendBundle,
    max_cost: u64,
    flags: ConsensusFlags,
    constants: &ConsensusConstants,
    consensus_error: &str,
) -> Option<Error> {
    #[cfg(test)]
    CONSENSUS_REPLAY_ATTEMPTS.with(|attempts| attempts.set(attempts.get() + 1));

    const QUOTE_BYTES: usize = 2;
    let generator_length = calculate_generator_length(&spend_bundle.coin_spends);
    let byte_length = generator_length.checked_sub(QUOTE_BYTES)?;
    let byte_cost = u64::try_from(byte_length)
        .ok()?
        .checked_mul(constants.cost_per_byte)?;

    let mut allocator = make_allocator(ConsensusFlags::LIMIT_HEAP);
    let mut cost_left = max_cost;
    subtract_cost(&mut cost_left, byte_cost).ok()?;

    let dialect_flags = flags.to_clvm_flags();
    let dialect = ChiaDialect::new(dialect_flags);
    let mut conditions = SpendBundleConditions::default();
    let mut state = ParseState::default();

    for (index, coin_spend) in spend_bundle.coin_spends.iter().enumerate() {
        let puzzle = node_from_bytes(&mut allocator, coin_spend.puzzle_reveal.as_slice()).ok()?;
        let solution = node_from_bytes(&mut allocator, coin_spend.solution.as_slice()).ok()?;
        let parent = allocator
            .new_atom(coin_spend.coin.parent_coin_info.as_slice())
            .ok()?;
        let amount = allocator.new_number(coin_spend.coin.amount.into()).ok()?;

        let atoms_before = allocator.atom_count();
        let pairs_before = allocator.pair_count();
        let Reduction(clvm_cost, output) = match run_program_with_diagnostics(
            &mut allocator,
            &dialect,
            puzzle,
            solution,
            cost_left,
            MAX_CAPTURED_FRAMES,
        ) {
            Ok(reduction) => reduction,
            Err(failure) => {
                return Some(clvm_error_from_failure(
                    &allocator,
                    failure,
                    Some(format!(
                        "spend bundle consensus validation failed ({consensus_error}); \
                             replayed coin spend {index}"
                    )),
                ));
            }
        };
        conditions.execution_cost += clvm_cost;
        subtract_cost(&mut cost_left, clvm_cost).ok()?;

        let atom_count = (allocator.atom_count() - atoms_before) as u64;
        let pair_count = (allocator.pair_count() - pairs_before) as u64;
        let puzzle_hash = tree_hash(&allocator, puzzle);
        if coin_spend.coin.puzzle_hash != puzzle_hash.into() {
            return None;
        }
        let puzzle_hash = allocator.new_atom(&puzzle_hash).ok()?;
        process_single_spend::<MempoolVisitor>(
            &allocator,
            &mut conditions,
            &mut state,
            parent,
            puzzle_hash,
            amount,
            output,
            flags,
            &mut cost_left,
            clvm_cost,
            atom_count,
            pair_count,
            constants,
        )
        .ok()?;
    }
    None
}

#[cfg(test)]
thread_local! {
    static CONSENSUS_REPLAY_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_consensus_replay_attempts() {
    CONSENSUS_REPLAY_ATTEMPTS.with(|attempts| attempts.set(0));
}

#[cfg(test)]
fn consensus_replay_attempts() -> usize {
    CONSENSUS_REPLAY_ATTEMPTS.with(std::cell::Cell::get)
}

fn aggregate_verify_aligned<'a, I>(signature: &chia_bls::Signature, pairs: I) -> bool
where
    I: IntoIterator<Item = (&'a chia_bls::PublicKey, &'a [u8])>,
{
    const DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_AUG_";

    let mut pairs = pairs.into_iter().peekable();
    if pairs.peek().is_none() {
        return *signature == chia_bls::Signature::default();
    }
    if !signature.is_valid() {
        return false;
    }

    let signature_bytes = signature.to_bytes();
    let mut signature_affine = MaybeUninit::<blst::blst_p2_affine>::uninit();
    let signature_gt = unsafe {
        if blst::blst_p2_uncompress(signature_affine.as_mut_ptr(), signature_bytes.as_ptr())
            != blst::BLST_ERROR::BLST_SUCCESS
        {
            return false;
        }
        let mut signature_gt = MaybeUninit::<blst::blst_fp12>::uninit();
        blst::blst_aggregated_in_g2(signature_gt.as_mut_ptr(), signature_affine.as_ptr());
        signature_gt.assume_init()
    };

    let context_size = unsafe { blst::blst_pairing_sizeof() };
    const CONTEXT_ALIGNMENT: usize = 64;
    let mut context_storage = vec![0_u8; context_size + CONTEXT_ALIGNMENT - 1];
    let storage_address = context_storage.as_mut_ptr() as usize;
    let aligned_address = (storage_address + CONTEXT_ALIGNMENT - 1) & !(CONTEXT_ALIGNMENT - 1);
    let context = aligned_address as *mut blst::blst_pairing;
    unsafe {
        blst::blst_pairing_init(context, true, DST.as_ptr(), DST.len());
    }

    let mut augmented_message = Vec::new();
    for (public_key, message) in pairs {
        if !public_key.is_valid() {
            return false;
        }
        let public_key_bytes = public_key.to_bytes();
        let mut public_key_affine = MaybeUninit::<blst::blst_p1_affine>::uninit();
        let result = unsafe {
            if blst::blst_p1_uncompress(public_key_affine.as_mut_ptr(), public_key_bytes.as_ptr())
                != blst::BLST_ERROR::BLST_SUCCESS
            {
                return false;
            }
            augmented_message.clear();
            augmented_message.extend_from_slice(&public_key_bytes);
            augmented_message.extend_from_slice(message);
            blst::blst_pairing_aggregate_pk_in_g1(
                context,
                public_key_affine.as_ptr(),
                std::ptr::null(),
                augmented_message.as_ptr(),
                augmented_message.len(),
                std::ptr::null(),
                0,
            )
        };
        if result != blst::BLST_ERROR::BLST_SUCCESS {
            return false;
        }
    }

    unsafe {
        blst::blst_pairing_commit(context);
        blst::blst_pairing_finalverify(context, &raw const signature_gt)
    }
}

fn validation_consensus_constants(agg_sig_me_additional_data: &Hash) -> ConsensusConstants {
    let agg_sig_data = Bytes32::from(*agg_sig_me_additional_data.bytes());
    let derived_agg_sig_data = |opcode: u8| {
        Bytes32::from(
            *Sha256Input::Array(vec![
                Sha256Input::Bytes(agg_sig_me_additional_data.bytes()),
                Sha256Input::Bytes(&[opcode]),
            ])
            .hash()
            .bytes(),
        )
    };
    let zero32 = Bytes32::from([0u8; 32]);
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
        genesis_challenge: agg_sig_data,
        agg_sig_me_additional_data: agg_sig_data,
        agg_sig_parent_additional_data: derived_agg_sig_data(43),
        agg_sig_puzzle_additional_data: derived_agg_sig_data(44),
        agg_sig_amount_additional_data: derived_agg_sig_data(45),
        agg_sig_puzzle_amount_additional_data: derived_agg_sig_data(46),
        agg_sig_parent_amount_additional_data: derived_agg_sig_data(47),
        agg_sig_parent_puzzle_additional_data: derived_agg_sig_data(48),
        genesis_pre_farm_pool_puzzle_hash: zero32,
        genesis_pre_farm_farmer_puzzle_hash: zero32,
        max_vdf_witness_size: 8,
        mempool_block_buffer: 10,
        max_coin_amount: u64::MAX,
        max_block_cost_clvm: crate::common::types::MAX_BLOCK_COST_CLVM,
        cost_per_byte: 12000,
        weight_proof_threshold: 2,
        weight_proof_recent_blocks: 1000,
        max_block_count_per_requests: 32,
        blocks_cache_size: 4608 + 128 * 4,
        max_generator_ref_list_size: 512,
        pool_sub_slot_iters: 37_600_000_000,
        hard_fork_height: 0,
        // Keep the upcoming cost model and interned spend-list rules disabled.
        hard_fork2_height: u32::MAX,
        soft_fork8_height: 0,
        plot_v1_phase_out_epoch_bits: 0,
        plot_filter_128_height: u32::MAX,
        plot_filter_64_height: u32::MAX,
        plot_filter_32_height: u32::MAX,
        min_plot_strength: 0,
        max_plot_strength: 0,
        soft_fork9_height: u32::MAX,
        plot_filter_v2_relative_height: [0; 9],
        filter_window_size: 16,
        max_effective_plot_filter_bits: 13,
        testnet: true,
    }
}

/// The maker bundle must create exactly one settlement coin whose amount is
/// `fee`, reserve that fee, and assert that `protocol_coin_id` is spent
/// concurrently. The settlement spend creates a nil-puzzle coin of the same
/// amount, which is then spent with no outputs.
pub fn complete_fee_offer_bundle(
    mut maker_bundle: SpendBundle,
    fee: u64,
    protocol_coin_id: &CoinID,
) -> Result<SpendBundle, Error> {
    if fee == 0 {
        return Err(Error::StrErr(
            "fee offer completion requires a nonzero fee".to_string(),
        ));
    }

    let settlement_puzzle_hash = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
    let mut settlement_coin = None;
    let mut reserved_fee = 0_u64;
    let mut protocol_concurrent_assertions = 0_usize;
    let mut allocator = AllocEncoder::new();

    for coin_spend in &maker_bundle.spends {
        let conditions = CoinCondition::from_puzzle_and_solution(
            &mut allocator,
            coin_spend.bundle.puzzle.to_program().as_ref(),
            coin_spend.bundle.solution.pref(),
        )?;
        for condition in conditions {
            match condition {
                CoinCondition::CreateCoin(puzzle_hash, amount)
                    if puzzle_hash == settlement_puzzle_hash && amount.to_u64() == fee =>
                {
                    let candidate = CoinString::from_parts(
                        &coin_spend.coin.to_coin_id(),
                        &settlement_puzzle_hash,
                        &Amount::new(fee),
                    );
                    if settlement_coin.replace(candidate).is_some() {
                        return Err(Error::StrErr(
                            "fee offer created more than one matching settlement coin".to_string(),
                        ));
                    }
                }
                CoinCondition::ReserveFee(amount) => {
                    reserved_fee = reserved_fee.checked_add(amount.to_u64()).ok_or_else(|| {
                        Error::StrErr("fee offer RESERVE_FEE total overflowed".to_string())
                    })?;
                }
                CoinCondition::AssertConcurrentSpend(coin_id) if coin_id == *protocol_coin_id => {
                    protocol_concurrent_assertions += 1;
                }
                _ => {}
            }
        }
    }

    if reserved_fee != fee {
        return Err(Error::StrErr(format!(
            "fee offer reserved {reserved_fee} mojos, expected {fee}"
        )));
    }
    if protocol_concurrent_assertions != 1 {
        return Err(Error::StrErr(format!(
            "fee offer contained {protocol_concurrent_assertions} protocol ASSERT_CONCURRENT_SPEND conditions, expected 1"
        )));
    }
    let settlement_coin = settlement_coin.ok_or_else(|| {
        Error::StrErr(format!(
            "fee offer did not create a {fee}-mojo settlement coin"
        ))
    })?;
    let settlement_coin_id = settlement_coin.to_coin_id();
    let nil_puzzle = Puzzle::from(Program::nil());
    let nil_puzzle_hash = nil_puzzle.sha256tree(&mut allocator);
    let nil_coin = CoinString::from_parts(&settlement_coin_id, &nil_puzzle_hash, &Amount::new(fee));
    let payment = (nil_puzzle_hash.clone(), (Amount::new(fee), ()))
        .to_clvm(&mut allocator)
        .into_gen()?;
    let notarized_payment = (Hash::from_bytes([0; 32]), (payment, ()))
        .to_clvm(&mut allocator)
        .into_gen()?;
    let settlement_solution_node = vec![notarized_payment].to_clvm(&mut allocator).into_gen()?;
    let settlement_solution = Program::from_nodeptr(&allocator, settlement_solution_node)?;
    let settlement_puzzle = Puzzle::from_bytes(&chia_puzzles::SETTLEMENT_PAYMENT)?;

    maker_bundle.spends.push(CoinSpend {
        coin: settlement_coin,
        bundle: Spend {
            puzzle: settlement_puzzle,
            solution: settlement_solution.into(),
            signature: Aggsig::default(),
        },
    });
    maker_bundle.spends.push(CoinSpend {
        coin: nil_coin,
        bundle: Spend {
            puzzle: nil_puzzle,
            solution: Program::nil().into(),
            signature: Aggsig::default(),
        },
    });
    Ok(maker_bundle)
}

/// Normalize either wallet fee-offer shape into a complete fee bundle.
///
/// WalletConnect offers create a settlement coin which this crate must spend
/// through a nil output. Cloud Wallet's native `fee` field instead returns an
/// already-complete maker bundle with the fee deficit and RESERVE_FEE directly.
/// The common aggregation boundary below validates either result identically.
pub fn normalize_fee_offer_bundle(
    maker_bundle: SpendBundle,
    fee: u64,
    protocol_coin_id: &CoinID,
) -> Result<SpendBundle, Error> {
    let settlement_puzzle_hash = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
    let mut matching_settlement_outputs = 0_usize;
    let mut allocator = AllocEncoder::new();
    for coin_spend in &maker_bundle.spends {
        let conditions = CoinCondition::from_puzzle_and_solution(
            &mut allocator,
            coin_spend.bundle.puzzle.to_program().as_ref(),
            coin_spend.bundle.solution.pref(),
        )?;
        matching_settlement_outputs += conditions
            .iter()
            .filter(|condition| {
                matches!(
                    condition,
                    CoinCondition::CreateCoin(puzzle_hash, amount)
                        if *puzzle_hash == settlement_puzzle_hash && amount.to_u64() == fee
                )
            })
            .count();
    }
    if matching_settlement_outputs == 0 {
        return Ok(maker_bundle);
    }
    complete_fee_offer_bundle(maker_bundle, fee, protocol_coin_id)
}

/// Validate a wallet-produced fee bundle, aggregate it with the protocol
/// bundle, and run intrinsic consensus validation over the exact transaction.
///
/// The wallet bundle must burn exactly `fee` mojos, reserve exactly that fee,
/// bind exactly once to `protocol_coin_id`, and use no protocol input.
pub fn aggregate_wallet_fee_bundle(
    protocol_bundle: SpendBundle,
    fee_bundle: SpendBundle,
    fee: u64,
    protocol_coin_id: &CoinID,
    agg_sig_me_additional_data: &Hash,
    height: u64,
) -> Result<SpendBundle, Error> {
    if fee == 0 {
        return Err(Error::StrErr(
            "wallet fee aggregation requires a nonzero fee".to_string(),
        ));
    }

    let protocol_inputs: std::collections::HashSet<CoinID> = protocol_bundle
        .spends
        .iter()
        .map(|spend| spend.coin.to_coin_id())
        .collect();
    if !protocol_inputs.contains(protocol_coin_id) {
        return Err(Error::StrErr(
            "fee target is not an input of the protocol bundle".to_string(),
        ));
    }
    if let Some(overlap) = fee_bundle
        .spends
        .iter()
        .map(|spend| spend.coin.to_coin_id())
        .find(|coin_id| protocol_inputs.contains(coin_id))
    {
        return Err(Error::StrErr(format!(
            "fee bundle reuses protocol input coin {overlap}"
        )));
    }

    let mut allocator = AllocEncoder::new();
    let mut total_inputs = 0_u128;
    let mut total_outputs = 0_u128;
    let mut reserved_fee = 0_u64;
    let mut target_assertions = 0_usize;
    let mut expiry = None;
    for coin_spend in &fee_bundle.spends {
        let (_, _, amount) = coin_spend.coin.get_coin_string_parts()?;
        total_inputs = total_inputs
            .checked_add(u128::from(amount.to_u64()))
            .ok_or_else(|| Error::StrErr("fee bundle input total overflowed".to_string()))?;
        let conditions = CoinCondition::from_puzzle_and_solution(
            &mut allocator,
            coin_spend.bundle.puzzle.to_program().as_ref(),
            coin_spend.bundle.solution.pref(),
        )?;
        for condition in conditions {
            match condition {
                CoinCondition::CreateCoin(_, amount) => {
                    total_outputs = total_outputs
                        .checked_add(u128::from(amount.to_u64()))
                        .ok_or_else(|| {
                            Error::StrErr("fee bundle output total overflowed".to_string())
                        })?;
                }
                CoinCondition::ReserveFee(amount) => {
                    reserved_fee = reserved_fee.checked_add(amount.to_u64()).ok_or_else(|| {
                        Error::StrErr("fee bundle RESERVE_FEE total overflowed".to_string())
                    })?;
                }
                CoinCondition::AssertConcurrentSpend(coin_id) if coin_id == *protocol_coin_id => {
                    target_assertions += 1;
                }
                CoinCondition::AssertBeforeHeightAbsolute(max_height) => {
                    expiry = Some(
                        expiry
                            .map(|current: u64| current.min(max_height))
                            .unwrap_or(max_height),
                    );
                }
                _ => {}
            }
        }
    }

    if reserved_fee != fee {
        return Err(Error::StrErr(format!(
            "fee bundle reserved {reserved_fee} mojos, expected {fee}"
        )));
    }
    if target_assertions != 1 {
        return Err(Error::StrErr(format!(
            "fee bundle contained {target_assertions} target ASSERT_CONCURRENT_SPEND conditions, expected 1"
        )));
    }
    if matches!(expiry, Some(max_height) if height >= max_height) {
        return Err(Error::StrErr(format!(
            "fee bundle ASSERT_BEFORE_HEIGHT_ABSOLUTE expired at height {} (current height {height})",
            expiry.expect("matched Some expiry"),
        )));
    }
    let deficit = total_inputs.checked_sub(total_outputs).ok_or_else(|| {
        Error::StrErr("fee bundle creates more value than its inputs".to_string())
    })?;
    if deficit != u128::from(fee) {
        return Err(Error::StrErr(format!(
            "fee bundle net deficit is {deficit} mojos, expected {fee}"
        )));
    }

    let mut combined = protocol_bundle;
    combined.spends.extend(fee_bundle.spends);
    combined.validate_consensus(agg_sig_me_additional_data, height)?;
    Ok(combined)
}

/// Maximum information about a coin spend.  Everything one might need downstream.
pub struct BrokenOutCoinSpendInfo {
    pub solution: ProgramRef,
    pub conditions: ProgramRef,
    pub message: Vec<u8>,
    pub signature: Aggsig,
}

/// Form of a spend used by coinset.org
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct CoinsetCoin {
    pub amount: u64,
    pub parent_coin_info: String,
    pub puzzle_hash: String,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct CoinsetSpendRecord {
    pub coin: CoinsetCoin,
    pub puzzle_reveal: String,
    pub solution: String,
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct CoinsetSpendBundle {
    pub aggregated_signature: String,
    pub coin_spends: Vec<CoinsetSpendRecord>,
}

pub fn check_for_hex(hex_with_prefix: &str) -> Result<Vec<u8>, Error> {
    if let Some(value) = hex_with_prefix.strip_prefix("0x") {
        return hex::decode(value).into_gen();
    }

    hex::decode(hex_with_prefix).into_gen()
}

pub fn convert_coinset_org_spend_to_spend(
    parent_coin_info: &str,
    puzzle_hash: &str,
    amount: u64,
    puzzle_reveal: &str,
    solution: &str,
) -> Result<CoinSpend, Error> {
    let parent_coin_info_bytes = check_for_hex(parent_coin_info)?;
    let puzzle_hash_bytes = check_for_hex(puzzle_hash)?;
    let puzzle_reveal_bytes = check_for_hex(puzzle_reveal)?;
    let solution_bytes = check_for_hex(solution)?;
    let puzzle_reveal_prog = Program::from_bytes(&puzzle_reveal_bytes)?.into();
    let solution_prog = Program::from_bytes(&solution_bytes)?.into();
    let coinid_hash = Hash::from_slice(&parent_coin_info_bytes)?;
    let parent_id = CoinID::new(coinid_hash);
    let puzzle_hash = PuzzleHash::from_hash(Hash::from_slice(&puzzle_hash_bytes)?);
    let coin_string = CoinString::from_parts(&parent_id, &puzzle_hash, &Amount::new(amount));
    Ok(CoinSpend {
        coin: coin_string,
        bundle: Spend {
            puzzle: puzzle_reveal_prog,
            solution: solution_prog,
            signature: Aggsig::default(),
        },
    })
}

#[cfg(test)]
mod consensus_validation_tests {
    use super::*;
    use std::rc::Rc;

    use chialisp::compiler::compiler::DefaultCompilerOpts;
    use chialisp::compiler::comptypes::CompilerOpts;
    use chialisp::compiler::debug_metadata::compile_with_debug;
    use clvm_traits::ToClvm;

    use crate::clvm_execution::{
        diagnose_clvm, diagnostic_registry_len, frame_serializations_for_test,
        reset_diagnostics_for_test, DebugMetadataCollection,
    };
    use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
    use crate::common::standard_coin::{private_to_public_key, sign_agg_sig_me};
    use crate::common::types::{PrivateKey, Sha256tree, ToQuotedProgram};

    fn agg_sig_me_spend(
        allocator: &mut AllocEncoder,
        tag: u8,
        private_key: &PrivateKey,
        raw_message: &[u8],
    ) -> (CoinSpend, Aggsig) {
        let public_key = private_to_public_key(private_key);
        let message = Node(
            allocator
                .encode_atom(clvm_traits::Atom::Borrowed(raw_message))
                .expect("message atom"),
        );
        let conditions = ((50_u8, (public_key, (message, ()))), ())
            .to_clvm(allocator)
            .expect("AGG_SIG_ME conditions");
        let puzzle: Puzzle = conditions
            .to_quoted_program(allocator)
            .expect("quoted conditions")
            .into();
        let coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([tag; 32])),
            &puzzle.sha256tree(allocator),
            &Amount::new(1),
        );
        let signature = sign_agg_sig_me(
            private_key,
            raw_message,
            &coin.to_coin_id(),
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        );
        (
            CoinSpend {
                coin,
                bundle: Spend {
                    puzzle,
                    solution: Program::nil().into(),
                    signature: Aggsig::default(),
                },
            },
            signature,
        )
    }

    fn quoted_condition_spend(
        allocator: &mut AllocEncoder,
        tag: u8,
        amount: u64,
        condition_nodes: Vec<NodePtr>,
    ) -> CoinSpend {
        let conditions = condition_nodes.to_clvm(allocator).expect("condition list");
        let puzzle: Puzzle = conditions
            .to_quoted_program(allocator)
            .expect("quoted conditions")
            .into();
        CoinSpend {
            coin: CoinString::from_parts(
                &CoinID::new(Hash::from_bytes([tag; 32])),
                &puzzle.sha256tree(allocator),
                &Amount::new(amount),
            ),
            bundle: Spend {
                puzzle,
                solution: Program::nil().into(),
                signature: Aggsig::default(),
            },
        }
    }

    fn protocol_and_fee_bundles(
        allocator: &mut AllocEncoder,
        fee: u64,
    ) -> (SpendBundle, SpendBundle, CoinID) {
        let output_ph = PuzzleHash::from_bytes([0x77; 32]);
        let protocol_conditions = vec![(51_u8, (output_ph.clone(), (Amount::new(100), ())))
            .to_clvm(allocator)
            .expect("protocol CREATE_COIN")];
        let protocol_spend = quoted_condition_spend(allocator, 0x31, 100, protocol_conditions);
        let fee_target = protocol_spend.coin.to_coin_id();
        let fee_conditions = vec![
            (
                51_u8,
                (output_ph, (Amount::new(100_u64.saturating_sub(fee)), ())),
            )
                .to_clvm(allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(fee), ()))
                .to_clvm(allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (fee_target.clone(), ()))
                .to_clvm(allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
        ];
        let fee_spend = quoted_condition_spend(allocator, 0x41, 100, fee_conditions);
        (
            SpendBundle {
                name: Some("protocol".to_string()),
                spends: vec![protocol_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![fee_spend],
            },
            fee_target,
        )
    }

    #[test]
    fn current_consensus_rules_preserve_spend_and_condition_costs() {
        let mut allocator = AllocEncoder::new();
        let output_ph = PuzzleHash::from_bytes([0x77; 32]);
        let conditions = vec![
            (51_u8, (output_ph.clone(), (Amount::new(1), ())))
                .to_clvm(&mut allocator)
                .expect("first CREATE_COIN"),
            (51_u8, (output_ph, (Amount::new(2), ())))
                .to_clvm(&mut allocator)
                .expect("second CREATE_COIN"),
            (52_u8, (Amount::new(0), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
        ];
        let spend = quoted_condition_spend(&mut allocator, 0x31, 3, conditions);
        let puzzle_hash: [u8; 32] = spend
            .bundle
            .puzzle
            .sha256tree(&mut allocator)
            .bytes()
            .try_into()
            .expect("puzzle hash");
        let protocol_bundle = chia_protocol::SpendBundle {
            coin_spends: vec![chia_protocol::CoinSpend {
                coin: chia_protocol::Coin {
                    parent_coin_info: Bytes32::from([0x31; 32]),
                    puzzle_hash: Bytes32::from(puzzle_hash),
                    amount: 3,
                },
                puzzle_reveal: Bytes::from(spend.bundle.puzzle.to_program().bytes().to_vec())
                    .into(),
                solution: Bytes::from(vec![0x80]).into(),
            }],
            aggregated_signature: chia_bls::Signature::default(),
        };
        let constants =
            validation_consensus_constants(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA));
        let flags = get_flags_for_height_and_constants(1, &constants) | MEMPOOL_MODE;
        let mut consensus_allocator = make_allocator(ConsensusFlags::LIMIT_HEAP);
        let (result, _) = run_spendbundle(
            &mut consensus_allocator,
            &protocol_bundle,
            constants.max_block_cost_clvm,
            flags,
            &constants,
            None,
        )
        .expect("current-rule spend");
        // Two CREATE_COINs cost 1.8M each; there is no spend surcharge or
        // generic condition charge before the upcoming hard fork.
        assert_eq!(result.condition_cost, 3_600_000);
        let byte_cost = (calculate_generator_length(&protocol_bundle.coin_spends) - 2) as u64
            * constants.cost_per_byte;
        assert_eq!(result.cost, byte_cost + result.execution_cost + 3_600_000);
    }

    #[test]
    fn successful_consensus_validation_does_no_fallback_or_frame_capture_work() {
        reset_consensus_replay_attempts();
        reset_diagnostics_for_test();
        let mut allocator = AllocEncoder::new();
        let spend = quoted_condition_spend(&mut allocator, 0x21, 1, Vec::new());
        SpendBundle {
            name: None,
            spends: vec![spend],
        }
        .validate_consensus(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA), 1)
        .expect("valid spend bundle");

        assert_eq!(consensus_replay_attempts(), 0);
        assert_eq!(diagnostic_registry_len(), 0);
        assert_eq!(frame_serializations_for_test(), 0);
    }

    #[test]
    fn consensus_eval_error_is_captured_only_by_failure_replay_and_diagnosed() {
        reset_consensus_replay_attempts();
        reset_diagnostics_for_test();
        let opts: Rc<dyn CompilerOpts> = DefaultCompilerOpts::new("consensus_failure.clsp")
            .set_search_paths(&[concat!(env!("CARGO_MANIFEST_DIR"), "/clsp").to_string()]);
        let artifact = compile_with_debug(
            opts,
            "(include *standard-cl-26*) (defun fail (Y) (f Y)) (export (X) (fail X))",
        )
        .expect("compile fixture")
        .into_iter()
        .find(|artifact| artifact.export_name.as_deref() == Some("program"))
        .expect("CL26 program export");
        let mut allocator = AllocEncoder::new();
        let puzzle = Puzzle::from_bytes(&artifact.program).expect("compiled puzzle");
        let spend = CoinSpend {
            coin: CoinString::from_parts(
                &CoinID::new(Hash::from_bytes([0x22; 32])),
                &puzzle.sha256tree(&mut allocator),
                &Amount::new(1),
            ),
            bundle: Spend {
                puzzle,
                solution: Program::nil().into(),
                signature: Aggsig::default(),
            },
        };
        let error = SpendBundle {
            name: None,
            spends: vec![spend],
        }
        .validate_consensus(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA), 1)
        .expect_err("failing puzzle");

        let token = error
            .diagnostic_token()
            .expect("failure replay should capture a diagnostic");
        let rendered = format!("{error:?}");
        assert!(
            rendered.contains("consensus validation failed"),
            "{rendered}"
        );
        assert!(rendered.contains("coin spend 0"), "{rendered}");
        assert_eq!(consensus_replay_attempts(), 1);
        assert_eq!(diagnostic_registry_len(), 1);
        assert_eq!(frame_serializations_for_test(), 1);

        let mut metadata = DebugMetadataCollection::default();
        metadata
            .insert(&artifact.metadata)
            .expect("valid diagnostic metadata");
        let diagnostic = diagnose_clvm(token, &metadata);
        assert!(diagnostic.contains("CLVM error:"), "{diagnostic}");
        assert!(
            diagnostic.contains("CLVM error: path into atom"),
            "{diagnostic}"
        );
    }

    #[test]
    fn non_clvm_consensus_error_preserves_error_code_without_token() {
        reset_consensus_replay_attempts();
        reset_diagnostics_for_test();
        let mut allocator = AllocEncoder::new();
        let mut spend = quoted_condition_spend(&mut allocator, 0x23, 1, Vec::new());
        spend.coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([0x23; 32])),
            &PuzzleHash::from_bytes([0x99; 32]),
            &Amount::new(1),
        );
        let error = SpendBundle {
            name: None,
            spends: vec![spend],
        }
        .validate_consensus(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA), 1)
        .expect_err("wrong puzzle hash");

        let rendered = format!("{error:?}");
        assert!(rendered.contains("WrongPuzzleHash"), "{rendered}");
        assert!(error.diagnostic_token().is_none());
        assert_eq!(consensus_replay_attempts(), 1);
        assert_eq!(diagnostic_registry_len(), 0);
        assert_eq!(frame_serializations_for_test(), 0);
    }

    #[test]
    fn consensus_replay_accounts_for_prior_spend_execution_cost() {
        reset_diagnostics_for_test();
        let constants =
            validation_consensus_constants(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA));
        let flags = get_flags_for_height_and_constants(1, &constants) | MEMPOOL_MODE;
        let puzzle: chia_protocol::Program = Bytes::from(vec![1]).into();
        let solution: chia_protocol::Program = Bytes::from(vec![0x80]).into();
        let puzzle_hash = Puzzle::from_bytes(&[1])
            .expect("identity puzzle")
            .sha256tree(&mut AllocEncoder::new());
        let puzzle_hash_bytes: [u8; 32] = puzzle_hash
            .bytes()
            .try_into()
            .expect("identity puzzle hash");
        let protocol_bundle = chia_protocol::SpendBundle {
            coin_spends: vec![
                chia_protocol::CoinSpend {
                    coin: chia_protocol::Coin {
                        parent_coin_info: Bytes32::from([0x31; 32]),
                        puzzle_hash: Bytes32::from(puzzle_hash_bytes),
                        amount: 1,
                    },
                    puzzle_reveal: puzzle.clone(),
                    solution: solution.clone(),
                },
                chia_protocol::CoinSpend {
                    coin: chia_protocol::Coin {
                        parent_coin_info: Bytes32::from([0x32; 32]),
                        puzzle_hash: Bytes32::from(puzzle_hash_bytes),
                        amount: 1,
                    },
                    puzzle_reveal: puzzle,
                    solution,
                },
            ],
            aggregated_signature: chia_bls::Signature::default(),
        };

        let mut cost_allocator = make_allocator(ConsensusFlags::LIMIT_HEAP);
        let puzzle_node = node_from_bytes(&mut cost_allocator, &[1]).unwrap();
        let solution_node = node_from_bytes(&mut cost_allocator, &[0x80]).unwrap();
        let first_cost = run_program(
            &mut cost_allocator,
            &ChiaDialect::new(flags.to_clvm_flags()),
            puzzle_node,
            solution_node,
            u64::MAX,
        )
        .expect("measure identity puzzle")
        .0;
        let byte_cost = (calculate_generator_length(&protocol_bundle.coin_spends) - 2) as u64
            * constants.cost_per_byte;
        let max_cost = byte_cost + first_cost * 2 - 1;

        let mut consensus_allocator = make_allocator(ConsensusFlags::LIMIT_HEAP);
        let original = run_spendbundle(
            &mut consensus_allocator,
            &protocol_bundle,
            max_cost,
            flags,
            &constants,
            None,
        )
        .expect_err("second spend should exceed remaining cost");
        let error = replay_consensus_eval_error(
            &protocol_bundle,
            max_cost,
            flags,
            &constants,
            &format!("{:?}", original.error_code()),
        )
        .expect("replay should recover second-spend EvalErr");

        let rendered = format!("{error:?}");
        assert!(rendered.contains("coin spend 1"), "{rendered}");
        assert!(rendered.contains("CostExceeded"), "{rendered}");
        assert!(error.diagnostic_token().is_some());
    }

    #[test]
    fn validates_two_agg_sig_me_spends_with_aggregate_on_first_spend() {
        let mut allocator = AllocEncoder::new();
        let key_a = PrivateKey::from_bytes(&[1; 32]).expect("key A");
        let key_b = PrivateKey::from_bytes(&[2; 32]).expect("key B");
        let (mut spend_a, signature_a) = agg_sig_me_spend(&mut allocator, 1, &key_a, b"message A");
        let (spend_b, signature_b) = agg_sig_me_spend(&mut allocator, 2, &key_b, b"message B");
        spend_a.bundle.signature = signature_a.aggregate(&signature_b);
        let bundle = SpendBundle {
            name: None,
            spends: vec![spend_a, spend_b],
        };

        bundle
            .validate_consensus(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA), 1)
            .expect("bundle-level aggregate signature");
    }

    #[test]
    fn aggregate_verifier_preserves_identical_pair_multiplicity() {
        let private_key = PrivateKey::from_bytes(&[3; 32]).expect("private key");
        let public_key = private_to_public_key(&private_key);
        let message = b"repeated AGG_SIG_UNSAFE pair";
        let signature = private_key.sign(message);
        let duplicate_signature = signature.aggregate(&signature);
        let public_key = public_key.to_bls();
        let duplicate_pairs = [(&public_key, message.as_slice()); 2];

        assert!(aggregate_verify_aligned(
            &duplicate_signature.to_bls(),
            duplicate_pairs
        ));
        assert!(
            !aggregate_verify_aligned(&signature.to_bls(), duplicate_pairs),
            "one signature must not satisfy two identical public-key/message pairs"
        );
    }

    #[test]
    fn completes_fee_offer_through_a_nil_puzzle_output() {
        let mut allocator = AllocEncoder::new();
        let protocol_output_ph = PuzzleHash::from_bytes([0x34; 32]);
        let protocol_create = (51_u8, (protocol_output_ph, (Amount::new(100), ())))
            .to_clvm(&mut allocator)
            .expect("protocol CREATE_COIN");
        let protocol_spend =
            quoted_condition_spend(&mut allocator, 0x33, 100, vec![protocol_create]);
        let protocol_coin_id = protocol_spend.coin.to_coin_id();
        let nil_puzzle = Puzzle::from(Program::nil());
        let nil_puzzle_hash = nil_puzzle.sha256tree(&mut allocator);
        let settlement_puzzle_hash = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
        let fee = 10;
        let condition_nodes = vec![
            (
                51_u8,
                (settlement_puzzle_hash.clone(), (Amount::new(fee), ())),
            )
                .to_clvm(&mut allocator)
                .expect("CREATE_COIN"),
            (
                51_u8,
                (PuzzleHash::from_bytes([0x23; 32]), (Amount::new(990), ())),
            )
                .to_clvm(&mut allocator)
                .expect("change CREATE_COIN"),
            (52_u8, (Amount::new(fee), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (protocol_coin_id.clone(), ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
        ];
        let conditions = condition_nodes
            .to_clvm(&mut allocator)
            .expect("condition list");
        let maker_puzzle: Puzzle = conditions
            .to_quoted_program(&mut allocator)
            .expect("quoted conditions")
            .into();
        let maker_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([0x11; 32])),
            &maker_puzzle.sha256tree(&mut allocator),
            &Amount::new(1_000),
        );
        let settlement_coin = CoinString::from_parts(
            &maker_coin.to_coin_id(),
            &settlement_puzzle_hash,
            &Amount::new(fee),
        );
        let nil_coin = CoinString::from_parts(
            &settlement_coin.to_coin_id(),
            &nil_puzzle_hash,
            &Amount::new(fee),
        );
        let maker_bundle = SpendBundle {
            name: None,
            spends: vec![CoinSpend {
                coin: maker_coin,
                bundle: Spend {
                    puzzle: maker_puzzle,
                    solution: Program::nil().into(),
                    signature: Aggsig::default(),
                },
            }],
        };

        let completed =
            normalize_fee_offer_bundle(maker_bundle, fee, &protocol_coin_id).expect("completion");
        assert_eq!(completed.spends.len(), 3);
        assert_eq!(completed.spends[1].coin, settlement_coin);
        assert_eq!(completed.spends[2].coin, nil_coin);
        assert_eq!(completed.spends[2].bundle.puzzle, nil_puzzle);
        assert_eq!(completed.spends[2].bundle.solution, Program::nil().into());

        let combined = aggregate_wallet_fee_bundle(
            SpendBundle {
                name: Some("protocol".to_string()),
                spends: vec![protocol_spend],
            },
            completed,
            fee,
            &protocol_coin_id,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect("completed offer aggregates canonically");
        assert_eq!(combined.spends.len(), 4);
    }

    #[test]
    fn validates_and_aggregates_canonical_wallet_fee_bundle() {
        let mut allocator = AllocEncoder::new();
        let (protocol, fee_bundle, target) = protocol_and_fee_bundles(&mut allocator, 10);
        let fee_bundle =
            normalize_fee_offer_bundle(fee_bundle, 10, &target).expect("native fee normalization");
        assert_eq!(
            fee_bundle.spends.len(),
            1,
            "native-fee offers are already complete"
        );
        let combined = aggregate_wallet_fee_bundle(
            protocol,
            fee_bundle,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect("canonical fee aggregate");
        assert_eq!(combined.name.as_deref(), Some("protocol"));
        assert_eq!(combined.spends.len(), 2);
    }

    #[test]
    fn rejects_native_fee_offer_with_invalid_signature() {
        let mut allocator = AllocEncoder::new();
        let output_ph = PuzzleHash::from_bytes([0x77; 32]);
        let protocol_conditions = vec![(51_u8, (output_ph.clone(), (Amount::new(100), ())))
            .to_clvm(&mut allocator)
            .expect("protocol CREATE_COIN")];
        let protocol_spend = quoted_condition_spend(&mut allocator, 0x31, 100, protocol_conditions);
        let target = protocol_spend.coin.to_coin_id();
        let public_key =
            private_to_public_key(&PrivateKey::from_bytes(&[3; 32]).expect("private key"));
        let message = Node(
            allocator
                .encode_atom(clvm_traits::Atom::Borrowed(b"fee authorization"))
                .expect("message atom"),
        );
        let fee_conditions = vec![
            (51_u8, (output_ph, (Amount::new(90), ())))
                .to_clvm(&mut allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(10), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (target.clone(), ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
            (49_u8, (public_key, (message, ())))
                .to_clvm(&mut allocator)
                .expect("AGG_SIG_UNSAFE"),
        ];
        let error = aggregate_wallet_fee_bundle(
            SpendBundle {
                name: Some("protocol".to_string()),
                spends: vec![protocol_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![quoted_condition_spend(
                    &mut allocator,
                    0x41,
                    100,
                    fee_conditions,
                )],
            },
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("invalid fee signature");
        assert!(format!("{error:?}").contains("invalid aggregate signature"));
    }

    #[test]
    fn rejects_direct_fee_bundle_with_wrong_reserve_or_deficit() {
        let mut allocator = AllocEncoder::new();
        let (protocol, wrong_reserve, target) = protocol_and_fee_bundles(&mut allocator, 9);
        let reserve_error = aggregate_wallet_fee_bundle(
            protocol,
            wrong_reserve,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("wrong reserve");
        assert!(format!("{reserve_error:?}").contains("reserved 9"));

        let (protocol, _, target) = protocol_and_fee_bundles(&mut allocator, 10);
        let wrong_deficit_conditions = vec![
            (
                51_u8,
                (PuzzleHash::from_bytes([0x77; 32]), (Amount::new(91), ())),
            )
                .to_clvm(&mut allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(10), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (target.clone(), ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
        ];
        let wrong_deficit = SpendBundle {
            name: None,
            spends: vec![quoted_condition_spend(
                &mut allocator,
                0x42,
                100,
                wrong_deficit_conditions,
            )],
        };
        let deficit_error = aggregate_wallet_fee_bundle(
            protocol,
            wrong_deficit,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("wrong deficit");
        assert!(format!("{deficit_error:?}").contains("net deficit is 9"));
    }

    #[test]
    fn rejects_missing_target_assertion_and_protocol_input_overlap() {
        let mut allocator = AllocEncoder::new();
        let (protocol, mut fee_bundle, target) = protocol_and_fee_bundles(&mut allocator, 10);
        let missing_assert_conditions = vec![
            (
                51_u8,
                (PuzzleHash::from_bytes([0x77; 32]), (Amount::new(90), ())),
            )
                .to_clvm(&mut allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(10), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
        ];
        let missing_assert = SpendBundle {
            name: None,
            spends: vec![quoted_condition_spend(
                &mut allocator,
                0x43,
                100,
                missing_assert_conditions,
            )],
        };
        let assertion_error = aggregate_wallet_fee_bundle(
            protocol.clone(),
            missing_assert,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("missing target assertion");
        assert!(format!("{assertion_error:?}").contains("contained 0 target"));

        let other_target = CoinID::new(Hash::from_bytes([0x99; 32]));
        let target_error = aggregate_wallet_fee_bundle(
            protocol.clone(),
            fee_bundle.clone(),
            10,
            &other_target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("target must be a protocol input");
        assert!(format!("{target_error:?}").contains("not an input"));

        fee_bundle.spends[0].coin = protocol.spends[0].coin.clone();
        let overlap_error = aggregate_wallet_fee_bundle(
            protocol,
            fee_bundle,
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            1,
        )
        .expect_err("protocol input overlap");
        assert!(format!("{overlap_error:?}").contains("reuses protocol input"));
    }

    #[test]
    fn rejects_expired_native_fee_offer() {
        let mut allocator = AllocEncoder::new();
        let output_ph = PuzzleHash::from_bytes([0x77; 32]);
        let protocol_conditions = vec![(51_u8, (output_ph.clone(), (Amount::new(100), ())))
            .to_clvm(&mut allocator)
            .expect("protocol CREATE_COIN")];
        let protocol_spend = quoted_condition_spend(&mut allocator, 0x31, 100, protocol_conditions);
        let target = protocol_spend.coin.to_coin_id();
        let fee_conditions = vec![
            (51_u8, (output_ph, (Amount::new(90), ())))
                .to_clvm(&mut allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(10), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (target.clone(), ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
            (87_u8, (10_u64, ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_BEFORE_HEIGHT_ABSOLUTE"),
        ];
        let error = aggregate_wallet_fee_bundle(
            SpendBundle {
                name: Some("protocol".to_string()),
                spends: vec![protocol_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![quoted_condition_spend(
                    &mut allocator,
                    0x41,
                    100,
                    fee_conditions,
                )],
            },
            10,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            10,
        )
        .expect_err("expired fee offer");
        assert!(format!("{error:?}").contains("ASSERT_BEFORE_HEIGHT_ABSOLUTE"));
    }
}
