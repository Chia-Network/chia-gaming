use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, MyTurnInputs, MyTurnResult, TheirTurnInputs,
    TheirTurnMoveData, TheirTurnResult,
};
use crate::channel_handler::types::{
    Evidence, GameStartInfo, ReadableMove, ValidationInfo, ValidationProgram,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    chia_dialect, u64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount,
    BrokenOutCoinSpendInfo, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, IntoErr,
    Node, Program, Puzzle, PuzzleHash, RcNode, Sha256Input, Sha256tree, Spend, Timeout,
};

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
    Moved {
        // New iteration of the game coin.
        new_coin_string: CoinString,
        readable: ReadableMove,
        mover_share: Amount,
    },
    Slash(Box<SlashOutcome>),
}
#[derive(Debug)]
pub enum ValidatorResult {
    MoveOk,
    Slash(NodePtr),
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
#[derive(Eq, PartialEq, Debug)]
pub struct RefereePuzzleArgs {
    mover_puzzle_hash: PuzzleHash,
    waiter_puzzle_hash: PuzzleHash,
    timeout: Timeout,
    amount: Amount,
    nonce: usize,
    game_move: GameMoveDetails,
    previous_validation_info_hash: Option<Hash>,
}

/*
        their_puzzle_hash: &PuzzleHash,
*/

impl RefereePuzzleArgs {
    fn new(
        fixed_info: &RMFixed,
        initial_move: &GameMoveStateInfo,
        previous_validation_info_hash: Option<&Hash>,
        validation_info_hash: &Hash,
        mover_share: Option<&Amount>,
        my_turn: bool,
    ) -> Self {
        debug!(
            "PREVIOUS_VALIDATION_INFO_HASH {my_turn} {:?}",
            previous_validation_info_hash.map(|h| hex::encode(h.bytes()))
        );
        debug!(
            "VALIDATION_INFO_HASH {my_turn} {}",
            hex::encode(validation_info_hash.bytes())
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
            game_move: GameMoveDetails {
                basic: GameMoveStateInfo {
                    mover_share: mover_share
                        .cloned()
                        .unwrap_or_else(|| initial_move.mover_share.clone()),
                    ..initial_move.clone()
                },
                validation_info_hash: validation_info_hash.clone(),
            },
            previous_validation_info_hash: previous_validation_info_hash.cloned(),
        }
    }

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
                .encode_atom(clvm_traits::Atom::Borrowed(&self.game_move.basic.move_made))
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
    let arg_hash = Node(combined_args).sha256tree(allocator);
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
    mover_puzzle_hash: PuzzleHash,
    waiter_puzzle_hash: PuzzleHash,
    timeout: Timeout,
    amount: Amount,
    previous_validation_info_hash: Hash,
    move_made: Vec<u8>,
    new_validation_info_hash: Hash,
    mover_share: Amount,
    max_move_size: usize,
    referee_hash: PuzzleHash,
    move_args: ValidatorMoveArgs,
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
            .encode_atom(clvm_traits::Atom::Borrowed(&self.move_made))
            .into_gen()?;
        (
            validator_mod_hash,
            (
                (
                    self.mover_puzzle_hash.clone(),
                    (
                        self.waiter_puzzle_hash.clone(),
                        (
                            self.timeout.clone(),
                            (
                                self.amount.clone(),
                                (
                                    self.previous_validation_info_hash.clone(),
                                    (
                                        (), // Unused nonce.
                                        (
                                            Node(move_node),
                                            (
                                                self.new_validation_info_hash.clone(),
                                                (
                                                    self.mover_share.clone(),
                                                    (
                                                        self.max_move_size,
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

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
enum RefereeMakerGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_validation_program: ValidationProgram,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        game_handler: GameHandler,
    },
    // We were given a validation program back from the 'our turn' handler
    // as well as a state.
    AfterOurTurn {
        game_handler: GameHandler,
        my_turn_result: Rc<MyTurnResult>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
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
    mover_coin_puzzle: Puzzle,
    /// A solution for the above puzzle that the onchain referee applies to
    /// extract the puzzle output conditions.  The spend results in a re-formed
    /// referee on chain.
    mover_coin_spend_solution: Rc<Program>,
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

struct RMFixed {
    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub my_identity: ChiaIdentity,

    pub their_referee_puzzle_hash: PuzzleHash,
    pub agg_sig_me_additional_data: Hash,

    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
}

#[derive(Clone, Debug)]
pub struct StoredGameState {
    state: Rc<RefereeMakerGameState>,
    state_number: usize,
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone)]
pub struct RefereeMaker {
    fixed: Rc<RMFixed>,

    pub finished: bool,

    #[cfg(test)]
    pub run_debug: bool,

    pub message_handler: Option<MessageHandler>,

    state: Rc<RefereeMakerGameState>,
    old_states: Vec<StoredGameState>,
}

impl RefereeMaker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize,
        agg_sig_me_additional_data: &Hash,
    ) -> Result<(Self, PuzzleHash), Error> {
        debug!("referee maker: game start {:?}", game_start_info);
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
            max_move_size: game_start_info.initial_max_move_size,
        };
        let my_turn = game_start_info.game_handler.is_my_turn();
        debug!("referee maker: my_turn {my_turn}");

        let fixed_info = Rc::new(RMFixed {
            referee_coin_puzzle,
            referee_coin_puzzle_hash: referee_coin_puzzle_hash.clone(),
            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_identity: my_identity.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce,
            agg_sig_me_additional_data: agg_sig_me_additional_data.clone(),
        });

        // TODO: Revisit how we create initial_move
        let is_hash = game_start_info
            .initial_state
            .sha256tree(allocator)
            .hash()
            .clone();
        let ip_hash = game_start_info
            .initial_validation_program
            .sha256tree(allocator)
            .hash()
            .clone();
        let vi_hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&is_hash),
            Sha256Input::Hash(&ip_hash),
        ])
        .hash();
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &fixed_info,
            &initial_move,
            None,
            &vi_hash,
            // Special for start: nobody can slash the first turn and both sides need to
            // compute the same value for amount to sign.  The next move will set mover share
            // and the polarity of the move will determine whether that applies to us or them
            // from both frames of reference.
            Some(&Amount::default()),
            my_turn,
        ));
        // If this reflects my turn, then we will spend the next parameter set.
        if my_turn {
            assert_eq!(
                fixed_info.my_identity.puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
            );
        } else {
            assert_eq!(
                fixed_info.their_referee_puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
            );
        }
        let state = Rc::new(RefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        Ok((
            RefereeMaker {
                fixed: fixed_info,
                finished: false,
                state,
                old_states: Vec::new(),
                message_handler: None,
                #[cfg(test)]
                run_debug: false,
            },
            puzzle_hash,
        ))
    }

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.args_for_this_coin()
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.spend_this_coin()
    }

    pub fn rewind(
        &mut self,
        allocator: &mut AllocEncoder,
        puzzle_hash: &PuzzleHash,
    ) -> Result<Option<usize>, Error> {
        debug!("REWIND: find a way to proceed from {puzzle_hash:?}");
        for old_state in self.old_states.iter().skip(1).rev() {
            let start_args = old_state.state.args_for_this_coin();
            let end_args = old_state.state.spend_this_coin();
            debug!(
                "end   puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &end_args
                )
            );
            debug!(
                "state {} is_my_turn {}",
                old_state.state_number,
                old_state.state.is_my_turn()
            );
            debug!(
                "start puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &start_args
                )
            );
        }

        for old_state in self.old_states.iter().skip(1).rev() {
            let have_puzzle_hash = curry_referee_puzzle_hash(
                allocator,
                &self.fixed.referee_coin_puzzle_hash,
                &old_state.state.args_for_this_coin(),
            )?;
            debug!(
                "referee rewind: {} my turn {} try state {have_puzzle_hash:?} want {puzzle_hash:?}",
                old_state.state.is_my_turn(),
                old_state.state_number
            );
            if *puzzle_hash == have_puzzle_hash && old_state.state.is_my_turn() {
                self.state = old_state.state.clone();
                debug!("referee rewind my turn: reassume state {:?}", self.state);
                return Ok(Some(old_state.state_number));
            }
        }

        debug!("referee rewind: no matching state");
        debug!("still in state {:?}", self.state);
        Ok(None)
    }

    pub fn is_my_turn(&self) -> bool {
        self.state.is_my_turn()
    }

    pub fn processing_my_turn(&self) -> bool {
        self.state.processing_my_turn()
    }

    pub fn get_game_handler(&self) -> GameHandler {
        match self.state.borrow() {
            RefereeMakerGameState::Initial { game_handler, .. }
            | RefereeMakerGameState::AfterOurTurn { game_handler, .. }
            | RefereeMakerGameState::AfterTheirTurn { game_handler, .. } => game_handler.clone(),
        }
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            RefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            RefereeMakerGameState::AfterOurTurn { my_turn_result, .. } => {
                my_turn_result.state.clone()
            }
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_state_result,
                ..
            } => most_recent_our_state_result.clone(),
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(&Program, ValidationProgram), Error> {
        match self.state.borrow() {
            RefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_validation_program,
                ..
            } => {
                if game_handler.is_my_turn() {
                    return Err(Error::StrErr("no moves have been made yet".to_string()));
                }
                Ok((initial_state, initial_validation_program.clone()))
            }
            RefereeMakerGameState::AfterOurTurn { .. } => Err(Error::StrErr(
                "we accepted an our move so their move has sunsetted".to_string(),
            )),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_validation_program,
                most_recent_our_state_result,
                ..
            } => Ok((
                most_recent_our_state_result,
                most_recent_our_validation_program.clone(),
            )),
        }
    }

