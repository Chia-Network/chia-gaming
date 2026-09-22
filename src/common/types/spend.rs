use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::NodePtr;
use serde::{Deserialize, Serialize};
use std::mem::MaybeUninit;

use chia_consensus::allocator::make_allocator;
use chia_consensus::consensus_constants::ConsensusConstants;
use chia_consensus::flags::{ConsensusFlags, MEMPOOL_MODE};
use chia_consensus::spendbundle_conditions::run_spendbundle;
use chia_consensus::spendbundle_validation::get_flags_for_height_and_constants;
use chia_protocol::{Bytes, Bytes32};

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
        let (_conditions, signature_pairs) = run_spendbundle(
            &mut allocator,
            &protocol_bundle,
            constants.max_block_cost_clvm,
            flags,
            &constants,
        )
        .map_err(|err| {
            Error::StrErr(format!(
                "spend bundle consensus validation failed: {:?}",
                err.1
            ))
        })?;
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
    use clvm_traits::ToClvm;

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
