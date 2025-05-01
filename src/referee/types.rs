use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::reduction::EvalErr;
use clvmr::run_program;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    MyStateUpdateProgram, TheirStateUpdateProgram, TheirTurnResult,
};
use crate::channel_handler::types::HasStateUpdateProgram;
use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo};
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, ChiaIdentity,
};
use crate::common::types::{
    atom_from_clvm, chia_dialect, i64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount,
    CoinSpend, CoinString, Error, GameID, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash,
    Sha256tree, Spend, Timeout,
};
use crate::referee::StateUpdateProgram;
use crate::utils::proper_list;

// pub const REM_CONDITION_FIELDS: usize = 4;

#[derive(Eq, PartialEq, Debug, Clone, Serialize, Deserialize)]
pub struct GameMoveStateInfo {
    pub move_made: Vec<u8>,
    pub mover_share: Amount,
}

#[derive(Debug, Eq, PartialEq, Clone, Serialize, Deserialize)]
pub struct GameMoveDetails {
    pub basic: GameMoveStateInfo,
    /// sha256 of the concatenation of two hashes:
    /// 1 - The next game handler program
    /// 2 - The game state.
    pub validation_info_hash: Hash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameMoveWireData {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub details: GameMoveDetails,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TheirTurnMoveResult {
    pub puzzle_hash_for_unroll: Option<PuzzleHash>,
    pub original: TheirTurnResult,
}

#[derive(Debug)]
pub enum SlashOutcome {
    NoReward,
    Reward {
        transaction: Box<CoinSpend>,
        my_reward_coin_string: CoinString,
    },
}

#[derive(Debug, Clone)]
pub struct RefereeOnChainTransaction {
    pub bundle: Spend,
    pub amount: Amount,
    pub coin: CoinString,
}

#[allow(dead_code)]
pub struct LiveGameReplay {
    #[allow(dead_code)]
    game_id: GameID,
}

#[derive(Debug)]
pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: Option<CoinString>,
    },
    Expected(PuzzleHash, Amount),
    Moved {
        // New iteration of the game coin.
        new_coin_string: CoinString,
        readable: ReadableMove,
        mover_share: Amount,
    },
    Slash(Box<SlashOutcome>),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateUpdateResult {
    MoveOk(Rc<Program>, ValidationInfo, usize),
    Slash(Rc<Program>),
}

impl StateUpdateResult {
    pub fn from_nodeptr(
        allocator: &mut AllocEncoder,
        validation_info: ValidationInfo,
        node: NodePtr,
    ) -> Result<StateUpdateResult, Error> {
        let lst = if let Some(p) = proper_list(allocator.allocator(), node, true) {
            p
        } else {
            return Err(Error::StrErr("non-list in validator result".to_string()));
        };

        if lst.is_empty() {
            return Err(Error::StrErr("empty list from validator".to_string()));
        }

        let selector =
            if let Some(a) = atom_from_clvm(allocator, lst[0]).and_then(|a| i64_from_atom(&a)) {
                a
            } else {
                return Err(Error::StrErr("not atom selector".to_string()));
            };

        if selector != 0 {
            // Slash
            let evidence_node = if lst.len() > 1 {
                lst[1]
            } else {
                allocator
                    .encode_atom(clvm_traits::Atom::Borrowed(&[]))
                    .into_gen()?
            };
            let evidence = Rc::new(Program::from_nodeptr(allocator, evidence_node)?);

            return Ok(StateUpdateResult::Slash(evidence));
        }

        if lst.len() < 3 {
            return Err(Error::StrErr("short list for make move".to_string()));
        }

        // Make move
        let max_move_size = atom_from_clvm(allocator, lst[3])
            .and_then(|a| usize_from_atom(&a))
            .unwrap_or_default();
        Ok(StateUpdateResult::MoveOk(
            Rc::new(Program::from_nodeptr(allocator, lst[2])?),
            validation_info,
            max_move_size,
        ))
    }
}

/// Adjudicates a two player turn based game
///
/// MOVE, VALIDATION_HASH and MOVER_SHARE were all accepted optimistically from the
/// last move
///
/// Both VALIDATION_HASH values are a sha256 of a validation program hash and the
/// shatree of a state
///
/// The next validation program hash may be nil which means no futher moves are
/// allowed
///
/// MOVER_SHARE is how much the mover will get if they fold/accept
/// MOD_HASH should be the shatree of referee itself
/// NONCE is for anti-replay prevention
///
/// If action is timeout args is nil
///
/// If action is slash args is (state validation_program mover_puzzle solution
/// evidence)
///
/// If action is move args is (new_move new_validation_info_hash new_mover_share
/// mover_puzzle solution)
///
/// validation programs get passed this:
/// ((last_move
///   next_validation_hash
///   my_share
///   me_hash
///   my_puzzle_hash
///   opponent_puzzle_hash
///   amount
///   timeout
///   max_move_size
///   referee_hash)
///  state
///  me
///  mover_puzzle
///  solution
///  evidence
///  )
#[derive(Eq, PartialEq, Debug, Clone)]
pub struct RefereePuzzleArgs<StateP: HasStateUpdateProgram> {
    pub mover_puzzle_hash: PuzzleHash,
    pub waiter_puzzle_hash: PuzzleHash,
    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
    pub game_move: GameMoveDetails,
    pub max_move_size: usize,
    pub validation_program: StateP,
    pub previous_validation_info_hash: Option<Hash>,
    pub referee_coin_puzzle_hash: PuzzleHash,
}

/*
        their_puzzle_hash: &PuzzleHash,
*/

impl<StateP: HasStateUpdateProgram + Clone> RefereePuzzleArgs<StateP> {
    pub fn new(
        fixed_info: &RMFixed,
        initial_move: &GameMoveDetails,
        max_move_size: usize,
        previous_validation_info_hash: Option<&Hash>,
        validation_program: StateP,
        my_turn: bool,
    ) -> Self {
        debug!(
            "PREVIOUS_VALIDATION_INFO_HASH {my_turn} {:?}",
            previous_validation_info_hash.map(|h| hex::encode(h.bytes()))
        );
        debug!(
            "VALIDATION_INFO_HASH {my_turn} {}",
            hex::encode(initial_move.validation_info_hash.bytes())
        );
        RefereePuzzleArgs {
            mover_puzzle_hash: if my_turn {
                fixed_info.my_identity.puzzle_hash.clone()
            } else {
                fixed_info.their_referee_puzzle_hash.clone()
            },
            waiter_puzzle_hash: if my_turn {
                fixed_info.their_referee_puzzle_hash.clone()
            } else {
                fixed_info.my_identity.puzzle_hash.clone()
            },
            timeout: fixed_info.timeout.clone(),
            amount: fixed_info.amount.clone(),
            nonce: fixed_info.nonce,
            max_move_size,
            validation_program,
            referee_coin_puzzle_hash: fixed_info.referee_coin_puzzle_hash.clone(),
            game_move: initial_move.clone(),
            previous_validation_info_hash: previous_validation_info_hash.cloned(),
        }
    }

