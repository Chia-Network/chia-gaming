use clvmr::allocator::{NodePtr, SExp};
use clvmr::{run_program, ChiaDialect};

use crate::utils::proper_list;

use crate::common::constants::{
    AGG_SIG_ME_ATOM, AGG_SIG_UNSAFE_ATOM, ASSERT_COIN_ANNOUNCEMENT_ATOM,
    ASSERT_HEIGHT_RELATIVE_ATOM, CREATE_COIN_ANNOUNCEMENT_ATOM, CREATE_COIN_ATOM, RESERVE_FEE_ATOM,
};

use crate::common::types::{
    u64_from_atom, AllocEncoder, Amount, Error, Hash, IntoErr, Program, PublicKey, PuzzleHash,
};

pub fn chia_dialect() -> ChiaDialect {
    ChiaDialect::default()
}

pub const MAX_BLOCK_COST_CLVM: u64 = 11_000_000_000;

#[derive(Debug, Clone)]
pub enum CoinCondition {
    AggSigMe(PublicKey, Vec<u8>),
    AggSigUnsafe(PublicKey, Vec<u8>),
    CreateCoin(PuzzleHash, Amount),
    CreateCoinAnnouncement(Vec<u8>),
    AssertCoinAnnouncement(Vec<u8>),
    ReserveFee(Amount),
    AssertHeightRelative(u64),
}

/// Parse a single condition.
///
/// - `Ok(Some(...))` — recognized and well-formed
/// - `Ok(None)` — unrecognized opcode / shape (skip at the chain boundary)
/// - `Err(...)` — recognized opcode with malformed arguments
fn parse_condition(
    allocator: &AllocEncoder,
    condition: NodePtr,
) -> Result<Option<CoinCondition>, Error> {
    let Some(exploded) = proper_list(allocator.allocator_ref(), condition, true) else {
        return Ok(None);
    };
    if exploded.len() > 2
        && matches!(
            (
                allocator.allocator_ref().sexp(exploded[0]),
                allocator.allocator_ref().sexp(exploded[1]),
                allocator.allocator_ref().sexp(exploded[2])
            ),
            (SExp::Atom, SExp::Atom, SExp::Atom)
        )
    {
        let atoms: Vec<Vec<u8>> = exploded
            .iter()
            .take(3)
            .map(|a| allocator.allocator_ref().atom(*a).to_vec())
            .collect();
        if *atoms[0] == AGG_SIG_UNSAFE_ATOM {
            let pk = PublicKey::from_slice(&atoms[1])
                .map_err(|e| Error::StrErr(format!("AGG_SIG_UNSAFE public key: {e:?}")))?;
            return Ok(Some(CoinCondition::AggSigUnsafe(pk, atoms[2].to_vec())));
        } else if *atoms[0] == AGG_SIG_ME_ATOM {
            let pk = PublicKey::from_slice(&atoms[1])
                .map_err(|e| Error::StrErr(format!("AGG_SIG_ME public key: {e:?}")))?;
            return Ok(Some(CoinCondition::AggSigMe(pk, atoms[2].to_vec())));
        } else if *atoms[0] == CREATE_COIN_ATOM {
            let amt = u64_from_atom(&atoms[2]).ok_or_else(|| {
                Error::StrErr("CREATE_COIN amount was not a u64 atom".to_string())
            })?;
            let hash = Hash::from_slice(&atoms[1])
                .map_err(|e| Error::StrErr(format!("CREATE_COIN puzzle hash: {e:?}")))?;
            return Ok(Some(CoinCondition::CreateCoin(
                PuzzleHash::from_hash(hash),
                Amount::new(amt),
            )));
        }
    }

    if exploded.len() == 2
        && matches!(
            (
                allocator.allocator_ref().sexp(exploded[0]),
                allocator.allocator_ref().sexp(exploded[1]),
            ),
            (SExp::Atom, SExp::Atom)
        )
    {
        let op = allocator.allocator_ref().atom(exploded[0]).to_vec();
        let arg = allocator.allocator_ref().atom(exploded[1]).to_vec();
        if *op == ASSERT_HEIGHT_RELATIVE_ATOM {
            let val = u64_from_atom(&arg).ok_or_else(|| {
                Error::StrErr("ASSERT_HEIGHT_RELATIVE value was not a u64 atom".to_string())
            })?;
            return Ok(Some(CoinCondition::AssertHeightRelative(val)));
        }
        if *op == CREATE_COIN_ANNOUNCEMENT_ATOM {
            return Ok(Some(CoinCondition::CreateCoinAnnouncement(arg)));
        }
        if *op == ASSERT_COIN_ANNOUNCEMENT_ATOM {
            return Ok(Some(CoinCondition::AssertCoinAnnouncement(arg)));
        }
        if *op == RESERVE_FEE_ATOM {
            let val = u64_from_atom(&arg)
                .ok_or_else(|| Error::StrErr("RESERVE_FEE value was not a u64 atom".to_string()))?;
            return Ok(Some(CoinCondition::ReserveFee(Amount::new(val))));
        }
    }

    Ok(None)
}

impl CoinCondition {
    pub fn from_nodeptr(
        allocator: &AllocEncoder,
        conditions: NodePtr,
    ) -> Result<Vec<CoinCondition>, Error> {
        let exploded = proper_list(allocator.allocator_ref(), conditions, true)
            .ok_or_else(|| Error::StrErr("coin conditions were not a list".to_string()))?;
        let mut out = Vec::with_capacity(exploded.len());
        for cond in exploded {
            if let Some(parsed) = parse_condition(allocator, cond)? {
                out.push(parsed);
            }
        }
        Ok(out)
    }

    pub fn from_puzzle_and_solution(
        allocator: &mut AllocEncoder,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<Vec<CoinCondition>, Error> {
        let run_puzzle = puzzle.to_nodeptr(allocator)?;
        let run_args = solution.to_nodeptr(allocator)?;
        let conditions = run_program(
            allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()?;
        CoinCondition::from_nodeptr(allocator, conditions.1)
    }
}