    #[cfg(test)]
    pub fn enable_debug_run(&mut self, ena: bool) {
        self.run_debug = ena;
    }

    pub fn get_validation_program(&self) -> Result<Rc<Program>, Error> {
        match self.state.borrow() {
            RefereeMakerGameState::Initial {
                initial_validation_program,
                ..
            } => Ok(initial_validation_program.to_program().clone()),
            RefereeMakerGameState::AfterOurTurn { my_turn_result, .. } => {
                Ok(my_turn_result.validation_program.to_program())
            }
            RefereeMakerGameState::AfterTheirTurn { .. } => Err(Error::StrErr(
                "we already accepted their turn so it can't be validated".to_string(),
            )),
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed.amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed.amount.clone() - self.get_our_current_share()
    }

    pub fn accept_this_move(
        &mut self,
        game_handler: &GameHandler,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        my_turn_result: Rc<MyTurnResult>,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<(), Error> {
        debug!("{state_number} accept move {details:?}");
        assert_ne!(
            current_puzzle_args.mover_puzzle_hash,
            new_puzzle_args.mover_puzzle_hash
        );
        assert_eq!(
            current_puzzle_args.mover_puzzle_hash,
            new_puzzle_args.waiter_puzzle_hash
        );
        assert_eq!(
            self.fixed.my_identity.puzzle_hash,
            current_puzzle_args.mover_puzzle_hash
        );
        let new_state = RefereeMakerGameState::AfterOurTurn {
            game_handler: game_handler.clone(),
            my_turn_result,
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
        };

        self.old_states.push(StoredGameState {
            state: self.state.clone(),
            state_number,
        });
        self.state = Rc::new(new_state);
        Ok(())
    }

    pub fn accept_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        game_handler: Option<GameHandler>,
        old_args: Rc<RefereePuzzleArgs>,
        referee_args: Rc<RefereePuzzleArgs>,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<(), Error> {
        assert_ne!(old_args.mover_puzzle_hash, referee_args.mover_puzzle_hash);
        assert_eq!(old_args.mover_puzzle_hash, referee_args.waiter_puzzle_hash);
        assert_eq!(
            self.fixed.my_identity.puzzle_hash,
            referee_args.mover_puzzle_hash
        );
        debug!("accept their move {details:?}");

        // An empty handler if the game ended.
        let raw_game_handler = if let Some(g) = game_handler.as_ref() {
            g.clone()
        } else {
            let nil = allocator
                .encode_atom(clvm_traits::Atom::Borrowed(&[]))
                .into_gen()?;
            GameHandler::MyTurnHandler(Program::from_nodeptr(allocator, nil)?.into())
        };

        let new_state = match self.state.borrow() {
            RefereeMakerGameState::Initial {
                initial_validation_program,
                initial_state,
                ..
            } => {
                let is_hash = initial_state.sha256tree(allocator).hash().clone();
                let ip_hash = initial_validation_program
                    .sha256tree(allocator)
                    .hash()
                    .clone();
                let vi_hash = Sha256Input::Array(vec![
                    Sha256Input::Hash(&is_hash),
                    Sha256Input::Hash(&ip_hash),
                ])
                .hash();
                debug!("accept their move: state hash   {is_hash:?}");
                debug!("accept their move: valprog hash {ip_hash:?}");
                debug!("accept their move: validation info hash {vi_hash:?}");
                RefereeMakerGameState::AfterTheirTurn {
                    game_handler: raw_game_handler.clone(),
                    our_turn_game_handler: raw_game_handler.clone(),
                    most_recent_our_state_result: initial_state.clone(),
                    most_recent_our_validation_program: initial_validation_program.clone(),
                    create_this_coin: old_args,
                    spend_this_coin: referee_args,
                }
            }
            RefereeMakerGameState::AfterOurTurn { my_turn_result, .. } => {
                let is_hash = my_turn_result.state.sha256tree(allocator).hash().clone();
                let ip_hash = my_turn_result
                    .validation_program
                    .sha256tree(allocator)
                    .hash()
                    .clone();
                let vi_hash = Sha256Input::Array(vec![
                    Sha256Input::Hash(&is_hash),
                    Sha256Input::Hash(&ip_hash),
                ])
                .hash();
                debug!("accept their move: state hash   {is_hash:?}");
                debug!("accept their move: valprog hash {ip_hash:?}");
                debug!("accept their move: validation info hash {vi_hash:?}");
                RefereeMakerGameState::AfterTheirTurn {
                    game_handler: raw_game_handler.clone(),
                    most_recent_our_state_result: my_turn_result.state.clone(),
                    most_recent_our_validation_program: my_turn_result.validation_program.clone(),
                    our_turn_game_handler: raw_game_handler.clone(),
                    create_this_coin: old_args,
                    spend_this_coin: referee_args,
                }
            }
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
        self.old_states.push(StoredGameState {
            state: self.state.clone(),
            state_number,
        });
        self.state = Rc::new(new_state);
        Ok(())
    }

    // Since we may need to know new_entropy at a higher layer, we'll need to ensure it
    // gets passed in rather than originating it here.
    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        assert!(self.is_my_turn());

        let game_handler = self.get_game_handler();
        let args = self.spend_this_coin();

        debug!("my turn state {:?}", self.state);
        debug!("entropy {state_number} {new_entropy:?}");
        let result = Rc::new(game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.fixed.amount.clone(),
                last_move: &args.game_move.basic.move_made,
                last_mover_share: args.game_move.basic.mover_share.clone(),
                last_max_move_size: args.game_move.basic.max_move_size,
                entropy: new_entropy.clone(),
                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?);
        debug!("referee my turn referee move details {:?}", result);

        debug!("my turn result {result:?}");
        debug!("new state {:?}", result.state);

        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &result.game_move.basic,
            Some(&args.game_move.validation_info_hash),
            &result.game_move.validation_info_hash,
            None,
            false,
        ));
        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            ref_puzzle_args.previous_validation_info_hash.as_ref()
        );