    fn off_chain(&self) -> RefereePuzzleArgs<StateP> {
        let mut new_result: RefereePuzzleArgs<StateP> = self.clone();
        new_result.waiter_puzzle_hash = PuzzleHash::default();
        new_result
    }

    pub fn neutralize(&self) -> RefereePuzzleArgs<StateUpdateProgram> {
        RefereePuzzleArgs {
            mover_puzzle_hash: self.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: self.waiter_puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: self.game_move.clone(),
            max_move_size: self.max_move_size,
            validation_program: self.validation_program.p(),
            previous_validation_info_hash: self.previous_validation_info_hash.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
        }
    }

    pub fn fake_mine(&self) -> RefereePuzzleArgs<MyStateUpdateProgram> {
        RefereePuzzleArgs {
            mover_puzzle_hash: self.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: self.waiter_puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: self.game_move.clone(),
            max_move_size: self.max_move_size,
            validation_program: MyStateUpdateProgram(self.validation_program.p()),
            previous_validation_info_hash: self.previous_validation_info_hash.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
        }
    }

    pub fn fake_theirs(&self) -> RefereePuzzleArgs<TheirStateUpdateProgram> {
        RefereePuzzleArgs {
            mover_puzzle_hash: self.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: self.waiter_puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: self.game_move.clone(),
            max_move_size: self.max_move_size,
            validation_program: TheirStateUpdateProgram(self.validation_program.p()),
            previous_validation_info_hash: self.previous_validation_info_hash.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
        }
    }
}

impl<E: ClvmEncoder<Node = NodePtr>, S: HasStateUpdateProgram> ToClvm<E> for RefereePuzzleArgs<S>
where
    NodePtr: ToClvm<E>,
{
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        [
            self.mover_puzzle_hash.to_clvm(encoder)?,
            if self.waiter_puzzle_hash == PuzzleHash::default() {
                encoder.encode_atom(clvm_traits::Atom::Borrowed(&[]))?
            } else {
                self.waiter_puzzle_hash.to_clvm(encoder)?
            },
            self.timeout.to_clvm(encoder)?,
            self.amount.to_clvm(encoder)?,
            self.referee_coin_puzzle_hash.to_clvm(encoder)?,
            self.nonce.to_clvm(encoder)?,
            encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.game_move.basic.move_made))?,
            self.max_move_size.to_clvm(encoder)?,
            self.game_move.validation_info_hash.to_clvm(encoder)?,
            self.game_move.basic.mover_share.to_clvm(encoder)?,
            self.previous_validation_info_hash
                .as_ref()
                .to_clvm(encoder)?,
        ]
        .to_clvm(encoder)
    }
}

