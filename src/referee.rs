use clvm_traits::{clvm_curried_args, ToClvm, ClvmEncoder, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use rand::Rng;

use crate::channel_handler::game_handler::{
    chia_dialect, GameHandler, MessageHandler, MessageInputs, MyTurnInputs, TheirTurnInputs,
    TheirTurnResult,
};
use crate::channel_handler::types::{GameStartInfo, ReadableMove, ReadableUX, Evidence, ValidationProgram, ValidationInfo};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    curry_and_treehash, puzzle_for_pk, calculate_hash_of_quoted_mod_hash,
    standard_solution_unsafe, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    u64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount, CoinCondition, CoinString, Error,
    Hash, IntoErr, Node, Puzzle, PuzzleHash, Sha256tree,
    SpecificTransactionBundle, Timeout, TransactionBundle, Program
};

pub const REM_CONDITION_FIELDS: usize = 4;

#[derive(Debug, Clone)]
pub struct GameMoveDetails {
    pub move_made: Vec<u8>,
    /// sha256 of the concatenation of two hashes:
    /// 1 - The next game handler program
    /// 2 - The game state.
    pub validation_info_hash: Hash,
    pub max_move_size: usize,
    pub mover_share: Amount,
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
        transaction: SpecificTransactionBundle,
        my_reward_coin_string: CoinString,
    },
}

#[derive(Debug, Clone)]
pub struct RefereeOnChainTransaction {
    pub bundle: TransactionBundle,
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
    Slash(SlashOutcome),
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
    referee_coin_puzzle_hash: PuzzleHash,
    nonce: usize,
    game_move: GameMoveDetails,
    previous_validation_info_hash: Hash,
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
            allocator.encode_atom(&self.game_move.move_made).into_gen()?,
            self.game_move.max_move_size.to_clvm(allocator).into_gen()?,
            self.game_move.validation_info_hash.to_clvm(allocator).into_gen()?,
            self.game_move.mover_share.to_clvm(allocator).into_gen()?,
            self.previous_validation_info_hash
                .to_clvm(allocator)
                .into_gen()?,
        ]
        .into_iter()
        .map(|n| Node(n))
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
    eprintln!(
        "curry_referee_puzzle_hash {}",
        disassemble(allocator.allocator(), combined_args, None)
    );
    assert_ne!(args.previous_validation_info_hash, Hash::default());
    Ok(curry_and_treehash(
        &PuzzleHash::from_hash(calculate_hash_of_quoted_mod_hash(referee_coin_puzzle_hash)),
        &[arg_hash]
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
    eprintln!(
        "curry_referee_puzzle {}",
        disassemble(allocator.allocator(), combined_args, None)
    );
    assert_ne!(args.previous_validation_info_hash, Hash::default());
    Ok(Puzzle::from_nodeptr(CurriedProgram {
        program: referee_coin_puzzle,
        args: clvm_curried_args!(Node(combined_args)),
    }.to_clvm(allocator).into_gen()?))
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
    pub solution: NodePtr
}

impl ValidatorMoveArgs {
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder
    ) -> Result<NodePtr, Error> {
        let args: &[NodePtr] = &[
            allocator.encode_atom(&self.game_move.move_made).into_gen()?,
            self.game_move.validation_info_hash.to_clvm(allocator).into_gen()?,
            self.game_move.mover_share.to_clvm(allocator).into_gen()?,
            self.game_move.max_move_size.to_clvm(allocator).into_gen()?,
            self.mover_puzzle.to_clvm(allocator).into_gen()?,
            self.solution
        ];
        let argvec: Vec<Node> = args.into_iter().map(|v| Node(*v)).collect();
        argvec.to_clvm(allocator).into_gen()
    }
}

pub enum Validation {
    ValidationByState(ValidationInfo),
    ValidationByStateHash(Hash)
}

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
struct RefereeMakerGameState {
    pub state: NodePtr,
    pub validation_program: ValidationProgram,
    pub game_handler: GameHandler,

