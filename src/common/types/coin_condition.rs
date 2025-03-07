use log::debug;

use clvmr::allocator::{NodePtr, SExp};
use clvmr::{run_program, ChiaDialect, NO_UNKNOWN_OPS};

use crate::utils::proper_list;

use crate::common::constants::{AGG_SIG_ME_ATOM, AGG_SIG_UNSAFE_ATOM, CREATE_COIN_ATOM, REM_ATOM};

use crate::common::types::{
    u64_from_atom, AllocEncoder, Amount, Error, Hash, IntoErr, Node, Program, PublicKey, PuzzleHash,
};

pub fn chia_dialect() -> ChiaDialect {
    ChiaDialect::new(NO_UNKNOWN_OPS)
}

#[derive(Debug, Clone)]
pub enum CoinCondition {
    AggSigMe(PublicKey, Vec<u8>),
    AggSigUnsafe(PublicKey, Vec<u8>),
    #[allow(dead_code)]
    CreateCoin(PuzzleHash, Amount),
    Rem(Vec<Vec<u8>>),
}

fn parse_condition(allocator: &mut AllocEncoder, condition: NodePtr) -> Option<CoinCondition> {
    let exploded = proper_list(allocator.allocator(), condition, true)?;
    let public_key_from_bytes = |b: &[u8]| -> Result<PublicKey, Error> {
        let mut fixed: [u8; 48] = [0; 48];
        for (i, b) in b.iter().enumerate() {
            fixed[i % 48] = *b;
        }
        PublicKey::from_bytes(fixed)
    };
    if exploded.len() > 2
        && matches!(
            (
                allocator.allocator().sexp(exploded[0]),
                allocator.allocator().sexp(exploded[1]),
                allocator.allocator().sexp(exploded[2])
            ),
            (SExp::Atom, SExp::Atom, SExp::Atom)
        )
    {
        let atoms: Vec<Vec<u8>> = exploded
            .iter()
            .take(3)
            .map(|a| allocator.allocator().atom(*a).to_vec())
            .collect();
        if *atoms[0] == AGG_SIG_UNSAFE_ATOM {
            if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                return Some(CoinCondition::AggSigUnsafe(pk, atoms[2].to_vec()));
            }
        } else if *atoms[0] == AGG_SIG_ME_ATOM {
            if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                return Some(CoinCondition::AggSigMe(pk, atoms[2].to_vec()));
            }
        } else if *atoms[0] == CREATE_COIN_ATOM {
            if let Some(amt) = u64_from_atom(&atoms[2]) {
                return Some(CoinCondition::CreateCoin(
                    PuzzleHash::from_hash(Hash::from_slice(&atoms[1])),
                    Amount::new(amt),
                ));
            }
        }
    }

    if !exploded.is_empty()
        && exploded
            .iter()
            .all(|e| matches!(allocator.allocator().sexp(*e), SExp::Atom))
    {
        let atoms: Vec<Vec<u8>> = exploded
            .iter()
            .map(|a| allocator.allocator().atom(*a).to_vec())
            .collect();
        if *atoms[0] == REM_ATOM {
            return Some(CoinCondition::Rem(
                atoms.iter().skip(1).map(|a| a.to_vec()).collect(),
            ));
        }
    }

    None
}

impl CoinCondition {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, conditions: NodePtr) -> Vec<CoinCondition> {
        // Ensure this borrow of allocator is finished for what's next.
        if let Some(exploded) = proper_list(allocator.allocator(), conditions, true) {
            exploded
                .iter()
                .flat_map(|cond| parse_condition(allocator, *cond))
                .collect()
        } else {
            Vec::new()
        }
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
            0,
        )
        .into_gen()?;
        debug!(
            "conditions to parse {}",
            Node(conditions.1).to_hex(allocator)?
        );

        Ok(CoinCondition::from_nodeptr(allocator, conditions.1))
    }
}