pub fn curry_referee_puzzle_hash<StateP: HasStateUpdateProgram>(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle_hash: &PuzzleHash,
    args: &RefereePuzzleArgs<StateP>,
) -> Result<PuzzleHash, Error> {
    let combined_args = args.to_clvm(allocator).into_gen()?;
    let arg_hash = Node(combined_args).sha256tree(allocator);
    Ok(curry_and_treehash(
        &PuzzleHash::from_hash(calculate_hash_of_quoted_mod_hash(referee_coin_puzzle_hash)),
        &[arg_hash],
    ))
}

// Agg sig me on the solution of the referee_coin_puzzle.
// When it invokes the validation program, it passes through args as the full
// argument set.
pub fn curry_referee_puzzle<StateP: HasStateUpdateProgram>(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle: &Puzzle,
    args: &RefereePuzzleArgs<StateP>,
) -> Result<Puzzle, Error> {
    let combined_args = args.to_clvm(allocator).into_gen()?;
    debug!(
        "curry_referee_puzzle {}",
        Node(combined_args).to_hex(allocator)?
    );
    let curried_program_nodeptr = CurriedProgram {
        program: referee_coin_puzzle,
        args: clvm_curried_args!(Node(combined_args)),
    }
    .to_clvm(allocator)
    .into_gen()?;
    Puzzle::from_nodeptr(allocator, curried_program_nodeptr)
}

/// Type of arguments for validator move queries.
///
/// The result will be coin conditions via the mover puzzle run with solution.
/// We'll check that the mover puzzle produces a coin whose puzzle hash is the
/// puzzle hash of the next referee coin for the right amount (the game's amount).
///
/// A remark is added which encodes the arguments that are required for off chain
/// interpretation containing:
///
/// - new_move
/// - new_validation_info_hash
/// - new_mover_share
/// - new_max_move_size
///
/// If we can spend the resulting coin and validate these remark items i think
/// we're good.
///
/// From my perspective, I always validate 'their' turn.
///
/// Mover puzzle is a wallet puzzle for an ordinary value coin and the solution
/// is next to it.
///
pub struct StateUpdateMoveArgs {
    pub state: Rc<Program>,
    pub mover_puzzle: Rc<Program>,
    pub solution: Rc<Program>,
    pub evidence: Rc<Program>,
}