    // Details of the move that triggered this state change
    pub game_move: GameMoveDetails,

    pub previous_state: NodePtr,
    pub previous_validation_program_hash: Hash,
}

/// A puzzle for a coin that will be run inside the referee to generate
/// conditions that are acted on to spend the referee coin.
/// The referee knows the mover puzzle hash, so we've already decided what
/// puzzle this is.  It is usually the standard coin puzzle from the user's
/// ChiaIdentity.
///
/// This groups that with the solution.
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
pub struct OnChainRefereeMove {
    /// From the wire protocol.
    pub details: GameMoveDetails,
    /// Coin puzzle and solution that are used to generate conditions for the
    /// next generation of the on chain refere coin.
    pub mover_coin: IdentityCoinAndSolution,
}

/// Dynamic arguments passed to the on chain refere to apply a slash
pub struct OnChainRefereeSlash {
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
pub enum OnChainRefereeSolution {
    Timeout,
    Move(OnChainRefereeMove),
    Slash(OnChainRefereeSlash)
}

impl OnChainRefereeSolution {
    // Get the standard solution for these referee arguments.
    // We will sign it with the synthetic private key if it exists.
    fn get_signature(
        &self,
    ) -> Option<Aggsig> {
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
                (Node(encoder.encode_atom(&refmove.details.move_made)?),
                 (refmove.details.validation_info_hash.clone(),
                  (refmove.details.mover_share.clone(),
                   (refmove.details.max_move_size,
                    (refmove.mover_coin.mover_coin_puzzle.clone(),
                     (Node(refmove.mover_coin.mover_coin_spend_solution.clone()), ())
                    )
                   )
                  )
                 )
                ).to_clvm(encoder)
            }
            OnChainRefereeSolution::Slash(refslash) => {
                (Node(refslash.previous_validation_info.game_state()),
                 (refslash.previous_validation_info.hash(),
                  (refslash.mover_coin.mover_coin_puzzle.clone(),
                   (Node(refslash.mover_coin.mover_coin_spend_solution),
                    (refslash.slash_evidence.clone(), ())
                   )
                  )
                 )
                ).to_clvm(encoder)
            }
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

    states: [RefereeMakerGameState; 2],
    pub is_my_turn: bool,

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
    ) -> Result<Self, Error> {
        let initial_validation_info = ValidationInfo::new(
            allocator,
            game_start_info.initial_validation_program.clone(),
            game_start_info.initial_state
        );
        let state = RefereeMakerGameState {
            state: game_start_info.initial_state,
            validation_program: game_start_info.initial_validation_program.clone(),
            previous_state: game_start_info.initial_state,
            previous_validation_program_hash: game_start_info.initial_validation_program.hash().clone(),
            game_handler: game_start_info.game_handler.clone(),
            game_move: GameMoveDetails {
                validation_info_hash: initial_validation_info.hash().clone(),
                move_made: Vec::default(),
                max_move_size: game_start_info.initial_max_move_size,
                mover_share: game_start_info.initial_mover_share.clone(),
            }
        };

        Ok(RefereeMaker {
            referee_coin_puzzle,
            referee_coin_puzzle_hash,

            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_identity,
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce,

            states: [state.clone(), state],
            is_my_turn: game_start_info.game_handler.is_my_turn(),
            message_handler: None,
            #[cfg(test)]
            run_debug: false,
        })
    }

    #[cfg(test)]
    pub fn enable_debug_run(&mut self, ena: bool) {
        self.run_debug = ena;
    }

    fn current_state_mut(&mut self) -> &mut RefereeMakerGameState {
        &mut self.states[self.is_my_turn as usize]
    }

    fn current_state(&self) -> &RefereeMakerGameState {
        &self.states[self.is_my_turn as usize]
    }