        self.accept_this_move(
            &result.waiting_driver,
            args.clone(),
            ref_puzzle_args.clone(),
            result.clone(),
            &result.game_move,
            state_number,
        )?;

        self.message_handler = result.message_parser.clone();

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &ref_puzzle_args,
        )?;

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
        let (state, move_data, mover_share) = match self.state.borrow() {
            RefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_puzzle_args,
                ..
            } => (
                initial_state,
                initial_puzzle_args.game_move.basic.move_made.clone(),
                if matches!(game_handler, GameHandler::MyTurnHandler(_)) {
                    initial_puzzle_args.game_move.basic.mover_share.clone()
                } else {
                    self.fixed.amount.clone()
                        - initial_puzzle_args.game_move.basic.mover_share.clone()
                },
            ),
            RefereeMakerGameState::AfterOurTurn {
                my_turn_result,
                spend_this_coin,
                ..
            } => (
                &my_turn_result.state,
                spend_this_coin.game_move.basic.move_made.clone(),
                spend_this_coin.game_move.basic.mover_share.clone(),
            ),
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_state_result,
                create_this_coin,
                ..
            } => (
                most_recent_our_state_result,
                create_this_coin.game_move.basic.move_made.clone(),
                self.fixed.amount.clone() - create_this_coin.game_move.basic.mover_share.clone(),
            ),
        };

        let result = if let Some(handler) = self.message_handler.as_ref() {
            let state_nodeptr = state.to_nodeptr(allocator)?;
            handler.run(
                allocator,
                &MessageInputs {
                    message: message.to_vec(),
                    amount: self.fixed.amount.clone(),
                    state: state_nodeptr,
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

    pub fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )
    }

    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )
    }

    pub fn on_chain_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    pub fn outcome_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    // Ensure this returns
    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        always_produce_transaction: bool,
        puzzle: Puzzle,
        targs: &RefereePuzzleArgs,
        args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let our_move = self.is_my_turn();

        let my_mover_share = if our_move {
            targs.game_move.basic.mover_share.clone()
        } else {
            self.fixed.amount.clone() - targs.game_move.basic.mover_share.clone()
        };

        if always_produce_transaction || my_mover_share != Amount::default() {
            let signature = args.get_signature().unwrap_or_default();

            // The transaction solution is not the same as the solution for the
            // inner puzzle as we take additional move or slash data.
            //
            // OnChainRefereeSolution encodes this properly.
            let transaction_solution = args.to_clvm(allocator).into_gen()?;
            debug!("transaction solution inputs {args:?}");
            let transaction_bundle = Spend {
                puzzle: puzzle.clone(),
                solution: Program::from_nodeptr(allocator, transaction_solution)?.into(),
                signature,
            };
            let output_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &puzzle.sha256tree(allocator),
                &my_mover_share,
            );
            return Ok(Some(RefereeOnChainTransaction {
                bundle: transaction_bundle,
                amount: self.fixed.amount.clone(),
                coin: output_coin_string,
            }));
        }

        // Zero mover share case.
        Ok(None)
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        debug!("get_transaction_for_timeout turn {}", self.is_my_turn());
        debug!(
            "mover share at start of action   {:?}",
            self.args_for_this_coin().game_move.basic.mover_share
        );
        debug!(
            "mover share at end   of action   {:?}",
            self.spend_this_coin().game_move.basic.mover_share
        );

        let targs = self.spend_this_coin();
        let puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &targs,
        )?;

        self.get_transaction(
            allocator,
            coin_string,
            false,
            puzzle,
            &targs,
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
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // We can only do a move to replicate our turn.
        assert!(self.processing_my_turn());
        let args = self.spend_this_coin();
        let spend_puzzle = self.on_chain_referee_puzzle(allocator)?;

        let prog = ValidationProgram::new(allocator, Rc::new(Program::from_bytes(&[0x80])));
        debug!(
            "referee maker: get transaction for move {:?}",
            GameStartInfo {
                game_handler: self.get_game_handler(),
                game_id: GameID::default(),
                amount: self.get_amount(),
                initial_state: self.get_game_state().clone().into(),
                initial_max_move_size: args.game_move.basic.max_move_size,
                initial_move: args.game_move.basic.move_made.clone(),
                initial_mover_share: args.game_move.basic.mover_share.clone(),
                my_contribution_this_game: Amount::default(),
                their_contribution_this_game: Amount::default(),
                initial_validation_program: prog,
                timeout: self.fixed.timeout.clone(),
            }
        );

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
        let args = self.args_for_this_coin();

        debug!("transaction for move: state {:?}", self.state);
        debug!("get_transaction_for_move: source curry {args:?}");
        let target_args = self.spend_this_coin();
        debug!("get_transaction_for_move: target curry {target_args:?}");
        assert_ne!(
            target_args.mover_puzzle_hash,
            self.fixed.my_identity.puzzle_hash
        );
        assert_ne!(args.mover_puzzle_hash, target_args.mover_puzzle_hash);
        assert_eq!(args.mover_puzzle_hash, target_args.waiter_puzzle_hash);
        assert!(matches!(
            self.state.borrow(),
            RefereeMakerGameState::AfterOurTurn { .. }
        ));
        assert!(matches!(
            self.get_game_handler(),
            GameHandler::TheirTurnHandler(_)
        ));

        if let Some((_, ph, _)) = coin_string.to_parts() {
            if on_chain {
                let start_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &args,
                )?;
                let end_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &target_args,
                )?;
                debug!("spend puzzle hash {ph:?}");
                debug!("this coin start {start_ph:?}");
                debug!("this coin end   {end_ph:?}");
                // assert_eq!(ph, start_ph);
            }
        }

        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            target_args.previous_validation_info_hash.as_ref()
        );
        debug!(
            "transaction for move: from {:?} to {target_args:?}",
            self.args_for_this_coin()
        );
        let target_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &target_args,
        )?;
        let target_referee_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &target_args,
        )?;
        assert_eq!(
            target_referee_puzzle.sha256tree(allocator),
            target_referee_puzzle_hash
        );

        let inner_conditions = [(
            CREATE_COIN,
            (
                target_referee_puzzle_hash.clone(),
                (self.fixed.amount.clone(), ()),
            ),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        // Generalize this once the test is working.  Move out the assumption that
        // referee private key is my_identity.synthetic_private_key.
        debug!("referee spend with parent coin {coin_string:?}");
        debug!(
            "signing coin with synthetic public key {:?} for public key {:?}",
            self.fixed.my_identity.synthetic_public_key, self.fixed.my_identity.public_key
        );
        let referee_spend = standard_solution_partial(
            allocator,
            &self.fixed.my_identity.synthetic_private_key,
            &coin_string.to_coin_id(),
            inner_conditions,
            &self.fixed.my_identity.synthetic_public_key,
            &self.fixed.agg_sig_me_additional_data,
            false,
        )?;

        let args_list = OnChainRefereeSolution::Move(OnChainRefereeMove {
            details: target_args.game_move.clone(),
            mover_coin: IdentityCoinAndSolution {
                mover_coin_puzzle: self.fixed.my_identity.puzzle.clone(),
                mover_coin_spend_solution: referee_spend.solution.p(),
                mover_coin_spend_signature: referee_spend.signature.clone(),
            },
        });

        if let Some(transaction) = self.get_transaction(
            allocator,
            coin_string,
            true,
            spend_puzzle,
            &target_args,
            &args_list,
        )? {
            Ok(transaction)
        } else {
            // Return err
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }

    pub fn run_validator_for_their_move(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
    ) -> Result<ValidatorResult, Error> {
        let previous_puzzle_args = self.args_for_this_coin();
        let puzzle_args = self.spend_this_coin();
        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        let validator_move_args = InternalValidatorArgs {
            move_made: puzzle_args.game_move.basic.move_made.clone(),
            new_validation_info_hash: puzzle_args.game_move.validation_info_hash.clone(),
            mover_share: puzzle_args.game_move.basic.mover_share.clone(),
            previous_validation_info_hash: previous_puzzle_args
                .game_move
                .validation_info_hash
                .clone(),
            mover_puzzle_hash: puzzle_args.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: puzzle_args.waiter_puzzle_hash.clone(),
            amount: self.fixed.amount.clone(),
            timeout: self.fixed.timeout.clone(),
            max_move_size: puzzle_args.game_move.basic.max_move_size,
            referee_hash: new_puzzle_hash.clone(),
            move_args: ValidatorMoveArgs {
                evidence: Rc::new(Program::from_nodeptr(allocator, evidence)?),
                state: self.get_game_state(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };

        debug!("getting validation program");
        debug!("my turn {}", self.is_my_turn());
        debug!("state {:?}", self.state);
        debug!(
            "last stored {:?}",
            self.old_states[self.old_states.len() - 1]
        );
        let (_state, validation_program) = self.get_validation_program_for_their_move()?;
        debug!("validation_program {validation_program:?}");
        let validation_program_mod_hash = validation_program.hash();
        debug!("validation_program_mod_hash {validation_program_mod_hash:?}");
        let validation_program_nodeptr = validation_program.to_nodeptr(allocator)?;

        let validator_full_args_node = validator_move_args.to_nodeptr(
            allocator,
            validation_program_nodeptr,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;

        debug!("validator program {:?}", validation_program);
        debug!("validator args {:?}", validator_full_args);

        // Error means validation should not work.
        // It should be handled later.
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            0,
        );

        Ok(match result {
            Ok(res) => ValidatorResult::Slash(res.1),
            Err(_) => ValidatorResult::MoveOk,
        })
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        debug!("do their turn {details:?}");

        let original_state = self.state.clone();
        let handler = self.get_game_handler();
        let last_state = self.get_game_state();
        let args = self.spend_this_coin();

        // Retrieve evidence from their turn handler.
        let state_nodeptr = last_state.to_nodeptr(allocator)?;
        assert!(
            args.game_move.basic.move_made.len()
                <= self.args_for_this_coin().game_move.basic.max_move_size
        );
        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.fixed.amount.clone(),
                last_state: state_nodeptr,

                last_move: &args.game_move.basic.move_made,
                last_mover_share: args.game_move.basic.mover_share.clone(),

                new_move: details.clone(),

                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?;

        let (handler, move_data) = match &result {
            TheirTurnResult::FinalMove(move_data) => (None, move_data.clone()),
            TheirTurnResult::MakeMove(handler, _, move_data) => {
                (Some(handler.clone()), move_data.clone())
            }

            // Slash can't be used when we're off chain.
            TheirTurnResult::Slash(_evidence) => {
                return Ok(TheirTurnMoveResult {
                    puzzle_hash_for_unroll: None,
                    original: result.clone(),
                })
            }
        };

        let puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &details.basic,
            Some(&args.game_move.validation_info_hash),
            &details.validation_info_hash,
            Some(&move_data.mover_share),
            true,
        ));

        self.accept_their_move(
            allocator,
            handler,
            args.clone(),
            puzzle_args.clone(),
            details,
            state_number,
        )?;

        // If specified, check for slash.
        if let Some(coin_string) = coin {
            for evidence in move_data.slash_evidence.iter() {
                debug!("calling slash for given evidence");
                if self
                    .check_their_turn_for_slash(allocator, *evidence, coin_string)?
                    .is_some()
                {
                    // Slash isn't allowed in off chain, we'll go on chain via error.
                    debug!("slash was allowed");
                    self.state = original_state;
                    return Err(Error::StrErr("slashable when off chain".to_string()));
                }
            }
        }

        let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;
        debug!(
            "new_curried_referee_puzzle_hash (their turn): {:?}",
            puzzle_hash_for_unroll
        );

        // Coin calculated off the new new state.
        Ok(TheirTurnMoveResult {
            puzzle_hash_for_unroll: Some(puzzle_hash_for_unroll),
            original: result,
        })
    }

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.fixed.my_identity.puzzle_hash.clone()
    }

    fn slashing_coin_solution(
        &self,
        allocator: &mut AllocEncoder,
        state: NodePtr,
        my_validation_info_hash: PuzzleHash,
        validation_program_clvm: NodePtr,
        slash_solution: NodePtr,
        evidence: Evidence,
    ) -> Result<NodePtr, Error> {
        (
            Node(state),
            (
                my_validation_info_hash,
                (
                    Node(validation_program_clvm),
                    (
                        RcNode::new(self.fixed.my_identity.puzzle.to_program()),
                        (Node(slash_solution), (Node(evidence.to_nodeptr()), ())),
                    ),
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
        new_puzzle: Puzzle,
        new_puzzle_hash: &PuzzleHash,
        slash_spend: &BrokenOutCoinSpendInfo,
        evidence: Evidence,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Probably readable_info overlaps solution.
        // Moving driver in that context is the signature.
        // My reward coin string is the coin that we'll make
        // after the transaction below has been spent so its
        // parent is the coin id of that coin.
        let current_mover_share = self.get_our_current_share();

        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let reward_amount = self.fixed.amount.clone() - current_mover_share;
        if reward_amount == Amount::default() {
            return Ok(TheirTurnCoinSpentResult::Slash(Box::new(
                SlashOutcome::NoReward,
            )));
        }

        let state_nodeptr = state.to_nodeptr(allocator)?;
        let validation_program_node = validation_program.to_nodeptr(allocator)?;
        let validation_program_hash = validation_program.sha256tree(allocator);
        let solution_nodeptr = slash_spend.solution.to_nodeptr(allocator)?;
        let slashing_coin_solution = self.slashing_coin_solution(
            allocator,
            state_nodeptr,
            validation_program_hash,
            validation_program_node,
            solution_nodeptr,
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
                        solution: Program::from_nodeptr(allocator, slashing_coin_solution)?.into(),
                        signature: slash_spend.signature.clone(),
                    },
                }),
                my_reward_coin_string: coin_string_of_output_coin,
            },
        )))
    }

    fn make_slash_conditions(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        [(
            CREATE_COIN,
            (
                self.target_puzzle_hash_for_slash(),
                (self.fixed.amount.clone(), ()),
            ),
        )]
        .to_clvm(allocator)
        .into_gen()
    }

    fn make_slash_spend(
        &self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!("slash spend: parent coin is {coin_id:?}");
        let slash_conditions = self.make_slash_conditions(allocator)?;
        standard_solution_partial(
            allocator,
            &self.fixed.my_identity.synthetic_private_key,
            &coin_id.to_coin_id(),
            slash_conditions,
            &self.fixed.my_identity.synthetic_public_key,
            &self.fixed.agg_sig_me_additional_data,
            false,
        )
    }

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        let puzzle_args = self.spend_this_coin();
        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;
        // my_inner_solution maker is just in charge of making aggsigs from
        // conditions.
        debug!("run validator for their move");
        let full_slash_result = self.run_validator_for_their_move(allocator, evidence)?;
        match full_slash_result {
            ValidatorResult::Slash(_slash) => {
                // result is NodePtr containing solution and aggsig.
                // The aggsig for the nil slash is the same as the slash
                // below, having been created for the reward coin by using
                // the standard solution signer.
                let slash_spend = self.make_slash_spend(allocator, coin_string)?;
                self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    Evidence::from_nodeptr(evidence),
                )
                .map(Some)
            }
            ValidatorResult::MoveOk => Ok(None),
        }
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        let after_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &self.spend_this_coin(),
        )?;

        // XXX Revisit this in conjuction with rewind.  There is a better way to do this.
        let repeat = if let Some(CoinCondition::CreateCoin(ph, _amt)) = conditions
            .iter()
            .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
        {
            after_puzzle_hash == *ph
        } else {
            false
        };
        let created_coin = if let Some((ph, amt)) = conditions
            .iter()
            .filter_map(|cond| {
                if let CoinCondition::CreateCoin(ph, amt) = cond {
                    Some((ph, amt))
                } else {
                    None
                }
            })
            .next()
        {
            CoinString::from_parts(&coin_string.to_coin_id(), ph, amt)
        } else {
            return Err(Error::StrErr("no coin created".to_string()));
        };

        debug!("rems in spend {conditions:?}");

        if repeat {
            let nil = allocator.allocator().nil();
            debug!("repeat: current state {:?}", self.state);

            if self.is_my_turn() {
                if let Some(result) =
                    self.check_their_turn_for_slash(allocator, nil, &created_coin)?
                {
                    // A repeat means that we tried a move but went on chain.
                    // if the move is slashable, then we should do that here.
                    return Ok(result);
                }
            }

            return Ok(TheirTurnCoinSpentResult::Moved {
                new_coin_string: CoinString::from_parts(
                    &coin_string.to_coin_id(),
                    &after_puzzle_hash,
                    &self.fixed.amount,
                ),
                readable: ReadableMove::from_nodeptr(allocator, nil)?,
                mover_share: self.spend_this_coin().game_move.basic.mover_share.clone(),
            });
        }

        // Read parameters off conditions
        let rem_condition = if let Some(CoinCondition::Rem(rem_condition)) = conditions
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
            let my_reward_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &self.fixed.my_identity.puzzle_hash,
                &mover_share,
            );

            debug!("game coin timed out: conditions {conditions:?}");
            return Ok(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string: Some(my_reward_coin_string),
            });
        }

        if rem_condition.len() != REM_CONDITION_FIELDS {
            return Err(Error::StrErr(
                "rem condition should have the right number of fields".to_string(),
            ));
        }

        let new_move = &rem_condition[0];
        let validation_info_hash = Hash::from_slice(&rem_condition[1]);
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

        let details = GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: new_move.clone(),
                max_move_size: new_max_move_size,
                mover_share: new_mover_share.clone(),
            },
            validation_info_hash,
        };

        let result = self.their_turn_move_off_chain(allocator, &details, state_number, None)?;

        let args = self.spend_this_coin();

        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )?;
        let new_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
        debug!("THEIR TURN MOVE OFF CHAIN SUCCEEDED {new_puzzle_hash:?}");

        let check_and_report_slash =
            |allocator: &mut AllocEncoder, move_data: &TheirTurnMoveData| {
                for evidence in move_data.slash_evidence.iter() {
                    debug!("check their turn for slash");
                    if let Some(result) =
                        self.check_their_turn_for_slash(allocator, *evidence, &created_coin)?
                    {
                        return Ok(result);
                    }
                }

                Ok(TheirTurnCoinSpentResult::Moved {
                    new_coin_string: CoinString::from_parts(
                        &coin_string.to_coin_id(),
                        &new_puzzle_hash,
                        &self.fixed.amount,
                    ),
                    readable: ReadableMove::from_nodeptr(allocator, move_data.readable_move)?,
                    mover_share: args.game_move.basic.mover_share.clone(),
                })
            };

        debug!("referee move details {details:?}");
        match result.original {
            TheirTurnResult::Slash(evidence) => {
                let slash_spend = self.make_slash_spend(allocator, coin_string)?;
                self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    evidence,
                )
            }
            TheirTurnResult::FinalMove(move_data) => check_and_report_slash(allocator, &move_data),
            TheirTurnResult::MakeMove(_, _, move_data) => {
                check_and_report_slash(allocator, &move_data)
            }
        }
    }
}