impl StateUpdateMoveArgs {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder, me: NodePtr) -> Result<NodePtr, Error> {
        let me_program = Program::from_nodeptr(allocator, me)?;
        (
            &self.state,
            (
                &me_program,
                [&self.mover_puzzle, &self.solution, &self.evidence],
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }
}

pub struct InternalStateUpdateArgs<StateP: HasStateUpdateProgram> {
    pub validation_program: StateUpdateProgram,
    pub referee_args: Rc<RefereePuzzleArgs<StateP>>,
    pub state_update_args: StateUpdateMoveArgs,
}

impl<StateP: HasStateUpdateProgram + Clone> InternalStateUpdateArgs<StateP> {
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder,
        validator_mod_hash: PuzzleHash,
    ) -> Result<NodePtr, Error> {
        let validation_program_node = self
            .referee_args
            .validation_program
            .p()
            .to_nodeptr(allocator)?;
        let converted_vma = self
            .state_update_args
            .to_nodeptr(allocator, validation_program_node)?;
        (
            validator_mod_hash,
            (
                self.referee_args
                    .off_chain()
                    .to_clvm(allocator)
                    .into_gen()?,
                Node(converted_vma),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }

    pub fn run(&self, allocator: &mut AllocEncoder) -> Result<StateUpdateResult, Error> {
        let neutral_validation = self.referee_args.validation_program.p();
        let validation_program_mod_hash = neutral_validation.hash();
        debug!("validation_program_mod_hash {validation_program_mod_hash:?}");
        let validation_program_nodeptr = self.validation_program.p().to_nodeptr(allocator)?;
        let validator_full_args_node = self.to_nodeptr(
            allocator,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;
        let node_ptr = self.state_update_args.state.to_clvm(allocator).into_gen()?;
        let validation_info = ValidationInfo::new_from_state_update_program_hash_and_state(
            allocator,
            validation_program_mod_hash.clone(),
            node_ptr,
        );

        debug!("validator program {:?}", self.validation_program);
        debug!("validator args {:?}", validator_full_args);
        let raw_result_p = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            0,
        )
        .into_gen();
        if let Err(Error::ClvmErr(EvalErr(n, e))) = &raw_result_p {
            debug!(
                "validator error {e} {:?}",
                Program::from_nodeptr(allocator, *n)
            );
        }
        let raw_result = raw_result_p?;
        let pres = Program::from_nodeptr(allocator, raw_result.1)?;
        debug!("validator result {pres:?}");

        let update_result =
            StateUpdateResult::from_nodeptr(allocator, validation_info, raw_result.1)?;
        Ok(update_result)
    }
}

#[allow(dead_code)]
pub enum Validation {
    ValidationByState(ValidationInfo),
    ValidationByStateHash(Hash),
}

/// A puzzle for a coin that will be run inside the referee to generate
/// conditions that are acted on to spend the referee coin.
/// The referee knows the mover puzzle hash, so we've already decided what
/// puzzle this is.  It is usually the standard coin puzzle from the user's
/// ChiaIdentity.
///
/// This groups that with the solution.
#[derive(Debug, Clone)]
pub struct IdentityCoinAndSolution {
    /// A puzzle for a coin that will be run inside the referee to generate
    /// conditions that are acted on to spend the referee coin.
    /// The referee knows the mover puzzle hash, so we've already decided what
    /// puzzle this is.  It is usually the standard coin puzzle from the user's
    /// ChiaIdentity.
    pub mover_coin_puzzle: Puzzle,
    /// A solution for the above puzzle that the onchain referee applies to
    /// extract the puzzle output conditions.  The spend results in a re-formed
    /// referee on chain.
    pub mover_coin_spend_solution: Rc<Program>,
    /// The signature, which may be over part of the solution or something
    /// derived from it.
    pub mover_coin_spend_signature: Aggsig,
}

/// Dynamic arguments passed to the on chain refere to apply a move
#[derive(Debug, Clone)]
pub struct OnChainRefereeMove {
    /// From the wire protocol.
    pub details: GameMoveDetails,
    /// Max move size specified in on chain move REM.
    pub max_move_size: usize,
    /// Coin puzzle and solution that are used to generate conditions for the
    /// next generation of the on chain refere coin.
    pub mover_coin: IdentityCoinAndSolution,
}

/// Dynamic arguments passed to the on chain refere to apply a slash
#[derive(Debug, Clone)]
pub struct OnChainRefereeSlash {
    /// The game state is used here
    pub previous_game_state: NodePtr,

    /// Since notionally we optimistically accept game updates at the referee
    /// layer, "previous" here is the current state at the time the move arrived,
    /// previous to the update that caused this slash.
    pub previous_validation_info: ValidationInfo,

    /// Coin puzzle and solution that are used to generate conditions for the
    /// next generation of the on chain refere coin.
    pub mover_coin: IdentityCoinAndSolution,

    /// clvm data about the slash.
    pub slash_evidence: Evidence,
}

/// onchain referee solution
///
/// This represents the whole solution for the on chain referee.
///
/// It is a solution itself, but the referee coin uses the mover puzzle as a
/// puzzle for a coin that represents the user's identity ... most likely a
/// standard puzzle.
#[derive(Debug, Clone)]
pub enum OnChainRefereeSolution {
    Timeout,
    Move(OnChainRefereeMove),
    #[allow(dead_code)]
    Slash(OnChainRefereeSlash),
}

impl OnChainRefereeSolution {
    // Get the standard solution for these referee arguments.
    // We will sign it with the synthetic private key if it exists.
    pub fn get_signature(&self) -> Option<Aggsig> {
        match self {
            OnChainRefereeSolution::Timeout => None,
            OnChainRefereeSolution::Move(refmove) => {
                Some(refmove.mover_coin.mover_coin_spend_signature.clone())
            }
            OnChainRefereeSolution::Slash(refslash) => {
                Some(refslash.mover_coin.mover_coin_spend_signature.clone())
            }
        }
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for OnChainRefereeSolution
where
    NodePtr: ToClvm<E>,
{
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        match self {
            OnChainRefereeSolution::Timeout => {
                encoder.encode_atom(clvm_traits::Atom::Borrowed(&[]))
            }
            OnChainRefereeSolution::Move(refmove) => {
                let refmove_coin_solution_ref: &Program =
                    refmove.mover_coin.mover_coin_spend_solution.borrow();

                // Max move size is left off
                (
                    encoder.encode_atom(clvm_traits::Atom::Borrowed(
                        &refmove.details.basic.move_made,
                    ))?,
                    (
                        refmove.details.validation_info_hash.clone(),
                        (
                            refmove.details.basic.mover_share.clone(),
                            (
                                refmove.max_move_size,
                                (
                                    refmove.mover_coin.mover_coin_puzzle.clone(),
                                    (refmove_coin_solution_ref, ()),
                                ),
                            ),
                        ),
                    ),
                )
                    .to_clvm(encoder)
            }
            OnChainRefereeSolution::Slash(refslash) => {
                let refslash_solution_ref: &Program =
                    refslash.mover_coin.mover_coin_spend_solution.borrow();
                (
                    Node(refslash.previous_game_state),
                    (
                        refslash.previous_validation_info.hash(),
                        (
                            refslash.mover_coin.mover_coin_puzzle.clone(),
                            (refslash_solution_ref, (refslash.slash_evidence.clone(), ())),
                        ),
                    ),
                )
                    .to_clvm(encoder)
            }
        }
    }
}

#[derive(Debug)]
pub struct RMFixed {
    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub my_identity: ChiaIdentity,

    pub their_referee_puzzle_hash: PuzzleHash,
    pub agg_sig_me_additional_data: Hash,

    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
}
