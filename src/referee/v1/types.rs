use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::reduction::EvalErr;
use clvmr::run_program;

use log::debug;

use crate::channel_handler::types::{Evidence, StateUpdateProgram, ValidationInfo};
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, ChiaIdentity,
};
use crate::common::types::{
    atom_from_clvm, chia_dialect, i64_from_atom, Aggsig, AllocEncoder, Amount, Error, GameID, Hash,
    IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256tree, Timeout,
};
use crate::referee::types::GameMoveDetails;
use crate::utils::proper_list;

pub const REM_CONDITION_FIELDS: usize = 4;

#[allow(dead_code)]
pub struct LiveGameReplay {
    #[allow(dead_code)]
    game_id: GameID,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateUpdateResult {
    MoveOk(Rc<Program>),
    Slash(Rc<Program>),
}

impl StateUpdateResult {
    pub fn from_nodeptr(
        allocator: &mut AllocEncoder,
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

        Ok(StateUpdateResult::MoveOk(Rc::new(Program::from_nodeptr(
            allocator, lst[2],
        )?)))
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
pub struct RefereePuzzleArgs {
    pub mover_puzzle_hash: PuzzleHash,
    pub waiter_puzzle_hash: PuzzleHash,
    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
    pub game_move: GameMoveDetails,
    pub validation_program: StateUpdateProgram,
    pub previous_validation_info_hash: Option<Hash>,
    pub referee_coin_puzzle_hash: PuzzleHash,
}

impl RefereePuzzleArgs {
    pub fn new(
        fixed_info: &RMFixed,
        initial_move: &GameMoveDetails,
        previous_validation_info_hash: Option<&Hash>,
        validation_program: StateUpdateProgram,
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
            validation_program,
            referee_coin_puzzle_hash: fixed_info.referee_coin_puzzle_hash.clone(),
            game_move: initial_move.clone(),
            previous_validation_info_hash: previous_validation_info_hash.cloned(),
        }
    }

    pub fn off_chain(&self) -> RefereePuzzleArgs {
        let mut new_result: RefereePuzzleArgs = self.clone();
        new_result.waiter_puzzle_hash = PuzzleHash::default();
        new_result
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for RefereePuzzleArgs
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
            self.game_move.basic.max_move_size.to_clvm(encoder)?,
            self.game_move.validation_info_hash.to_clvm(encoder)?,
            self.game_move.basic.mover_share.to_clvm(encoder)?,
            self.previous_validation_info_hash
                .as_ref()
                .to_clvm(encoder)?,
        ]
        .to_clvm(encoder)
    }
}

pub fn curry_referee_puzzle_hash(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle_hash: &PuzzleHash,
    args: &RefereePuzzleArgs,
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
pub fn curry_referee_puzzle(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle: &Puzzle,
    args: &RefereePuzzleArgs,
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
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder,
        me: StateUpdateProgram,
    ) -> Result<NodePtr, Error> {
        (
            &self.state,
            (me, [&self.mover_puzzle, &self.solution, &self.evidence]),
        )
            .to_clvm(allocator)
            .into_gen()
    }
}

pub struct InternalStateUpdateArgs {
    pub validation_program: StateUpdateProgram,
    pub referee_args: Rc<RefereePuzzleArgs>,
    pub state_update_args: StateUpdateMoveArgs,
}

impl InternalStateUpdateArgs {
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder,
        validator_mod_hash: PuzzleHash,
    ) -> Result<NodePtr, Error> {
        let converted_vma = self
            .state_update_args
            .to_nodeptr(allocator, self.validation_program.clone())?;
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
        assert_eq!(
            self.referee_args.validation_program.hash(),
            self.validation_program.hash()
        );
        let validation_program_mod_hash = self.validation_program.hash();
        debug!("validation_program_mod_hash {validation_program_mod_hash:?}");
        let validation_program_nodeptr = self.validation_program.to_nodeptr(allocator)?;
        let validator_full_args_node = self.to_nodeptr(
            allocator,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;

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

        StateUpdateResult::from_nodeptr(allocator, raw_result.1)
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
                                refmove.details.basic.max_move_size,
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
