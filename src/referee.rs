use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    chia_dialect, GameHandler, MessageHandler, MessageInputs, MyTurnInputs, TheirTurnInputs,
    TheirTurnResult,
};
use crate::channel_handler::types::{
    Evidence, GameStartInfo, PrintableGameStartInfo, ReadableMove, ValidationInfo,
    ValidationProgram,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, puzzle_for_pk,
    standard_solution_partial, standard_solution_unsafe, ChiaIdentity,
};
use crate::common::types::{
    u64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount, CoinCondition, CoinSpend,
    CoinString, Error, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256tree, Spend,
    Timeout,
};

pub const REM_CONDITION_FIELDS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameMoveStateInfo {
    pub move_made: Vec<u8>,
    pub mover_share: Amount,
    pub max_move_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct TheirTurnMoveResult {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub readable_move: NodePtr,
    pub message: Vec<u8>,
}

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
    pub reward_coin: CoinString,
}

pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: Option<CoinString>,
    },
    Moved {
        // New iteration of the game coin.
        new_coin_string: CoinString,
        readable: NodePtr,
    },
    Slash(Box<SlashOutcome>),
}

#[derive(Default)]
pub struct RefereeMakerArgsOptions {
    checked: bool,
    inverted: bool,
    game_move: Option<GameMoveDetails>,
    previous_validation_info_hash: Option<Option<Hash>>,
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
struct RefereePuzzleArgs {
    mover_puzzle_hash: PuzzleHash,
    waiter_puzzle_hash: PuzzleHash,
    timeout: Timeout,
    amount: Amount,
    nonce: usize,
    game_move: GameMoveDetails,
    previous_validation_info_hash: Option<Hash>,
}

impl RefereePuzzleArgs {
    fn to_node_list(
        &self,
        allocator: &mut AllocEncoder,
        referee_coin_puzzle_hash: &PuzzleHash,
    ) -> Result<Vec<Node>, Error> {
        Ok([
            self.mover_puzzle_hash.to_clvm(allocator).into_gen()?,
            self.waiter_puzzle_hash.to_clvm(allocator).into_gen()?,
            self.timeout.to_clvm(allocator).into_gen()?,
            self.amount.to_clvm(allocator).into_gen()?,
            referee_coin_puzzle_hash.to_clvm(allocator).into_gen()?,
            self.nonce.to_clvm(allocator).into_gen()?,
            allocator
                .encode_atom(&self.game_move.basic.move_made)
                .into_gen()?,
            self.game_move
                .basic
                .max_move_size
                .to_clvm(allocator)
                .into_gen()?,
            self.game_move
                .validation_info_hash
                .to_clvm(allocator)
                .into_gen()?,
            self.game_move
                .basic
                .mover_share
                .to_clvm(allocator)
                .into_gen()?,
            if let Some(p) = self.previous_validation_info_hash.as_ref() {
                assert_ne!(p, &Hash::default());
                p.to_clvm(allocator).into_gen()?
            } else {
                ().to_clvm(allocator).into_gen()?
            },
        ]
        .into_iter()
        .map(Node)
        .collect())
    }
}

fn curry_referee_puzzle_hash(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle_hash: &PuzzleHash,
    args: &RefereePuzzleArgs,
) -> Result<PuzzleHash, Error> {
    let args_to_curry: Vec<Node> = args.to_node_list(allocator, referee_coin_puzzle_hash)?;
    let combined_args = args_to_curry.to_clvm(allocator).into_gen()?;
    debug!(
        "combined_args {}",
        disassemble(allocator.allocator(), combined_args, None)
    );
    let arg_hash = Node(combined_args).sha256tree(allocator);
    let arg_hash_clvm = arg_hash.to_clvm(allocator).into_gen()?;
    debug!(
        "curried in puzzle arg_hash {}",
        disassemble(allocator.allocator(), arg_hash_clvm, None)
    );
    debug!(
        "curry_referee_puzzle_hash {}",
        disassemble(allocator.allocator(), combined_args, None)
    );
    Ok(curry_and_treehash(
        &PuzzleHash::from_hash(calculate_hash_of_quoted_mod_hash(referee_coin_puzzle_hash)),
        &[arg_hash],
    ))
}

// Agg sig me on the solution of the referee_coin_puzzle.
// When it invokes the validation program, it passes through args as the full
// argument set.
fn curry_referee_puzzle(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle: &Puzzle,
    referee_coin_puzzle_hash: &PuzzleHash,
    args: &RefereePuzzleArgs,
) -> Result<Puzzle, Error> {
    let args_to_curry: Vec<Node> = args.to_node_list(allocator, referee_coin_puzzle_hash)?;
    let combined_args = args_to_curry.to_clvm(allocator).into_gen()?;
    debug!(
        "curry_referee_puzzle {}",
        disassemble(allocator.allocator(), combined_args, None)
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
pub struct ValidatorMoveArgs {
    pub game_move: GameMoveDetails,
    pub mover_puzzle: Program,
    pub solution: NodePtr,
}

impl ValidatorMoveArgs {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        let args: &[NodePtr] = &[
            allocator
                .encode_atom(&self.game_move.basic.move_made)
                .into_gen()?,
            self.game_move
                .validation_info_hash
                .to_clvm(allocator)
                .into_gen()?,
            self.game_move
                .basic
                .mover_share
                .to_clvm(allocator)
                .into_gen()?,
            self.game_move
                .basic
                .max_move_size
                .to_clvm(allocator)
                .into_gen()?,
            self.mover_puzzle.to_clvm(allocator).into_gen()?,
            self.solution,
        ];
        let argvec: Vec<Node> = args.iter().map(|v| Node(*v)).collect();
        argvec.to_clvm(allocator).into_gen()
    }
}

#[allow(dead_code)]
pub enum Validation {
    ValidationByState(ValidationInfo),
    ValidationByStateHash(Hash),
}

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
pub enum RefereeMakerGameState {
    Initial {
        initial_state: NodePtr,
        initial_validation_program: ValidationProgram,
        initial_move: GameMoveStateInfo,
        game_handler: GameHandler,
    },
    // We were given a validation program back from the 'our turn' handler
    // as well as a state.
    AfterOurTurn {
        game_handler: GameHandler,
        #[allow(dead_code)]
        their_turn_game_handler: GameHandler,
        their_previous_validation_info_hash: Option<Hash>,
        validation_program: ValidationProgram,
        state: NodePtr,
        most_recent_their_move: GameMoveStateInfo,
        most_recent_our_move: GameMoveDetails,
    },
    AfterTheirTurn {
        game_handler: GameHandler,
        #[allow(dead_code)]
        our_turn_game_handler: GameHandler,
        our_previous_validation_info_hash: Option<Hash>,
        most_recent_our_validation_program: ValidationProgram,
        most_recent_our_state_result: NodePtr,
        #[allow(dead_code)]
        most_recent_our_move: GameMoveStateInfo,
        most_recent_their_move: GameMoveDetails,
    },
}

impl RefereeMakerGameState {
    pub fn is_my_turn(&self) -> bool {
        match self {
            RefereeMakerGameState::Initial { game_handler, .. } => {
                matches!(game_handler, GameHandler::MyTurnHandler(_))
            }
            RefereeMakerGameState::AfterOurTurn { .. } => true,
            RefereeMakerGameState::AfterTheirTurn { .. } => false,
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
    mover_coin_puzzle: Puzzle,
    /// A solution for the above puzzle that the onchain referee applies to
    /// extract the puzzle output conditions.  The spend results in a re-formed
    /// referee on chain.
    mover_coin_spend_solution: NodePtr,
    /// The signature, which may be over part of the solution or something
    /// derived from it.
    mover_coin_spend_signature: Aggsig,
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
    fn get_signature(&self) -> Option<Aggsig> {
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

impl ToClvm<NodePtr> for OnChainRefereeSolution {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        match self {
            OnChainRefereeSolution::Timeout => encoder.encode_atom(&[]),
            OnChainRefereeSolution::Move(refmove) => {
                // Max move size is left off
                (
                    Node(encoder.encode_atom(&refmove.details.basic.move_made)?),
                    (
                        refmove.details.validation_info_hash.clone(),
                        (
                            refmove.details.basic.mover_share.clone(),
                            (
                                refmove.details.basic.max_move_size,
                                (
                                    refmove.mover_coin.mover_coin_puzzle.clone(),
                                    (Node(refmove.mover_coin.mover_coin_spend_solution), ()),
                                ),
                            ),
                        ),
                    ),
                )
                    .to_clvm(encoder)
            }
            OnChainRefereeSolution::Slash(refslash) => (
                Node(refslash.previous_game_state),
                (
                    refslash.previous_validation_info.hash(),
                    (
                        refslash.mover_coin.mover_coin_puzzle.clone(),
                        (
                            Node(refslash.mover_coin.mover_coin_spend_solution),
                            (refslash.slash_evidence.clone(), ()),
                        ),
                    ),
                ),
            )
                .to_clvm(encoder),
        }
    }
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone)]
pub struct RefereeMaker {
    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub my_identity: ChiaIdentity,

    pub their_referee_puzzle_hash: PuzzleHash,

    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
    pub finished: bool,

    state: RefereeMakerGameState,

    pub message_handler: Option<MessageHandler>,

    #[cfg(test)]
    pub run_debug: bool,
}

impl RefereeMaker {
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        debug!(
            "referee maker: game start {:?}",
            PrintableGameStartInfo {
                allocator: allocator.allocator(),
                info: game_start_info
            }
        );
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
            max_move_size: game_start_info.initial_max_move_size,
        };
        let state = RefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state,
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_move: initial_move.clone(),
            game_handler: game_start_info.game_handler.clone(),
        };
        let my_turn = game_start_info.game_handler.is_my_turn();
        debug!("referee maker: my_turn {my_turn}");

        let puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &referee_coin_puzzle_hash,
            &RefereePuzzleArgs {
                mover_puzzle_hash: if my_turn {
                    my_identity.puzzle_hash.clone()
                } else {
                    their_puzzle_hash.clone()
                },
                waiter_puzzle_hash: if my_turn {
                    their_puzzle_hash.clone()
                } else {
                    my_identity.puzzle_hash.clone()
                },
                timeout: game_start_info.timeout.clone(),
                amount: game_start_info.amount.clone(),
                nonce,
                game_move: GameMoveDetails {
                    basic: GameMoveStateInfo {
                        mover_share: if my_turn {
                            game_start_info.amount.clone() - initial_move.mover_share.clone()
                        } else {
                            initial_move.mover_share.clone()
                        },
                        ..initial_move.clone()
                    },
                    validation_info_hash: Hash::default(),
                },
                previous_validation_info_hash: None,
            },
        )?;

        Ok((
            RefereeMaker {
                referee_coin_puzzle,
                referee_coin_puzzle_hash,
                finished: false,

                their_referee_puzzle_hash: their_puzzle_hash.clone(),
                my_identity,
                timeout: game_start_info.timeout.clone(),
                amount: game_start_info.amount.clone(),
                nonce,

                state,
                message_handler: None,
                #[cfg(test)]
                run_debug: false,
            },
            puzzle_hash,
        ))
    }