    fn previous_state_mut(&mut self) -> &mut RefereeMakerGameState {
        &mut self.states[(!self.is_my_turn) as usize]
    }

    fn previous_state(&self) -> &RefereeMakerGameState {
        &self.states[(!self.is_my_turn) as usize]
    }

    pub fn previous_validation_info_hash(
        &self,
        allocator: &mut AllocEncoder
    ) -> Hash {
        ValidationInfo::new(
            allocator,
            ValidationProgram::new_hash(self.current_state().previous_validation_program_hash.clone()),
            self.current_state().previous_state
        ).hash().clone()
    }

    pub fn get_validation_program_clvm(
        &self,
        previous: bool
    ) -> Result<NodePtr, Error> {
        let validation_program =
            if previous {
                &self.previous_state().validation_program
            } else {
                &self.current_state().validation_program
            };
        if let Some(vpc) = validation_program.to_nodeptr() {
            Ok(vpc)
        } else {
            Err(Error::StrErr("no active validation program (their turn?)".to_string()))
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        self.states[(self.is_my_turn) as usize].game_move.mover_share.clone()
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.states[(!self.is_my_turn) as usize].game_move.mover_share.clone()
    }

    pub fn get_current_puzzle(&self) -> Puzzle {
        todo!()
    }

    pub fn get_current_puzzle_hash(&self) -> PuzzleHash {
        self.my_identity.puzzle_hash.clone()
    }

    pub fn accept_this_move(
        &mut self,
        game_handler: &GameHandler,
        validation_program: &ValidationProgram,
        state: NodePtr,
        details: &GameMoveDetails,
    ) {
        eprintln!("accept move {details:?}");
        let (prior_validation_program_hash, prior_state) = {
            let current_state = self.current_state();
            (
                current_state.validation_program.hash().clone(),
                current_state.state.clone(),
            )
        };

        self.is_my_turn = !self.is_my_turn;
        let current_state = self.current_state_mut();

        // Copy over essential previous items.
        current_state.previous_validation_program_hash = prior_validation_program_hash;
        current_state.previous_state = prior_state;

        // Update to the new state.
        current_state.game_handler = game_handler.clone();

        current_state.validation_program = validation_program.clone();
        current_state.state = state.clone();

        current_state.game_move = details.clone();
        assert_ne!(current_state.previous_validation_program_hash, Hash::default());
        eprintln!("current_state {current_state:?}");
    }

    pub fn my_turn_make_move<R: Rng>(
        &mut self,
        rng: &mut R,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
    ) -> Result<GameMoveWireData, Error> {
        let new_entropy: Hash = rng.gen();
        let game_handler = {
            let current_state = self.current_state();
            current_state.game_handler.clone()
        };
        let (state, move_data, mover_share) = {
            let previous_state = self.previous_state();
            (
                previous_state.state.clone(),
                previous_state.game_move.move_made.clone(),
                previous_state.game_move.mover_share.clone(),
            )
        };
        let result = game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.amount.clone(),
                last_state: state,
                last_move: &move_data,
                last_mover_share: mover_share,
                entropy: new_entropy,
                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?;

        eprintln!("my turn result {result:?}");

        self.accept_this_move(
            &result.waiting_driver,
            &result.validation_program,
            result.state.clone(),
            &result.game_move,
        );

        self.message_handler = result.message_parser;

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        let game_move = self.current_state().game_move.clone();
        let previous_validation_info_hash = self.previous_validation_info_hash(
            allocator
        );
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &RefereePuzzleArgs {
                mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
                timeout: self.timeout.clone(),
                amount: self.amount.clone(),
                nonce: self.nonce,
                referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                game_move,
                previous_validation_info_hash,
            },
        )?;

        Ok(GameMoveWireData {
            puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
            details: result.game_move.clone(),
        })
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableUX, Error> {
        // Do stuff with message handler.
        let (state, move_data, mover_share) = {
            let current_state = self.current_state();
            (
                current_state.state,
                current_state.game_move.move_made.clone(),
                current_state.game_move.mover_share.clone(),
            )
        };
        let result = if let Some(handler) = self.message_handler.as_ref() {
            handler.run(
                allocator,
                &MessageInputs {
                    message: message.to_vec(),
                    amount: self.amount.clone(),
                    state: state.clone(),
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

    fn curried_referee_args_for_validator(
        &self,
        previous: bool
    ) -> RefereePuzzleArgs {
        let current_state =
            if previous {
                self.previous_state()
            } else {
                self.current_state()
            };
        let my_turn =
            matches!(current_state.game_handler, GameHandler::MyTurnHandler(_));
        let mover_puzzle_hash = if my_turn {
            self.my_identity.puzzle_hash.clone()
        } else {
            self.their_referee_puzzle_hash.clone()
        };
        let waiter_puzzle_hash = if my_turn {
            self.their_referee_puzzle_hash.clone()
        } else {
            self.my_identity.puzzle_hash.clone()
        };
        RefereePuzzleArgs {
            mover_puzzle_hash,
            waiter_puzzle_hash,
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
            nonce: self.nonce,
            game_move: current_state.game_move.clone(),
            previous_validation_info_hash: current_state
                .previous_validation_program_hash
                .clone(),
        }
    }

    pub fn curried_referee_puzzle_hash_for_validator(
        &self,
        allocator: &mut AllocEncoder,
        previous: bool
    ) -> Result<PuzzleHash, Error> {
        let args = self.curried_referee_args_for_validator(previous);
        curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &args
        )
    }

    pub fn curried_referee_puzzle_for_validator(
        &self,
        allocator: &mut AllocEncoder,
        previous: bool
    ) -> Result<Puzzle, Error> {
        let args = self.curried_referee_args_for_validator(previous);
        curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &args
        )
    }

    // Ensure this returns
    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        puzzle: &Puzzle,
        always_produce_transaction: bool,
        previous_state: bool,
        args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let amount = self.amount.clone();
        let use_state = if previous_state {
            self.previous_state()
        } else {
            self.current_state()
        };

        let my_mover_share =
            (|use_state: &RefereeMakerGameState| {
                match &use_state.game_handler {
                    GameHandler::MyTurnHandler(_h) => {
                        // It was my turn
                        if use_state.game_move.mover_share != amount {
                            // And we have a mover share.
                            return amount - use_state.game_move.mover_share.clone();
                        }

                        Amount::default()
                    }
                    GameHandler::TheirTurnHandler(_h) => {
                        // It was their turn
                        if use_state.game_move.mover_share != Amount::default() {
                            // There is some left over.
                            return use_state.game_move.mover_share.clone();
                        }

                        Amount::default()
                    }
                }
            })(use_state);

        if always_produce_transaction || my_mover_share != Amount::default() {
            let signature =
                if let Some(sig) = args.get_signature() {
                    sig
                } else {
                    Aggsig::default()
                };

            // The transaction solution is not the same as the solution for the
            // inner puzzle as we take additional move or slash data.
            //
            // OnChainRefereeSolution encodes this properly.
            let transaction_solution = args.to_clvm(allocator).into_gen()?;
            eprintln!(
                "transaction_solution {}",
                disassemble(allocator.allocator(), transaction_solution, None)
            );
            let transaction_bundle = TransactionBundle {
                puzzle: puzzle.clone(),
                solution: transaction_solution,
                signature,
            };
            let output_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &puzzle.sha256tree(allocator),
                &my_mover_share,
            );
            return Ok(Some(RefereeOnChainTransaction {
                bundle: transaction_bundle,
                reward_coin: output_coin_string
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
        let spend_puzzle = self.curried_referee_puzzle_for_validator(
            allocator,
            false
        )?;
        self.get_transaction(
            allocator,
            coin_string,
            &spend_puzzle,
            false,
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
        // Get the puzzle hash for the next referee state.
        // This reflects a "their turn" state with the updated state from the
        // game handler returned by consuming our move.  This is assumed to
        // have been done by consuming the move in a different method call.
        eprintln!("get_transaction_for_move: target curry");
        let validation_info_hash =
            ValidationInfo::new_from_validation_program_hash_and_state(
                allocator,
                ValidationProgram::new_hash(self.current_state().previous_validation_program_hash.clone()).hash().clone(),
                self.current_state().state,
            );
        let target_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
            game_move: self.current_state().game_move.clone(),
            nonce: self.nonce,
            previous_validation_info_hash: validation_info_hash.hash().clone()
        };
        let target_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &target_args
        )?;
        let target_referee_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &target_args
        )?;
        eprintln!(
            "target_referee_puzzle {}",
            disassemble(allocator.allocator(), target_referee_puzzle.to_nodeptr(), None)
        );
        assert_eq!(
            target_referee_puzzle.sha256tree(allocator),
            target_referee_puzzle_hash
        );

        // Get the current state of the referee on chain.  This reflects the
        // current state at the time the move was made.
        let previous_state = self.previous_state();
        // The current referee uses the previous state since we have already
        // taken the move.
        eprintln!("get_transaction_for_move: previous curry");
        assert_eq!(
            self.previous_validation_info_hash(allocator),
            self.previous_state().game_move.validation_info_hash
        );
        let existing_curry_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
            game_move: self.previous_state().game_move.clone(),
            nonce: self.nonce,
            previous_validation_info_hash: self.previous_validation_info_hash(
                allocator
            ),
        };
        let current_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &existing_curry_args,
        )?;
        eprintln!("actual puzzle reveal");
        let spend_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &existing_curry_args,
        )?;
        assert_eq!(
            spend_puzzle.sha256tree(allocator),
            current_referee_puzzle_hash
        );

        let inner_conditions = [
            (CREATE_COIN, (target_referee_puzzle_hash.clone(), (self.amount.clone(), ())))
        ].to_clvm(allocator).into_gen()?;

        // Generalize this once the test is working.  Move out the assumption that
        // referee private key is my_identity.synthetic_private_key.
        let (solution, sig) =
            standard_solution_partial(
                allocator,
                &self.my_identity.synthetic_private_key,
                &coin_string.to_coin_id(),
                inner_conditions,
                &self.my_identity.synthetic_public_key,
                agg_sig_me_additional_data,
                false
            )?;

        let args_list = OnChainRefereeSolution::Move(OnChainRefereeMove {
            details: previous_state.game_move.clone(),
            mover_coin: IdentityCoinAndSolution {
                mover_coin_puzzle: self.my_identity.puzzle.clone(),
                mover_coin_spend_solution: solution,
                mover_coin_spend_signature: sig
            }
        });

        if let Some(transaction) = self.get_transaction(
            allocator,
            coin_string,
            &spend_puzzle,
            true,
            true,
            &args_list,
        )? {
            Ok(transaction)
        } else {
                // Return err
            Err(Error::StrErr("no transaction returned when doing on chain move".to_string()))
        }
    }

