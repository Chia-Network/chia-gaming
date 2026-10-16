//! Unsigned standard-wallet spends for signer-only wallets.
//!
//! Some wallets (Sage over WalletConnect CHIP-0002) can list their coins and
//! sign arbitrary coin spends but cannot build offers with protocol-supplied
//! conditions. For those wallets Rust selects inputs from the wallet's coin
//! list and constructs the exact spends; the wallet only signs them. The
//! resulting bundle has the same shape as the simulator's offer emulation: a
//! funding spend creates the settlement-payment output that the handshake
//! completes, and a fee spend reserves the fee and asserts the protocol coin is
//! spent concurrently. Downstream validation treats it like any wallet bundle.

use clvm_traits::{ClvmEncoder, FromClvm, ToClvm};
use clvm_utils::{tree_hash, CurriedProgram};
use clvmr::NodePtr;

use crate::common::constants::{
    ASSERT_CONCURRENT_SPEND_ATOM, CREATE_COIN, DEFAULT_PUZZLE_HASH, RESERVE_FEE_ATOM,
};
use crate::common::standard_coin::solution_for_conditions;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, Error, GetCoinStringParts,
    IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256tree, Spend,
};
use crate::session_phases::handshake::{raw_coin_conditions_to_clvm, RawCoinCondition};

/// A wallet coin offered for selection, with the puzzle reveal the wallet
/// reports for it.
#[derive(Debug, Clone)]
pub struct WalletCoinCandidate {
    pub coin: CoinString,
    pub puzzle: Puzzle,
}

#[derive(Debug, Clone)]
pub enum WalletSpendPurpose {
    /// Channel funding: create a settlement-payment output of `amount` and
    /// apply the protocol's wallet conditions to the same spend.
    Funding {
        amount: u64,
        conditions: Vec<RawCoinCondition>,
        max_height: Option<u64>,
    },
    /// Fee attachment: burn exactly `fee`, reserve it, and require the
    /// protocol coin to be spent in the same block.
    Fee { fee: u64, target: CoinID },
}

fn is_standard_wallet_puzzle(
    allocator: &mut AllocEncoder,
    candidate: &WalletCoinCandidate,
) -> Result<bool, Error> {
    let (_, puzzle_hash, _) = candidate.coin.get_coin_string_parts()?;
    if candidate.puzzle.sha256tree(allocator) != puzzle_hash {
        return Err(Error::StrErr(format!(
            "wallet coin {} puzzle reveal does not hash to its puzzle hash",
            candidate.coin.to_coin_id()
        )));
    }
    let node = candidate.puzzle.to_program().to_nodeptr(allocator)?;
    let Ok(curried) = CurriedProgram::<NodePtr, NodePtr>::from_clvm(allocator.allocator(), node)
    else {
        return Ok(false);
    };
    let mod_hash: [u8; 32] = tree_hash(allocator.allocator(), curried.program).into();
    Ok(mod_hash == DEFAULT_PUZZLE_HASH)
}

fn coin_amount(coin: &CoinString) -> Result<u64, Error> {
    Ok(coin.get_coin_string_parts()?.2.to_u64())
}

/// Smallest single coin covering `target`, otherwise largest coins first.
fn select_coins(
    mut candidates: Vec<WalletCoinCandidate>,
    target: u64,
) -> Result<Vec<WalletCoinCandidate>, Error> {
    let mut amounts = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        amounts.push(coin_amount(&candidate.coin)?);
    }
    if let Some(index) = (0..candidates.len())
        .filter(|i| amounts[*i] >= target)
        .min_by_key(|i| amounts[*i])
    {
        return Ok(vec![candidates.swap_remove(index)]);
    }

    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by_key(|i| std::cmp::Reverse(amounts[*i]));
    let mut total = 0_u128;
    let mut selected = Vec::new();
    for index in order {
        if total >= u128::from(target) {
            break;
        }
        total += u128::from(amounts[index]);
        selected.push(candidates[index].clone());
    }
    if total < u128::from(target) {
        return Err(Error::StrErr(format!(
            "wallet has {total} spendable mojos in standard coins, needs {target}"
        )));
    }
    Ok(selected)
}

fn atom_condition(
    allocator: &mut AllocEncoder,
    opcode: &[u8; 1],
    arg: impl ToClvm<AllocEncoder>,
) -> Result<Node, Error> {
    Ok(Node(
        (
            Node(
                allocator
                    .encode_atom(clvm_traits::Atom::Borrowed(opcode))
                    .into_gen()?,
            ),
            (arg, ()),
        )
            .to_clvm(allocator)
            .into_gen()?,
    ))
}