    pub fn is_my_turn(&self) -> bool {
        self.state.is_my_turn()
    }

    pub fn get_game_handler(&self) -> GameHandler {
        match &self.state {
            RefereeMakerGameState::Initial { game_handler, .. }
            | RefereeMakerGameState::AfterOurTurn { game_handler, .. }
            | RefereeMakerGameState::AfterTheirTurn { game_handler, .. } => game_handler.clone(),
        }
    }

    pub fn get_game_state(&self) -> NodePtr {
        match &self.state {
            RefereeMakerGameState::Initial { initial_state, .. } => *initial_state,
            RefereeMakerGameState::AfterOurTurn { state, .. } => *state,
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_state_result,
                ..
            } => *most_recent_our_state_result,
        }
    }

    pub fn get_our_most_recent_game_move(&self) -> Result<GameMoveDetails, Error> {
        match &self.state {
            RefereeMakerGameState::Initial { .. } => Err(Error::StrErr(
                "There is no move to replay from the initial state".to_string(),
            )),
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                ..
            } => Ok(most_recent_our_move.clone()),
            RefereeMakerGameState::AfterTheirTurn { .. } => {
                todo!();
            }
        }
    }

    pub fn get_our_most_recent_validation_info_hash(&self) -> Option<Hash> {
        match &self.state {
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                ..
            } => Some(most_recent_our_move.validation_info_hash.clone()),
            _ => None,
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(NodePtr, ValidationProgram), Error> {
        match &self.state {
            RefereeMakerGameState::Initial { .. } => {
                Err(Error::StrErr("no moves have been made yet".to_string()))
            }
            RefereeMakerGameState::AfterOurTurn { .. } => Err(Error::StrErr(
                "we accepted an our move so their move has sunsetted".to_string(),
            )),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_validation_program,
                most_recent_our_state_result,
                ..
            } => Ok((
                *most_recent_our_state_result,
                most_recent_our_validation_program.clone(),
            )),
        }
    }

    pub fn get_their_move_and_validation_info_for_onchain_move(
        &self,
    ) -> Result<(GameMoveDetails, Option<Hash>), Error> {
        match &self.state {
            RefereeMakerGameState::Initial { .. } => Err(Error::StrErr(
                "we're on the initial move so there's no move to look back at".to_string(),
            )),
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                their_previous_validation_info_hash,
                ..
            } => Ok((
                most_recent_our_move.clone(),
                their_previous_validation_info_hash.clone(),
            )),
            RefereeMakerGameState::AfterTheirTurn { .. } => Err(Error::StrErr(
                "after their move, they can't do another move".to_string(),
            )),
        }
    }

    #[cfg(test)]
    pub fn enable_debug_run(&mut self, ena: bool) {
        self.run_debug = ena;
    }

    pub fn get_validation_program_clvm(&self) -> Result<NodePtr, Error> {
        match &self.state {
            RefereeMakerGameState::Initial {
                initial_validation_program,
                ..
            } => Ok(initial_validation_program.to_nodeptr()),
            RefereeMakerGameState::AfterOurTurn {
                validation_program, ..
            } => Ok(validation_program.to_nodeptr()),
            RefereeMakerGameState::AfterTheirTurn { .. } => Err(Error::StrErr(
                "we already accepted their turn so it can't be validated".to_string(),
            )),
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        let mover_share = match &self.state {
            RefereeMakerGameState::Initial { initial_move, .. } => initial_move.mover_share.clone(),
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                ..
            } => most_recent_our_move.basic.mover_share.clone(),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_their_move,
                ..
            } => most_recent_their_move.basic.mover_share.clone(),
        };
        if self.is_my_turn() {
            mover_share
        } else {
            self.amount.clone() - mover_share
        }
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.amount.clone() - self.get_our_current_share()
    }

    pub fn accept_this_move(
        &mut self,
        game_handler: &GameHandler,
        validation_program: &ValidationProgram,
        state: NodePtr,
        details: &GameMoveDetails,
    ) -> Result<(), Error> {
        debug!("accept move {details:?}");
        let new_state = match &self.state {
            RefereeMakerGameState::Initial { initial_move, .. } => {
                RefereeMakerGameState::AfterOurTurn {
                    game_handler: game_handler.clone(),
                    their_turn_game_handler: game_handler.clone(),
                    validation_program: validation_program.clone(),
                    their_previous_validation_info_hash: None,
                    state,
                    most_recent_their_move: initial_move.clone(),
                    most_recent_our_move: details.clone(),
                }
            }
            RefereeMakerGameState::AfterOurTurn { .. } => {
                return Err(Error::StrErr(
                    "accept our move when it's already past our turn".to_string(),
                ));
            }
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_their_move,
                ..
            } => RefereeMakerGameState::AfterOurTurn {
                game_handler: game_handler.clone(),
                their_turn_game_handler: game_handler.clone(),
                validation_program: validation_program.clone(),
                state,
                most_recent_their_move: most_recent_their_move.basic.clone(),
                most_recent_our_move: details.clone(),
                their_previous_validation_info_hash: Some(
                    most_recent_their_move.validation_info_hash.clone(),
                ),
            },
        };

        self.state = new_state;
        Ok(())
    }

    pub fn accept_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        game_handler: Option<GameHandler>,
        details: &GameMoveDetails,
    ) -> Result<(), Error> {
        debug!("accept their move {details:?}");

        // An empty handler if the game ended.
        let raw_game_handler = if let Some(g) = game_handler.as_ref() {
            g.clone()
        } else {
            let nil = allocator.encode_atom(&[]).into_gen()?;
            GameHandler::MyTurnHandler(nil)
        };

        let new_state = match &self.state {
            RefereeMakerGameState::Initial {
                initial_validation_program,
                initial_state,
                initial_move,
                ..
            } => RefereeMakerGameState::AfterTheirTurn {
                game_handler: raw_game_handler.clone(),
                our_turn_game_handler: raw_game_handler.clone(),
                most_recent_our_state_result: *initial_state,
                most_recent_our_validation_program: initial_validation_program.clone(),
                most_recent_our_move: initial_move.clone(),
                most_recent_their_move: details.clone(),
                our_previous_validation_info_hash: None,
            },
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                state,
                validation_program,
                ..
            } => RefereeMakerGameState::AfterTheirTurn {
                game_handler: raw_game_handler.clone(),
                most_recent_our_state_result: *state,
                most_recent_our_validation_program: validation_program.clone(),
                our_turn_game_handler: raw_game_handler.clone(),
                most_recent_our_move: most_recent_our_move.basic.clone(),
                most_recent_their_move: details.clone(),
                our_previous_validation_info_hash: Some(
                    most_recent_our_move.validation_info_hash.clone(),
                ),
            },
            RefereeMakerGameState::AfterTheirTurn { .. } => {
                return Err(Error::StrErr(
                    "accept their move when it's already past their turn".to_string(),
                ));
            }
        };

        if game_handler.is_none() {
            self.finished = true;
        }

        debug!("accept their move: {new_state:?}");
        self.state = new_state;
        Ok(())
    }

    // Since we may need to know new_entropy at a higher layer, we'll need to ensure it
    // gets passed in rather than originating it here.
    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<GameMoveWireData, Error> {
        let game_handler = self.get_game_handler();
        let (move_data, mover_share, max_move_size, previous_validation_info_hash) =
            match &self.state {
                RefereeMakerGameState::Initial { initial_move, .. } => (
                    initial_move.move_made.clone(),
                    initial_move.mover_share.clone(),
                    initial_move.max_move_size,
                    None,
                ),
                RefereeMakerGameState::AfterOurTurn { .. } => {
                    return Err(Error::StrErr(
                        "trying to make our turn after our turn".to_string(),
                    ));
                }
                RefereeMakerGameState::AfterTheirTurn {
                    most_recent_their_move,
                    ..
                } => (
                    most_recent_their_move.basic.move_made.clone(),
                    self.amount.clone() - most_recent_their_move.basic.mover_share.clone(),
                    most_recent_their_move.basic.max_move_size,
                    Some(most_recent_their_move.validation_info_hash.clone()),
                ),
            };

        debug!("my turn: previous_validation_info_hash {previous_validation_info_hash:?}");

        let result = game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.amount.clone(),
                last_move: &move_data,
                last_mover_share: mover_share,
                last_max_move_size: max_move_size,
                entropy: new_entropy,
                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?;

        debug!("my turn result {result:?}");
        debug!(
            "new state {}",
            disassemble(allocator.allocator(), result.state, None)
        );

        self.accept_this_move(
            &result.waiting_driver,
            &result.validation_program,
            result.state,
            &result.game_move,
        )?;

        self.message_handler = result.message_parser;

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        let pre_ref_puzzle_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: result.game_move.clone(),
            previous_validation_info_hash,
        };
        let check_ref_puzzle_args = self.curried_referee_args_for_validator(&self.state, RefereeMakerArgsOptions { checked: true, .. Default::default() })?;
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &pre_ref_puzzle_args,
        )?;
        let check_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &check_ref_puzzle_args,
        )?;
        assert_eq!(new_curried_referee_puzzle_hash, check_curried_referee_puzzle_hash);

        debug!("new_curried_referee_puzzle_hash (our turn) {new_curried_referee_puzzle_hash:?}");
        Ok(GameMoveWireData {
            puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
            details: result.game_move.clone(),
        })
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        // Do stuff with message handler.
        let (state, move_data, mover_share) = match &self.state {
            RefereeMakerGameState::Initial {
                initial_state,
                initial_move,
                ..
            } => (
                initial_state,
                initial_move.move_made.clone(),
                initial_move.mover_share.clone(),
            ),
            RefereeMakerGameState::AfterOurTurn {
                state,
                most_recent_their_move,
                most_recent_our_move,
                ..
            } => (
                state,
                most_recent_their_move.move_made.clone(),
                self.amount.clone() - most_recent_our_move.basic.mover_share.clone(),
            ),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_state_result,
                most_recent_their_move,
                ..
            } => (
                most_recent_our_state_result,
                vec![],
                self.amount.clone() - most_recent_their_move.basic.mover_share.clone(),
            ),
        };

        let result = if let Some(handler) = self.message_handler.as_ref() {
            handler.run(
                allocator,
                &MessageInputs {
                    message: message.to_vec(),
                    amount: self.amount.clone(),
                    state: *state,
                    move_data,
                    mover_share,
                },
            )?
        } else {
            return Err(Error::StrErr(
                "no message handler but have a message".to_string(),
            ));
        };

        self.message_handler = None;

        Ok(result)
    }

    fn curried_referee_args_for_validator(&self, state: &RefereeMakerGameState, options: RefereeMakerArgsOptions) -> Result<RefereePuzzleArgs, Error> {
        assert!(options.checked);
        let direction = state.is_my_turn() ^ options.inverted;
        let (previous_validation_info_hash, game_move, validation_info_hash) = match state {
            RefereeMakerGameState::Initial { .. } => {
                return Err(Error::StrErr(
                    "can't challenge before a move is made".to_string(),
                ));
            }
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                their_previous_validation_info_hash,
                ..
            } => (
                their_previous_validation_info_hash,
                most_recent_our_move.basic.clone(),
                most_recent_our_move.validation_info_hash.clone(),
            ),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_their_move,
                our_previous_validation_info_hash,
                ..
            } => (
                our_previous_validation_info_hash,
                most_recent_their_move.basic.clone(),
                most_recent_their_move.validation_info_hash.clone(),
            ),
        };

        Ok(RefereePuzzleArgs {
            mover_puzzle_hash: if direction {
                self.their_referee_puzzle_hash.clone()
            } else {
                self.my_identity.puzzle_hash.clone()
            },
            waiter_puzzle_hash: if direction {
                self.my_identity.puzzle_hash.clone()
            } else {
                self.their_referee_puzzle_hash.clone()
            },
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: options.game_move.unwrap_or_else(|| GameMoveDetails {
                basic: game_move,
                validation_info_hash: validation_info_hash.clone(),
            }),
            previous_validation_info_hash: options.previous_validation_info_hash.unwrap_or_else(|| previous_validation_info_hash.clone()),
        })
    }

    pub fn curried_referee_puzzle_hash_for_validator(
        &self,
        allocator: &mut AllocEncoder,
        inverted: bool,
        checked: bool,
    ) -> Result<PuzzleHash, Error> {
        let args = self.curried_referee_args_for_validator(&self.state, RefereeMakerArgsOptions { inverted, checked, .. Default::default() })?;
        curry_referee_puzzle_hash(allocator, &self.referee_coin_puzzle_hash, &args)
    }

    pub fn curried_referee_puzzle_for_validator(
        &self,
        allocator: &mut AllocEncoder,
        inverted: bool,
        checked: bool,
    ) -> Result<Puzzle, Error> {
        let args = self.curried_referee_args_for_validator(&self.state, RefereeMakerArgsOptions { inverted, checked, .. Default::default() })?;
        curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &args,
        )
    }

    // Ensure this returns
    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        puzzle: &Puzzle,
        always_produce_transaction: bool,
        args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let my_mover_share = self.get_our_current_share();

        if always_produce_transaction || my_mover_share != Amount::default() {
            let signature = args.get_signature().unwrap_or_default();

            // The transaction solution is not the same as the solution for the
            // inner puzzle as we take additional move or slash data.
            //
            // OnChainRefereeSolution encodes this properly.
            let transaction_solution = args.to_clvm(allocator).into_gen()?;
            debug!(
                "transaction_solution {}",
                disassemble(allocator.allocator(), transaction_solution, None)
            );
            let transaction_bundle = Spend {
                puzzle: puzzle.clone(),
                solution: Program::from_nodeptr(allocator, transaction_solution)?,
                signature,
            };
            let output_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &puzzle.sha256tree(allocator),
                &my_mover_share,
            );
            return Ok(Some(RefereeOnChainTransaction {
                bundle: transaction_bundle,
                reward_coin: output_coin_string,
            }));
        }

        // Zero mover share case.
        Ok(None)
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    pub fn get_transaction_for_timeout(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let spend_puzzle = self.curried_referee_puzzle_for_validator(allocator, true, true)?;
        self.get_transaction(
            allocator,
            coin_string,
            &spend_puzzle,
            false,
            &OnChainRefereeSolution::Timeout,
        )
    }

    /// The move transaction works like this:
    ///
    /// The referee puzzle has the hash of the puzzle of another locking coin,
    /// possibly the standard coin, and uses that to secure against another person
    /// commanding it.  This isn't the be confused with the coin that serves as the
    /// parent of the referee coin which is also assumed to be a standard puzzle
    /// coin.
    ///
    /// The inner coin, assuming it is a standard coin, takes the puzzle reveal
    /// for the above puzzle and the solution for that inner puzzle as the last two
    /// arguments to the move case of how it's invoked.
    ///
    /// The output conditions to step it are therefore built into those conditions
    /// which needs to include the puzzle hash of the target state of the referee
    /// (their move, the state precipitated by our move set as the current game
    /// state).
    ///
    /// We do the spend of the inner puzzle to that puzzle hash to progress the
    /// referee coin.
    ///
    /// One consequence of this is that we must sign it with the synthetic private
    /// key as the standard puzzle embeds a synthetic public key based on it.
    ///
    /// In all cases, we're spending a referee coin that already exists.  The use
    /// of the mover coin here is purely to take advantage of its puzzle to provide
    /// a signature requirement.
    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        agg_sig_me_additional_data: &Hash,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // We can only do a move to replicate our turn.
        assert!(self.is_my_turn());

        // Get the puzzle hash for the next referee state.
        // This reflects a "their turn" state with the updated state from the
        // game handler returned by consuming our move.  This is assumed to
        // have been done by consuming the move in a different method call.

        // Get the current state of the referee on chain.  This reflects the
        // current state at the time the move was made.
        // The current referee uses the previous state since we have already
        // taken the move.
        //
        debug!("get_transaction_for_move: previous curry");
        let (their_most_recent_game_move, previous_validation_info_hash) =
            self.get_their_move_and_validation_info_for_onchain_move()?;

        let check_existing_curry_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            game_move: their_most_recent_game_move.clone(),
            nonce: self.nonce,
            previous_validation_info_hash: previous_validation_info_hash.clone(),
        };
        let existing_curry_args = self.curried_referee_args_for_validator(&self.state, RefereeMakerArgsOptions { checked: true, inverted: true, game_move: Some(their_most_recent_game_move.clone()), previous_validation_info_hash: Some(previous_validation_info_hash) })?;
        let check_current_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &check_existing_curry_args,
        )?;
        let current_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &existing_curry_args,
        )?;
        assert_eq!(check_current_referee_puzzle_hash, current_referee_puzzle_hash);

        debug!("actual puzzle reveal");
        let spend_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &existing_curry_args,
        )?;

        let spend_puzzle_nodeptr = spend_puzzle.to_clvm(allocator).into_gen()?;
        debug!(
            "spend puzzle {}",
            disassemble(allocator.allocator(), spend_puzzle_nodeptr, None)
        );
        assert_eq!(
            spend_puzzle.sha256tree(allocator),
            current_referee_puzzle_hash
        );

        debug!("get_transaction_for_move: target curry");
        let game_move = self.get_our_most_recent_game_move()?;
        let target_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            game_move,
            nonce: self.nonce,
            previous_validation_info_hash: self.get_our_most_recent_validation_info_hash(),
        };
        let target_referee_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.referee_coin_puzzle_hash, &target_args)?;
        let target_referee_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &target_args,
        )?;
        let target_referee_puzzle_nodeptr = target_referee_puzzle.to_clvm(allocator).into_gen()?;
        debug!(
            "target_referee_puzzle {}",
            disassemble(allocator.allocator(), target_referee_puzzle_nodeptr, None)
        );
        assert_eq!(
            target_referee_puzzle.sha256tree(allocator),
            target_referee_puzzle_hash
        );

        let inner_conditions = [(
            CREATE_COIN,
            (
                target_referee_puzzle_hash.clone(),
                (self.amount.clone(), ()),
            ),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        // Generalize this once the test is working.  Move out the assumption that
        // referee private key is my_identity.synthetic_private_key.
        let referee_spend = standard_solution_partial(
            allocator,
            &self.my_identity.synthetic_private_key,
            &coin_string.to_coin_id(),
            inner_conditions,
            &self.my_identity.synthetic_public_key,
            agg_sig_me_additional_data,
            false,
        )?;

        let args_list = OnChainRefereeSolution::Move(OnChainRefereeMove {
            details: self.get_our_most_recent_game_move()?,
            mover_coin: IdentityCoinAndSolution {
                mover_coin_puzzle: self.my_identity.puzzle.clone(),
                mover_coin_spend_solution: referee_spend.solution,
                mover_coin_spend_signature: referee_spend.signature.clone(),
            },
        });

        if let Some(transaction) =
            self.get_transaction(allocator, coin_string, &spend_puzzle, true, &args_list)?
        {
            Ok(transaction)
        } else {
            // Return err
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }

    pub fn run_validator_for_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        validator_move_args: &ValidatorMoveArgs,
    ) -> Result<(), Error> {
        let (_state, validation_program) = self.get_validation_program_for_their_move()?;
        let validator_move_converted = validator_move_args.to_nodeptr(allocator)?;
        // Error means validation should not work.
        // It should be handled later.
        run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program.to_nodeptr(),
            validator_move_converted,
            0,
        )
        .into_gen()?;
        Ok(())
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
    ) -> Result<TheirTurnMoveResult, Error> {
        debug!("do their turn {details:?}");

        let handler = self.get_game_handler();

        let (last_state, last_move, previous_validation_info_hash) = match &self.state {
            RefereeMakerGameState::Initial {
                initial_state,
                initial_move,
                ..
            } => (initial_state, initial_move.clone(), None),
            RefereeMakerGameState::AfterOurTurn {
                most_recent_our_move,
                state,
                ..
            } => (
                state,
                most_recent_our_move.basic.clone(),
                Some(most_recent_our_move.validation_info_hash.clone()),
            ),
            RefereeMakerGameState::AfterTheirTurn { .. } => {
                return Err(Error::StrErr(
                    "Can't take their move when we're after their move".to_string(),
                ));
            }
        };

        debug!("their turn: previous_validation_info_hash {previous_validation_info_hash:?}");

        // Retrieve evidence from their turn handler.
        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.amount.clone(),
                last_state: *last_state,

                last_move: &last_move.move_made,
                last_mover_share: last_move.mover_share.clone(),

                new_move: details.clone(),

                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?;

        let (readable_move, message) = match result {
            TheirTurnResult::FinalMove(readable_move) => {
                self.accept_their_move(allocator, None, details)?;

                (readable_move, vec![])
            }
            TheirTurnResult::MakeMove(readable_move, handler, message) => {
                // Mover puzzle turns the given solution into coin conditions
                // that pay the game's amount to us.  It checks whether the
                // originally curried mover puzzle hash is the sha256tree of the
                // mover puzzle.
                //
                // This referee expects the mover puzzle to be a standard-like
                // puzzle or at least take standard coin arguments including the
                // list of conditions it produces itself.
                //
                // In case this succeeds, we'll direct the result to our mover
                // puzzle, which sets our identity for the game and is a value-
                // holding coin spendable by us.
                self.accept_their_move(allocator, Some(handler), details)?;

                debug!(
                    "readable_move {}",
                    disassemble(allocator.allocator(), readable_move, None)
                );
                debug!("message {message:?}");

                (readable_move, message)
            }
            // Slash can't be used when we're off chain.
            TheirTurnResult::Slash(_evidence, _signature) => {
                return Err(Error::StrErr("slash when off chain".to_string()));
            }
        };

        let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &RefereePuzzleArgs {
                mover_puzzle_hash: self.my_identity.puzzle_hash.clone(),
                waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                timeout: self.timeout.clone(),
                amount: self.amount.clone(),
                game_move: details.clone(),
                nonce: self.nonce,

                previous_validation_info_hash,
            },
        )?;
        debug!(
            "new_curried_referee_puzzle_hash (their turn): {:?}",
            puzzle_hash_for_unroll
        );

        // Coin calculated off the new new state.
        Ok(TheirTurnMoveResult {
            puzzle_hash_for_unroll,
            readable_move,
            message: message.clone(),
        })
    }

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.my_identity.puzzle_hash.clone()
    }

    fn slashing_coin_solution(
        &self,
        allocator: &mut AllocEncoder,
        state: NodePtr,
        validation_program_clvm: NodePtr,
        slash_solution: NodePtr,
        evidence: Evidence,
    ) -> Result<NodePtr, Error> {
        (
            Node(state),
            (
                Node(validation_program_clvm),
                (
                    self.target_puzzle_hash_for_slash(),
                    (Node(slash_solution), (Node(evidence.to_nodeptr()), ())),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }

    #[allow(clippy::too_many_arguments)]
    fn make_slash_for_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        new_puzzle: &Puzzle,
        new_puzzle_hash: &PuzzleHash,
        slash_solution: NodePtr,
        evidence: Evidence,
        sig: &Aggsig,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Probably readable_info overlaps solution.
        // Moving driver in that context is the signature.
        // My reward coin string is the coin that we'll make
        // after the transaction below has been spent so its
        // parent is the coin id of that coin.
        let current_mover_share = self.get_our_current_share();

        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let reward_amount = self.amount.clone() - current_mover_share;
        if reward_amount == Amount::default() {
            return Ok(TheirTurnCoinSpentResult::Slash(Box::new(
                SlashOutcome::NoReward,
            )));
        }

        let slashing_coin_solution = self.slashing_coin_solution(
            allocator,
            state,
            validation_program.to_nodeptr(),
            slash_solution,
            evidence,
        )?;

        let coin_string_of_output_coin =
            CoinString::from_parts(&coin_string.to_coin_id(), new_puzzle_hash, &reward_amount);

        Ok(TheirTurnCoinSpentResult::Slash(Box::new(
            SlashOutcome::Reward {
                transaction: Box::new(CoinSpend {
                    // Ultimate parent of these coins.
                    coin: coin_string.clone(),
                    bundle: Spend {
                        puzzle: new_puzzle.clone(),
                        solution: Program::from_nodeptr(allocator, slashing_coin_solution)?,
                        signature: sig.clone(),
                    },
                }),
                my_reward_coin_string: coin_string_of_output_coin,
            },
        )))
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &NodePtr,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Read parameters off conditions
        let rem_condition = if let Some(CoinCondition::Rem(rem_condition)) =
            CoinCondition::from_nodeptr(allocator, *conditions)
                .iter()
                .find(|cond| matches!(cond, CoinCondition::Rem(_)))
        {
            // Got rem condition
            rem_condition.to_vec()
        } else {
            Vec::default()
        };

        let mover_share = self.get_our_current_share();

        // Check properties of conditions
        if rem_condition.is_empty() {
            // Timeout case
            // Return enum timeout and we give the coin string of our reward
            // coin if any.
            // Something went wrong if i think it's my turn
            debug_assert!(!self.is_my_turn());

            let my_reward_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &self.my_identity.puzzle_hash,
                &mover_share,
            );

            return Ok(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string: Some(my_reward_coin_string),
            });
        }

        if rem_condition.len() != REM_CONDITION_FIELDS {
            return Err(Error::StrErr(
                "rem condition should have the right number of fields".to_string(),
            ));
        }

        let my_inner_puzzle = puzzle_for_pk(allocator, &self.my_identity.public_key)?;

        let new_move = &rem_condition[0];
        let new_validation_info_hash = Hash::from_slice(&rem_condition[1]);
        let (new_mover_share, new_max_move_size) = if let (Some(share), Some(max_size)) = (
            u64_from_atom(&rem_condition[2]),
            usize_from_atom(&rem_condition[3]),
        ) {
            (Amount::new(share), max_size)
        } else {
            return Err(Error::StrErr(
                "mover share wasn't a properly sized atom".to_string(),
            ));
        };

        let our_previous_move = self.get_our_most_recent_game_move()?;
        let ref_puzzle_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            nonce: self.nonce,
            game_move: GameMoveDetails {
                basic: GameMoveStateInfo {
                    move_made: new_move.clone(),
                    max_move_size: new_max_move_size,
                    mover_share: new_mover_share.clone(),
                },
                validation_info_hash: new_validation_info_hash.clone(),
            },
            previous_validation_info_hash: Some(our_previous_move.validation_info_hash.clone()),
        };
        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &ref_puzzle_args,
        )?;
        let new_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.referee_coin_puzzle_hash, &ref_puzzle_args)?;

        let game_handler = self.get_game_handler();

        // my_inner_solution maker is just in charge of making aggsigs from
        // conditions.
        let slash_conditions = (
            CREATE_COIN,
            (
                self.target_puzzle_hash_for_slash(),
                (self.amount.clone(), ()),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let slash_spend =
            standard_solution_unsafe(allocator, &self.my_identity.private_key, slash_conditions)?;

        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let full_slash_program = CurriedProgram {
            program: Node(validation_program.to_nodeptr()),
            args: clvm_curried_args!(
                Node(state),
                Node(validation_program.to_nodeptr()),
                my_inner_puzzle,
                Node(slash_spend.solution),
                0
            ),
        }
        .to_clvm(allocator)
        .into_gen()?;

        let nil = allocator.allocator().null();
        let full_slash_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            full_slash_program,
            nil,
            0,
        );

        let full_slash_solution = (
            Node(state),
            (
                Node(validation_program.to_nodeptr()),
                // No evidence here.
                (new_puzzle_hash.clone(), ((), (0, ()))),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        match full_slash_result {
            Ok(_) => {
                // Ultimately each of these cases returns some kind of
                // TheirTurnCoinSpentResult.
                let nil_evidence = Evidence::nil(allocator);

                // result is NodePtr containing solution and aggsig.
                // The aggsig for the nil slash is the same as the slash
                // below, having been created for the reward coin by using
                // the standard solution signer.
                self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    &new_puzzle,
                    &new_puzzle_hash,
                    full_slash_solution,
                    nil_evidence,
                    &slash_spend.signature,
                )
            }
            Err(_) => {
                // Slash wasn't allowed.  Run the move handler.
                let (readable_move, game_handler) = match game_handler.call_their_turn_driver(
                    allocator,
                    &TheirTurnInputs {
                        amount: self.amount.clone(),
                        last_state: state,
                        last_move: &self
                            .get_our_most_recent_game_move()?
                            .basic
                            .move_made
                            .clone(),
                        last_mover_share: self.get_our_current_share(),

                        new_move: GameMoveDetails {
                            basic: GameMoveStateInfo {
                                move_made: new_move.clone(),
                                max_move_size: new_max_move_size,
                                mover_share: new_mover_share.clone(),
                            },
                            validation_info_hash: new_validation_info_hash.clone(),
                        },

                        #[cfg(test)]
                        run_debug: self.run_debug,
                    },
                )? {
                    TheirTurnResult::Slash(evidence, sig) => {
                        return self.make_slash_for_their_turn(
                            allocator,
                            coin_string,
                            &new_puzzle,
                            &new_puzzle_hash,
                            full_slash_solution,
                            evidence,
                            &(slash_spend.signature + *sig),
                        );
                    }
                    TheirTurnResult::FinalMove(readable_move) => (readable_move, None),
                    TheirTurnResult::MakeMove(readable_move, game_handler, _message) => {
                        (readable_move, Some(game_handler))
                    }
                };

                // Otherwise accept move by updating our state
                self.accept_their_move(
                    allocator,
                    game_handler,
                    &GameMoveDetails {
                        basic: GameMoveStateInfo {
                            move_made: new_move.clone(),
                            max_move_size: new_max_move_size,
                            mover_share: new_mover_share.clone(),
                        },
                        validation_info_hash: new_validation_info_hash.clone(),
                    },
                )?;

                Ok(TheirTurnCoinSpentResult::Moved {
                    new_coin_string: CoinString::from_parts(
                        &coin_string.to_coin_id(),
                        &new_puzzle_hash,
                        &self.amount,
                    ),
                    readable: readable_move,
                })
            }
        }
    }
}
