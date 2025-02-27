use std::borrow::Borrow;
use std::rc::Rc;

use clvmr::NodePtr;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use serde::{Serialize, Deserialize};

use crate::common::types::{Aggsig, AllocEncoder, Amount, CoinSpend, CoinString, Error, Hash, IntoErr, Node, Program, ProgramRef, Puzzle, PuzzleHash, Spend, Timeout, atom_from_clvm, usize_from_atom};
use crate::common::standard_coin::ChiaIdentity;
use crate::channel_handler::types::{Evidence, ValidationProgram, ValidationInfo, ReadableMove};
use crate::channel_handler::game_handler::{GameHandler, MyTurnResult, TheirTurnResult};
use crate::referee::puzzle_args::RefereePuzzleArgs;
use crate::utils::proper_list;

pub const REM_CONDITION_FIELDS: usize = 4;

#[derive(Eq, PartialEq, Debug, Clone, Serialize, Deserialize)]
pub struct GameMoveStateInfo {
    pub move_made: Vec<u8>,
    pub mover_share: Amount,
    pub max_move_size: usize,
}

#[derive(Debug, Eq, PartialEq, Clone, Serialize, Deserialize)]
pub struct GameMoveDetails {
    pub basic: GameMoveStateInfo,
    /// sha256 of the concatenation of two hashes:
    /// 1 - The next game handler program
    /// 2 - The game state.
    pub validation_info_hash: Hash,
}

#[derive(Debug, Clone)]
pub struct GameMoveWireData {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub details: GameMoveDetails,
}

#[derive(Debug, Clone)]
pub struct RefereeOnChainTransaction {
    pub bundle: Spend,
    pub amount: Amount,
    pub coin: CoinString,
}

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

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
pub enum RefereeMakerGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_validation_program: ValidationProgram,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        initial_max_move_size: usize,
        game_handler: GameHandler,
    },
    // We were given a validation program back from the 'our turn' handler
    // as well as a state.
    AfterOurTurn {
        game_handler: GameHandler,
        my_turn_result: Rc<MyTurnResult>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
        state: ProgramRef,
        max_move_size: usize,
    },
    AfterTheirTurn {
        game_handler: GameHandler,
        #[allow(dead_code)]
        our_turn_game_handler: GameHandler,
        most_recent_our_validation_program: ValidationProgram,
        most_recent_our_state_result: Rc<Program>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
    },
}

impl RefereeMakerGameState {
    pub fn is_my_turn(&self) -> bool {
        match self {
            RefereeMakerGameState::Initial { game_handler, .. } => {
                matches!(game_handler, GameHandler::MyTurnHandler(_))
            }
            RefereeMakerGameState::AfterOurTurn { .. } => false,
            RefereeMakerGameState::AfterTheirTurn { .. } => true,
        }
    }

    pub fn processing_my_turn(&self) -> bool {
        match self {
            RefereeMakerGameState::Initial { .. } => false,
            RefereeMakerGameState::AfterOurTurn { .. } => true,
            RefereeMakerGameState::AfterTheirTurn { .. } => false,
        }
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            RefereeMakerGameState::AfterOurTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
            RefereeMakerGameState::AfterTheirTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            RefereeMakerGameState::AfterOurTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
            RefereeMakerGameState::AfterTheirTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
        }
    }
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

#[derive(Clone, Debug)]
pub struct StoredGameState {
    state: Rc<RefereeMakerGameState>,
    state_number: usize,
}

#[derive(Debug)]
pub enum ValidatorResult {
    MoveOk,
    Slash(NodePtr),
}

impl ValidatorResult {
    pub fn from_nodeptr(
        allocator: &mut AllocEncoder,
        node: NodePtr
    ) -> Result<ValidatorResult, Error> {
        let error = |allocator: &mut AllocEncoder| {
            Err(Error::StrErr(format!("bad validator result {}", Node(node).to_hex(allocator)?)))
        };

        if let Some(p) = proper_list(allocator.allocator(), node, true) {
            if p.is_empty() {
                return error(allocator);
            }

            return match atom_from_clvm(allocator, p[0]).and_then(|a| usize_from_atom(&a)) {
                Some(0) => {
                    // make move
                    if p.len() < 4 {
                        return error(allocator);
                    }
                    let hash = Hash::from_nodeptr(allocator, p[1])?;
                    let state = Program::from_nodeptr(allocator, p[2])?;
                    let max_move_size =
                        if let Some(m) = atom_from_clvm(allocator, p[3]).and_then(|a| usize_from_atom(&a)) {
                            m
                        } else {
                            return error(allocator);
                        };
                    Ok(ValidatorResult::MoveOk)
                },
                Some(2) => {
                    // slash
                    if p.len() < 2 {
                        return error(allocator);
                    }

                    Ok(ValidatorResult::Slash(p[1]))
                }
                _ => {
                    error(allocator)
                }
            };
        }

        error(allocator)
    }
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
pub struct ValidatorMoveArgs {
    pub state: Rc<Program>,
    pub mover_puzzle: Rc<Program>,
    pub solution: Rc<Program>,
    pub evidence: Rc<Program>,
}

impl ValidatorMoveArgs {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder, me: NodePtr) -> Result<NodePtr, Error> {
        let me_program = Program::from_nodeptr(allocator, me)?;
        [
            &self.state,
            &me_program,
            &self.mover_puzzle,
            &self.solution,
            &self.evidence,
        ]
        .to_clvm(allocator)
        .into_gen()
    }
}

pub struct InternalValidatorArgs {
    pub referee_args: RefereePuzzleArgs,
    pub referee_hash: PuzzleHash,
    pub move_args: ValidatorMoveArgs,
}

impl InternalValidatorArgs {
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder,
        me: NodePtr,
        validator_mod_hash: PuzzleHash,
    ) -> Result<NodePtr, Error> {
        let converted_vma = self.move_args.to_nodeptr(allocator, me)?;
        let move_node = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&self.referee_args.game_move.basic.move_made))
            .into_gen()?;
        (
            validator_mod_hash,
            (
                (
                    Node(move_node),
                    (
                        self.referee_args.game_move.validation_info_hash.clone(),
                        (
                            self.referee_args.game_move.basic.mover_share.clone(),
                            (
                                self.referee_args.previous_validation_info_hash.clone(),
                                (
                                    self.referee_args.mover_puzzle_hash.clone(),
                                    (
                                        self.referee_args.waiter_puzzle_hash.clone(),
                                        (
                                            self.referee_args.amount.clone(),
                                            (
                                                self.referee_args.timeout.clone(),
                                                (
                                                    self.referee_args.game_move.basic.max_move_size,
                                                    (self.referee_hash.clone(), ()),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                Node(converted_vma),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }
}

#[allow(dead_code)]
pub enum Validation {
    ValidationByState(ValidationInfo),
    ValidationByStateHash(Hash),
}

#[derive(Debug, Clone)]
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

#[derive(Debug)]
pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: Option<CoinString>,
    },
    Moved {
        // New iteration of the game coin.
        new_coin_string: CoinString,
        readable: ReadableMove,
        mover_share: Amount,
    },
    Slash(Box<SlashOutcome>),
}