    pub fn get_my_share(&self) -> Amount {
        let current_state = self.current_state();
        match &current_state.game_handler {
            GameHandler::MyTurnHandler(_) => current_state.game_move.mover_share.clone(),
            GameHandler::TheirTurnHandler(_) => {
                self.amount.clone() - current_state.game_move.mover_share.clone()
            }
        }
    }

    fn update_for_their_turn_move(
        &mut self,
        handler: GameHandler,
        details: &GameMoveDetails,
    ) -> Result<(), Error> {
        let previous_state = self.current_state().state.clone();
        let previous_validation_info_hash = self.current_state().game_move.validation_info_hash.clone();

        // Update the turn
        self.is_my_turn = !self.is_my_turn;

        let current_state = self.current_state_mut();

        current_state.previous_state = previous_state;
        current_state.previous_validation_program_hash = previous_validation_info_hash;
        current_state.game_move = details.clone();
        current_state.game_handler = handler;

        Ok(())
    }

    pub fn run_validator_for_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        validator_move_args: &ValidatorMoveArgs
    ) -> Result<(), Error> {
        let validation_program_clvm = self.get_validation_program_clvm(false)?;
        let validator_move_converted = validator_move_args.to_nodeptr(allocator)?;
        // Error means validation should not work.
        // It should be handled later.
        run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_clvm,
            validator_move_converted,
            0
        ).into_gen()?;
        Ok(())
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
    ) -> Result<TheirTurnMoveResult, Error> {
        let (
            handler,
            last_state,
            last_move,
            previous_validation_program_hash,
        ) = {
            let current_state = self.current_state();
            (
                current_state.game_handler.clone(),
                current_state.state.clone(),
                current_state.game_move.clone(),
                current_state.previous_validation_program_hash.clone(),
            )
        };

        // Retrieve evidence from their turn handler.
        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.amount.clone(),
                last_state,

                last_move: &last_move.move_made,
                last_mover_share: last_move.mover_share.clone(),

                new_move: details.clone(),

                #[cfg(test)]
                run_debug: self.run_debug,
            },
        )?;

        match result {
            TheirTurnResult::MakeMove(handler, readable_move, message) => {
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
                self.update_for_their_turn_move(
                    handler,
                    &details,
                )?;

                let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
                    allocator,
                    &self.referee_coin_puzzle_hash,
                    &RefereePuzzleArgs {
                        // XXX check polarity
                        mover_puzzle_hash: self.my_identity.puzzle_hash.clone(),
                        waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                        timeout: self.timeout.clone(),
                        amount: self.amount.clone(),
                        referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                        game_move: last_move.clone(),
                        nonce: self.nonce,

                        previous_validation_info_hash: previous_validation_program_hash.clone(),
                    },
                )?;

                // Coin calculated off the new new state.
                Ok(TheirTurnMoveResult {
                    puzzle_hash_for_unroll,
                    readable_move: readable_move.clone(),
                    message: message.clone(),
                })
            }
            // Slash can't be used when we're off chain.
            TheirTurnResult::Slash(_evidence, _signature) => {
                Err(Error::StrErr("slash when off chain".to_string()))
            }
        }
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
        evidence: Evidence
    ) -> Result<NodePtr, Error> {
        (
            Node(state.clone()),
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
        let (state, current_mover_share) = {
            let current_state = self.current_state();
            (
                current_state.state.clone(),
                current_state.game_move.mover_share.clone(),
            )
        };

        let validation_program_clvm = self.get_validation_program_clvm(true)?;
        let reward_amount = self.amount.clone() - current_mover_share;
        if reward_amount == Amount::default() {
            return Ok(TheirTurnCoinSpentResult::Slash(SlashOutcome::NoReward));
        }

        let slashing_coin_solution = self.slashing_coin_solution(
            allocator,
            state,
            validation_program_clvm,
            slash_solution,
            evidence
        )?;

        let coin_string_of_output_coin =
            CoinString::from_parts(&coin_string.to_coin_id(), &new_puzzle_hash, &reward_amount);

        Ok(TheirTurnCoinSpentResult::Slash(SlashOutcome::Reward {
            transaction: SpecificTransactionBundle {
                // Ultimate parent of these coins.
                coin: coin_string.clone(),
                bundle: TransactionBundle {
                    puzzle: new_puzzle.clone(),
                    solution: slashing_coin_solution,
                    signature: sig.clone(),
                },
            },
            my_reward_coin_string: coin_string_of_output_coin,
        }))
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
                .filter(|cond| matches!(cond, CoinCondition::Rem(_)))
                .next()
        {
            // Got rem condition
            rem_condition.to_vec()
        } else {
            Vec::default()
        };

        let mover_share = self.amount.clone() - self.current_state().game_move.mover_share.clone();

        // Check properties of conditions
        if rem_condition.is_empty() {
            // Timeout case
            // Return enum timeout and we give the coin string of our reward
            // coin if any.
            // Something went wrong if i think it's my turn
            debug_assert!(!self.is_my_turn);

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

        let previous_validation_info_hash = self
            .current_state()
            .previous_validation_program_hash
            .clone();
        let ref_puzzle_args = RefereePuzzleArgs {
            mover_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.my_identity.puzzle_hash.clone(),
            timeout: self.timeout.clone(),
            amount: self.amount.clone(),
            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
            nonce: self.nonce,
            game_move: GameMoveDetails {
                move_made: new_move.clone(),
                max_move_size: new_max_move_size,
                validation_info_hash: new_validation_info_hash.clone(),
                mover_share: new_mover_share.clone(),
            },
            previous_validation_info_hash,
        };
        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.referee_coin_puzzle,
            &self.referee_coin_puzzle_hash,
            &ref_puzzle_args,
        )?;
        let new_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.referee_coin_puzzle_hash, &ref_puzzle_args)?;

        let game_handler = self.current_state().game_handler.clone();

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

        let (slash_solution, slash_aggsig) =
            standard_solution_unsafe(
                allocator,
                &self.my_identity.private_key,
                slash_conditions
            )?;

        let state = self.current_state().state;
        let validation_program_clvm = self.get_validation_program_clvm(false)?;
        let full_slash_program = CurriedProgram {
            program: Node(validation_program_clvm),
            args: clvm_curried_args!(
                Node(state),
                Node(validation_program_clvm),
                my_inner_puzzle,
                Node(slash_solution),
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

        let (state, current_move_data, current_mover_share, validation_program) = {
            let current_state = self.current_state();
            (
                current_state.state.clone(),
                current_state.game_move.move_made.clone(),
                current_state.game_move.mover_share.clone(),
                current_state.validation_program.clone(),
            )
        };

        let full_slash_solution = (
            Node(state.clone()),
            (
                Node(validation_program_clvm),
                // No evidence here.
                (new_puzzle_hash.clone(), ((), (0, ()))),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        // Ultimately each of these cases returns some kind of
        // TheirTurnCoinSpentResult.
        let nil_evidence = Evidence::nil(allocator);
        match full_slash_result {
            Ok(_) => {
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
                    &slash_aggsig,
                )
            }
            Err(_) => {
                // Slash wasn't allowed.  Run the move handler.
                match game_handler.call_their_turn_driver(
                    allocator,
                    &TheirTurnInputs {
                        amount: self.amount.clone(),
                        last_state: state,
                        last_move: &current_move_data,
                        last_mover_share: current_mover_share,

                        new_move: GameMoveDetails {
                            move_made: new_move.clone(),
                            validation_info_hash: new_validation_info_hash.clone(),
                            max_move_size: new_max_move_size,
                            mover_share: new_mover_share.clone(),
                        },

                        #[cfg(test)]
                        run_debug: self.run_debug,
                    },
                )? {
                    TheirTurnResult::Slash(evidence, sig) => {
                        self.make_slash_for_their_turn(
                            allocator,
                            coin_string,
                            &new_puzzle,
                            &new_puzzle_hash,
                            full_slash_solution,
                            evidence,
                            &(slash_aggsig + sig),
                        )
                    }
                    TheirTurnResult::MakeMove(game_handler, readable_move, _message) => {
                        // Otherwise accept move by updating our state
                        self.accept_this_move(
                            &game_handler,
                            &validation_program,
                            state,
                            &GameMoveDetails {
                                move_made: new_move.clone(),
                                validation_info_hash: new_validation_info_hash.clone(),
                                max_move_size: new_max_move_size,
                                mover_share: new_mover_share.clone(),
                            }
                        );

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
    }
}