fn unsigned_spend(
    allocator: &mut AllocEncoder,
    candidate: &WalletCoinCandidate,
    conditions: Vec<Node>,
) -> Result<CoinSpend, Error> {
    let conditions = conditions.to_clvm(allocator).into_gen()?;
    let solution = solution_for_conditions(allocator, conditions)?;
    Ok(CoinSpend {
        coin: candidate.coin.clone(),
        bundle: Spend {
            puzzle: candidate.puzzle.clone(),
            solution: Program::from_nodeptr(allocator, solution)?.into(),
            signature: Aggsig::default(),
        },
    })
}

/// Select standard-puzzle inputs from `candidates` and build unsigned spends
/// for `purpose`, returning change to `change_puzzle_hash`.
///
/// The first selected coin carries every protocol condition and output. Any
/// additional input only asserts that first spend, and the first spend asserts
/// each of them, so the inputs cannot be separated.
pub fn build_unsigned_wallet_spends(
    allocator: &mut AllocEncoder,
    candidates: Vec<WalletCoinCandidate>,
    purpose: &WalletSpendPurpose,
    change_puzzle_hash: &PuzzleHash,
) -> Result<Vec<CoinSpend>, Error> {
    let mut standard = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if is_standard_wallet_puzzle(allocator, &candidate)? {
            standard.push(candidate);
        }
    }

    let target = match purpose {
        WalletSpendPurpose::Funding { amount, .. } => *amount,
        WalletSpendPurpose::Fee { fee, .. } => *fee,
    };
    if target == 0 {
        return Err(Error::StrErr(
            "wallet spend amount must be nonzero".to_string(),
        ));
    }
    let selected = select_coins(standard, target)?;
    let mut total = 0_u64;
    for candidate in &selected {
        total = total
            .checked_add(coin_amount(&candidate.coin)?)
            .ok_or_else(|| Error::StrErr("wallet input total overflowed".to_string()))?;
    }
    let change = total - target;

    let primary_id = selected[0].coin.to_coin_id();
    let mut primary_conditions = Vec::new();
    match purpose {
        WalletSpendPurpose::Funding {
            amount,
            conditions,
            max_height,
        } => {
            let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
            primary_conditions.push(Node(
                (CREATE_COIN, (settlement_ph, (Amount::new(*amount), ())))
                    .to_clvm(allocator)
                    .into_gen()?,
            ));
            primary_conditions.extend(raw_coin_conditions_to_clvm(
                allocator,
                conditions,
                *max_height,
            )?);
        }
        WalletSpendPurpose::Fee { fee, target } => {
            primary_conditions.push(atom_condition(
                allocator,
                &RESERVE_FEE_ATOM,
                Amount::new(*fee),
            )?);
            primary_conditions.push(atom_condition(
                allocator,
                &ASSERT_CONCURRENT_SPEND_ATOM,
                target.clone(),
            )?);
        }
    }
    if change > 0 {
        primary_conditions.push(Node(
            (
                CREATE_COIN,
                (change_puzzle_hash.clone(), (Amount::new(change), ())),
            )
                .to_clvm(allocator)
                .into_gen()?,
        ));
    }
    for secondary in &selected[1..] {
        primary_conditions.push(atom_condition(
            allocator,
            &ASSERT_CONCURRENT_SPEND_ATOM,
            secondary.coin.to_coin_id(),
        )?);
    }

    let mut spends = vec![unsigned_spend(allocator, &selected[0], primary_conditions)?];
    for secondary in &selected[1..] {
        let condition =
            atom_condition(allocator, &ASSERT_CONCURRENT_SPEND_ATOM, primary_id.clone())?;
        spends.push(unsigned_spend(allocator, secondary, vec![condition])?);
    }
    Ok(spends)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
    use crate::common::constants::RECEIVE_MESSAGE;
    use crate::common::standard_coin::{
        get_standard_coin_puzzle, private_to_public_key, puzzle_for_synthetic_public_key,
        sign_agg_sig_me,
    };
    use crate::common::types::{
        aggregate_wallet_fee_bundle, CoinCondition, Hash, PrivateKey, SpendBundle,
    };
    use crate::session_phases::handshake::CoinSpendRequest;
    use crate::session_phases::handshake_initiator::validate_wallet_bundle_applies_conditions;

    struct Wallet {
        private_key: PrivateKey,
        puzzle: Puzzle,
        puzzle_hash: PuzzleHash,
    }

    fn wallet(allocator: &mut AllocEncoder) -> Wallet {
        let private_key = PrivateKey::from_bytes(&[7; 32]).expect("private key");
        let public_key = private_to_public_key(&private_key);
        let standard = get_standard_coin_puzzle(allocator).expect("standard puzzle");
        let puzzle = puzzle_for_synthetic_public_key(allocator, &standard, &public_key)
            .expect("wallet puzzle");
        let puzzle_hash = puzzle.sha256tree(allocator);
        Wallet {
            private_key,
            puzzle,
            puzzle_hash,
        }
    }

    fn candidate(wallet: &Wallet, parent: u8, amount: u64) -> WalletCoinCandidate {
        WalletCoinCandidate {
            coin: CoinString::from_parts(
                &CoinID::new(Hash::from_bytes([parent; 32])),
                &wallet.puzzle_hash,
                &Amount::new(amount),
            ),
            puzzle: wallet.puzzle.clone(),
        }
    }

    fn sign(allocator: &mut AllocEncoder, wallet: &Wallet, spends: Vec<CoinSpend>) -> SpendBundle {
        let spends = spends
            .into_iter()
            .map(|mut spend| {
                let solution = spend
                    .bundle
                    .solution
                    .to_nodeptr(allocator)
                    .expect("solution");
                let delegated = clvm_traits::FromClvm::from_clvm(allocator.allocator(), solution)
                    .map(|(_, (delegated, _)): (NodePtr, (NodePtr, NodePtr))| delegated)
                    .expect("standard solution");
                let message = Node(delegated).sha256tree(allocator);
                spend.bundle.signature = sign_agg_sig_me(
                    &wallet.private_key,
                    message.bytes(),
                    &spend.coin.to_coin_id(),
                    &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
                );
                spend
            })
            .collect();
        SpendBundle { name: None, spends }
    }

    fn conditions(allocator: &mut AllocEncoder, spend: &CoinSpend) -> Vec<CoinCondition> {
        CoinCondition::from_puzzle_and_solution(
            allocator,
            spend.bundle.puzzle.to_program().as_ref(),
            spend.bundle.solution.pref(),
        )
        .expect("conditions")
    }

    #[test]
    fn funding_uses_smallest_covering_coin_and_returns_change() {
        let mut allocator = AllocEncoder::new();
        let wallet = wallet(&mut allocator);
        let request = CoinSpendRequest {
            amount: Amount::new(100),
            fee: Amount::default(),
            conditions: vec![RawCoinCondition {
                opcode: RECEIVE_MESSAGE,
                args: vec![vec![16], vec![1, 2, 3], vec![5; 32]],
            }],
            coin_id: None,
            max_height: Some(1000),
        };
        let candidates = vec![
            candidate(&wallet, 1, 50),
            candidate(&wallet, 2, 300),
            candidate(&wallet, 3, 120),
        ];
        let spends = build_unsigned_wallet_spends(
            &mut allocator,
            candidates,
            &WalletSpendPurpose::Funding {
                amount: 100,
                conditions: request.conditions.clone(),
                max_height: request.max_height,
            },
            &wallet.puzzle_hash,
        )
        .expect("spends");
        let bundle = SpendBundle {
            name: None,
            spends: spends.clone(),
        };
        assert_eq!(
            validate_wallet_bundle_applies_conditions(&mut allocator, &bundle, &request)
                .expect("funding spend applies the protocol conditions"),
            spends[0].coin
        );
        assert_eq!(spends.len(), 1);
        assert_eq!(coin_amount(&spends[0].coin).unwrap(), 120);
        let emitted = conditions(&mut allocator, &spends[0]);
        let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
        assert!(emitted.iter().any(|c| matches!(
            c,
            CoinCondition::CreateCoin(ph, amount) if *ph == settlement_ph && amount.to_u64() == 100
        )));
        assert!(emitted.iter().any(|c| matches!(
            c,
            CoinCondition::CreateCoin(ph, amount) if *ph == wallet.puzzle_hash && amount.to_u64() == 20
        )));
        assert!(emitted
            .iter()
            .any(|c| matches!(c, CoinCondition::AssertBeforeHeightAbsolute(1000))));
    }

    #[test]
    fn fee_combines_coins_and_validates_after_signing() {
        let mut allocator = AllocEncoder::new();
        let wallet = wallet(&mut allocator);
        let protocol_puzzle = Puzzle::from_bytes(&[0xff, 0x01, 0x80]).expect("(q) puzzle");
        let protocol_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([9; 32])),
            &protocol_puzzle.sha256tree(&mut allocator),
            &Amount::new(1),
        );
        let target = protocol_coin.to_coin_id();
        let spends = build_unsigned_wallet_spends(
            &mut allocator,
            vec![candidate(&wallet, 1, 40), candidate(&wallet, 2, 70)],
            &WalletSpendPurpose::Fee {
                fee: 100,
                target: target.clone(),
            },
            &wallet.puzzle_hash,
        )
        .expect("spends");
        assert_eq!(spends.len(), 2);
        assert_eq!(coin_amount(&spends[0].coin).unwrap(), 70);
        let primary = conditions(&mut allocator, &spends[0]);
        let secondary_id = spends[1].coin.to_coin_id();
        assert!(primary
            .iter()
            .any(|c| matches!(c, CoinCondition::ReserveFee(amount) if amount.to_u64() == 100)));
        assert!(primary
            .iter()
            .any(|c| matches!(c, CoinCondition::AssertConcurrentSpend(id) if *id == target)));
        assert!(primary.iter().any(|c| matches!(
            c,
            CoinCondition::CreateCoin(ph, amount) if *ph == wallet.puzzle_hash && amount.to_u64() == 10
        )));
        assert!(primary
            .iter()
            .any(|c| matches!(c, CoinCondition::AssertConcurrentSpend(id) if *id == secondary_id)));
        let primary_id = spends[0].coin.to_coin_id();
        let secondary = conditions(&mut allocator, &spends[1]);
        assert!(secondary.iter().all(|c| matches!(
            c,
            CoinCondition::AggSigMe(..) | CoinCondition::AssertConcurrentSpend(_)
        )));
        assert!(secondary
            .iter()
            .any(|c| matches!(c, CoinCondition::AssertConcurrentSpend(id) if *id == primary_id)));

        let fee_bundle = sign(&mut allocator, &wallet, spends);
        let protocol_bundle = SpendBundle {
            name: None,
            spends: vec![CoinSpend {
                coin: protocol_coin,
                bundle: Spend {
                    puzzle: protocol_puzzle,
                    solution: Program::nil().into(),
                    signature: Aggsig::default(),
                },
            }],
        };
        aggregate_wallet_fee_bundle(
            protocol_bundle,
            fee_bundle,
            100,
            &target,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            0,
        )
        .expect("signed wallet fee spend aggregates");
    }

    #[test]
    fn non_standard_coins_are_skipped() {
        let mut allocator = AllocEncoder::new();
        let wallet = wallet(&mut allocator);
        let other = Puzzle::from_bytes(&[0x01]).expect("puzzle");
        let other_ph = other.sha256tree(&mut allocator);
        let foreign = WalletCoinCandidate {
            coin: CoinString::from_parts(
                &CoinID::new(Hash::from_bytes([4; 32])),
                &other_ph,
                &Amount::new(1000),
            ),
            puzzle: other,
        };
        let error = build_unsigned_wallet_spends(
            &mut allocator,
            vec![foreign, candidate(&wallet, 1, 10)],
            &WalletSpendPurpose::Fee {
                fee: 100,
                target: CoinID::new(Hash::from_bytes([9; 32])),
            },
            &wallet.puzzle_hash,
        )
        .expect_err("only 10 mojos are in standard coins");
        assert!(format!("{error:?}").contains("needs 100"));
    }

    #[test]
    fn mismatched_puzzle_reveal_is_rejected() {
        let mut allocator = AllocEncoder::new();
        let wallet = wallet(&mut allocator);
        let mut bad = candidate(&wallet, 1, 500);
        bad.coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([1; 32])),
            &PuzzleHash::from_bytes([3; 32]),
            &Amount::new(500),
        );
        assert!(build_unsigned_wallet_spends(
            &mut allocator,
            vec![bad],
            &WalletSpendPurpose::Fee {
                fee: 100,
                target: CoinID::new(Hash::from_bytes([9; 32])),
            },
            &wallet.puzzle_hash,
        )
        .is_err());
    }
}
