use clvmr::allocator::NodePtr;
use clvm_traits::{ToClvm, clvm_curried_args};
use clvm_utils::CurriedProgram;
use rand::Rng;

use crate::common::types::{Aggsig, Amount, CoinString, PuzzleHash, Hash, Puzzle, Program, Timeout, PrivateKey, Error, AllocEncoder, Node, Sha256Input, IntoErr, Sha256tree, SpecificTransactionBundle};
use crate::common::types::TransactionBundle;
use crate::common::standard_coin::{curry_and_treehash, private_to_public_key, puzzle_hash_for_pk, sign_agg_sig_me, puzzle_for_pk};
use crate::channel_handler::types::{GameStartInfo, ReadableMove, ReadableUX};
use crate::channel_handler::game_handler::{GameHandler, MyTurnInputs, MyTurnResult, MessageInputs, MessageHandler};

pub struct RefereeMakerMoveResult {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub move_made: Vec<u8>,
    pub validation_info_hash: Hash,
    pub max_move_size: usize,
    pub mover_share: Amount
}

pub struct TheirTurnMoveResult {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub readable_move: NodePtr,
    pub message: NodePtr
}

pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: CoinString
    },
    Moved {
        new_coin_string: CoinString,
        readable: NodePtr
    },
    Slash {
        new_coin_string: CoinString,
        puzzle_reveal: Puzzle,
        solution: NodePtr,
        aggsig: Aggsig,
        my_reward_coin_string: CoinString
    }
}

// Adjudicates a two player turn based game
// MOVE, VALIDATION_HASH and MOVER_SHARE were all accepted optimistically from the last move
// Both VALIDATION_HASH values are a sha256 of a validation program hash and the shatree of a state
// The next validation program hash may be nil which means no futher moves are allowed
// MOVER_SHARE is how much the mover will get if they fold/accept
// MOD_HASH should be the shatree of referee itself
// NONCE is for anti-replay prevention
// If action is timeout args is nil
// If action is slash args is (state validation_program mover_puzzle solution evidence)
// If action is move args is (new_move new_validation_info_hash new_mover_share mover_puzzle solution)
// validation programs get passed this:
// ((last_move next_validation_hash my_share me_hash my_puzzle_hash opponent_puzzle_hash
//        amount timeout max_move_size referee_hash)
//        state me mover_puzzle solution evidence)
struct RefereePuzzleArgs<'a> {
    mover_puzzle_hash: PuzzleHash,
    waiter_puzzle_hash: PuzzleHash,
    timeout: Timeout,
    amount: Amount,
    referee_coin_puzzle_hash: PuzzleHash,
    move_data: &'a [u8],
    nonce: usize,
    max_move_size: usize,
    validation_info_hash: Hash,
    mover_share: Amount,
    previous_validation_info_hash: Hash,
}

fn curry_referee_puzzle_hash(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle_hash: &PuzzleHash,
    args: &RefereePuzzleArgs,
) -> Result<PuzzleHash, Error> {
    let args_to_curry: Vec<Node> = [
        args.mover_puzzle_hash.to_clvm(allocator).into_gen()?,
        args.waiter_puzzle_hash.to_clvm(allocator).into_gen()?,
        args.timeout.to_clvm(allocator).into_gen()?,
        args.amount.to_clvm(allocator).into_gen()?,
        referee_coin_puzzle_hash.to_clvm(allocator).into_gen()?,
        args.nonce.to_clvm(allocator).into_gen()?,
        args.move_data.to_clvm(allocator).into_gen()?,
        args.max_move_size.to_clvm(allocator).into_gen()?,
        args.validation_info_hash.to_clvm(allocator).into_gen()?,
        args.mover_share.to_clvm(allocator).into_gen()?,
        args.previous_validation_info_hash.to_clvm(allocator).into_gen()?
    ].into_iter().map(|n| Node(n)).collect();
    let args_to_curry_nodeptr = args_to_curry.to_clvm(allocator).into_gen()?;
    let curried_arg_hash = Node(args_to_curry_nodeptr).sha256tree(allocator);
    Ok(curry_and_treehash(referee_coin_puzzle_hash, &[curried_arg_hash]))
}

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone)]
struct RefereeMakerGameState {
    pub state: NodePtr,
    pub validation_program: NodePtr,
    pub validation_program_hash: Hash,
    pub move_data: Vec<u8>,
    pub max_move_size: usize,
    pub mover_share: Amount,
    pub game_handler: GameHandler,
    // Ensure we copy this when we update RefereeMaker::current_state
    pub previous_validation_program_hash: Hash,
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
pub struct RefereeMaker {
    pub referee_coin_puzzle_hash: PuzzleHash,
    pub my_private_key: PrivateKey,

    pub my_referee_puzzle_hash: PuzzleHash,
    pub their_referee_puzzle_hash: PuzzleHash,

    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,

    pub states: [RefereeMakerGameState; 2],
    pub is_my_turn: bool,

    pub message_handler: Option<MessageHandler>,
}

impl RefereeMaker {
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_private_key: &PrivateKey,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize
    ) -> Result<Self, Error> {
        let public_key = private_to_public_key(my_private_key);
        let my_referee_puzzle_hash = puzzle_hash_for_pk(allocator, &public_key)?;
        let state = RefereeMakerGameState {
            state: game_start_info.initial_state.clone(),
            validation_program: game_start_info.initial_validation_puzzle.clone(),
            validation_program_hash: game_start_info.initial_validation_puzzle_hash.hash().clone(),
            move_data: Vec::default(),
            max_move_size: game_start_info.initial_max_move_size,
            mover_share: game_start_info.initial_mover_share.clone(),
            game_handler: game_start_info.game_handler.clone()
        };

        Ok(RefereeMaker {
            referee_coin_puzzle_hash,
            my_referee_puzzle_hash,

            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_private_key: my_private_key.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce: nonce,

            states: [state.clone(), state],
            current_state: false,
            message_handler: None,
        })
    }

    fn current_state(&mut self) -> &mut RefereeMakerGameState {
        &mut self.states[self.is_my_turn as usize]
    }

    fn previous_state(&mut self) -> &mut RefereeMakerGameState {
        &mut self.states[(!self.is_my_turn) as usize]
    }

    pub fn get_amount(&self) -> Amount {
        self.amount.clone()
    }

    pub fn get_current_puzzle(&self) -> Puzzle {
        todo!()
    }

    pub fn get_current_puzzle_hash(&self) -> PuzzleHash {
        self.my_referee_puzzle_hash.clone()
    }

    pub fn my_turn_make_move<R: Rng>(
        &mut self,
        rng: &mut R,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove
    ) -> Result<RefereeMakerMoveResult, Error> {
        let new_entropy: Hash = rng.gen();
        let game_handler =
        {
            let current_state = self.current_state();
            current_state.game_handler.clone()
        };
        let (state, move_data, mover_share) =
        {
            let previous_state = self.previous_state();
            (previous_state.state.clone(),
             previous_state.move_data.clone(),
             previous_state.mover_share.clone()
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
                entropy: new_entropy
            }
        )?;

        {
            self.is_my_turn = !self.is_my_turn;
            let current_state = self.current_state();
            current_state.game_handler = result.waiting_driver;
            current_state.move_data = result.move_data.clone();
            current_state.validation_program = result.validation_program;
            current_state.validation_program_hash = result.validation_program_hash;
            current_state.state = result.state.clone();
            current_state.max_move_size = result.max_move_size;
            current_state.mover_share = result.mover_share.clone();
        }

        self.message_handler = result.message_parser;

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        let (state,
             move_data,
             max_move_size,
             mover_share,
             validation_info_hash,
             previous_validation_info_hash,
        ) =
        {
            let current_state = self.current_state();
            (current_state.state.clone(),
             current_state.move_data.clone(),
             current_state.max_move_size,
             current_state.mover_share.clone(),
             current_state.validation_program_hash.clone(),
             current_state.previous_validation_program_hash.clone()
            )
        };
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.referee_coin_puzzle_hash,
            &RefereePuzzleArgs {
                mover_puzzle_hash: self.my_referee_puzzle_hash.clone(),
                waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                timeout: self.timeout.clone(),
                amount: self.amount.clone(),
                nonce: self.nonce,
                referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                move_data: &move_data,
                max_move_size,
                mover_share,
                validation_info_hash: validation_info_hash.clone(),
                previous_validation_info_hash,
            }
        )?;

        let state_shatree = Node(state).sha256tree(allocator);
        let validation_info_hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&validation_info_hash),
            Sha256Input::Hash(state_shatree.hash())
        ]).hash();

        Ok(RefereeMakerMoveResult {
            puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
            move_made: result.move_data.clone(),
            validation_info_hash,
            max_move_size: result.max_move_size,
            mover_share: result.mover_share.clone(),
        })
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: NodePtr
    ) -> Result<ReadableUX, Error> {
        // Do stuff with message handler.
        let (state, move_data, mover_share) =
        {
            let current_state = self.current_state();
            (current_state.state,
             current_state.move_data.clone(),
             current_state.mover_share.clone()
            )
        };
        let result =
            if let Some(handler) = self.message_handler.as_ref() {
                handler.run(
                    allocator,
                    &MessageInputs {
                        message,
                        amount: self.amount.clone(),
                        state: state.clone(),
                        move_data,
                        mover_share,
                    }
                )?
            } else {
                return Err(Error::StrErr("no message handler but have a message".to_string()));
            };

        self.message_handler = None;

        Ok(result)
    }

    // Agg sig me on the solution of the referee_coin_puzzle.
    // When it invokes the validation program, it passes through args as the full
    // argument set.
    fn curry_referee_puzzle(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        curried_args: &RefereePuzzleArgs,
        // args from referee.clsp
        args: Option<NodePtr>,
        agg_sig_additional_data: &Hash
    ) -> Result<TransactionBundle, Error> {
        let public_key = private_to_public_key(&self.my_private_key);
        let my_referee_puzzle = puzzle_for_pk(allocator, &public_key)?;
        let puzzle = CurriedProgram {
            program: my_referee_puzzle.clone(),
            args: clvm_curried_args!(
                curried_args.mover_puzzle_hash.clone(),
                curried_args.waiter_puzzle_hash.clone(),
                curried_args.timeout.clone(),
                curried_args.amount.clone(),
                &self.referee_coin_puzzle_hash,
                curried_args.nonce,
                curried_args.move_data,
                curried_args.max_move_size,
                curried_args.validation_info_hash.clone(),
                curried_args.mover_share.clone(),
                curried_args.previous_validation_info_hash.clone()
            )
        }.to_clvm(allocator).into_gen()?;
        let solution = args.unwrap_or_else(|| allocator.allocator().null());
        let solution_hash = Node(solution).sha256tree(allocator);

        let signature = sign_agg_sig_me(
            &self.my_private_key,
            &solution_hash.bytes(),
            &coin_string.to_coin_id(),
            agg_sig_additional_data
        );

        Ok(TransactionBundle {
            puzzle: Puzzle::from_nodeptr(puzzle),
            solution,
            signature
        })
    }

    // Ensure this returns
    fn get_transaction(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        always_produce_transaction: bool,
        move_puzzle_reveal: bool,
        args: Option<NodePtr>,
        agg_sig_me_additional_data: &Hash,
    ) -> Result<Option<(TransactionBundle, CoinString)>, Error> {
        let (my_turn, mover_share) =
        {
            let use_current_state = !move_puzzle_reveal;
            let current_state =
                if use_current_state {
                    self.current_state()
                } else {
                    self.previous_state()
                };

            (|current_state: &mut RefereeMakerState| {
                match &current_state.game_handler {
                    GameHandler::MyTurnHandler(h) => {
                        // It is my turn
                        if current_state.mover_share != Amount::default() {
                            // And we have a mover share.
                            return (true, current_state.mover_share.clone());
                        }

                        (true, Amount::default())
                    }
                    GameHandler::TheirTurnHandler(h) => {
                        // Their turn
                        if current_state.mover_share != self.amount {
                            // There is some left over.
                            return (false, self.amount.clone() - current_state.mover_share.clone());
                        }

                        (false, Amount::default())
                    }
                }
            })(current_state);
        };
        if always_produce_transaction || mover_share != Amount::default() {
            // XXX do this differently based on args.is_none()
            // because that is a move transaction with no reward.
            let transaction_bundle = {
                let current_state = self.current_state();
                let mover_puzzle_hash =
                    if my_turn {
                        self.my_referee_puzzle_hash.cone()
                    } else {
                        self.their_referee_puzzle_hash.clone()
                    };
                let waiter_puzzle_hash =
                    if my_turn {
                        self.their_referee_puzzle_hash.clone()
                    } else {
                        self.my_referee_puzzle_hash.clone()
                    };

                self.curry_referee_puzzle(
                    allocator,
                    coin_string,
                    RefereePuzzleArgs {
                        mover_puzzle_hash,
                        waiter_puzzle_hash,
                        timeout: self.timeout.clone(),
                        amount: self.amount.clone(),
                        referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                        move_data: &current_state.move_data,
                        nonce: self.nonce,
                        max_move_size: current_state.max_move_size,
                        validation_info_hash: current_state.validation_info_hash,
                        mover_share: current_state.mover_share.clone(),
                        previous_validation_info_hash: current_state.previous_validation_info_hash.clone()
                    }
                    args,
                    agg_sig_me_additional_data
                )?
            };

            let output_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &self.my_referee_puzzle_hash,
                mover_share.clone()
            );
            return Ok(Some((transaction_bundle, output_coin_string)));
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
        agg_sig_me_additional_data: &Hash,
    ) -> Result<Option<(TransactionBundle, CoinString)>, Error> {
        self.get_transaction(
            allocator,
            coin_string,
            false,
            false,
            None,
            agg_sig_me_additional_data
        )
    }

    pub fn get_transaction_for_move(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        agg_sig_me_additional_data: &[u8],
    ) -> Result<(TransactionBundle, CoinString), Error> {
        let puzzle_reveal =
        {
            let previous_args =
            {
                let previous_state = self.previous_state();
                let puzzle_hash = curry_referee_puzzle_hash(
                    allocator,
                    self.referee_coin_puzzle_hash.clone(),
                    &RefereePuzzleArgs {
                        // XXX check polarity
                        mover_puzzle_hash: self.my_referee_puzzle_hash.clone(),
                        waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                        timeout: self.timeout.clone(),
                        amount: self.amount.clone(),
                        referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                        move_data: &previous_state.move_data,
                        nonce: self.nonce,
                        max_move_size: previous_state.max_move_size,
                        validation_info_hash: previous_state.validation_info_hash.clone(),
                        mover_share: previous_state.amount.clone(),
                        previous_validation_info_hash: previous_state.previous_validation_info_hash.clone()
                    }
                )?;
                let inner_conditions =
                    // XXX puzzle_reveal
                    (CREATE_COIN, (puzzle_hash, (self.amount.clone(), ()))).to_clvm(allocator).into_gen()?;
                let (solution, sig): NodePtr =
                    standard_solution(
                        allocator,
                        &self.my_private_key,
                        inner_conditions
                    )?;
                let args_list: Vec<Node> =
                    [previous_state.move_data.to_clvm(allocator).into_gen()?,
                     previous_state.validation_info_hash.to_clvm(allocator).into_gen(),
                     previous_state.mover_share.to_clvm(allocator).into_gen()?,
                     previous_state.max_move_size.to_clvm(allocator).into_gen()?,
                     previous_state.referee_puzzle.clone(),
                     solution,
                    ].into_iter().map(|n| Node(n));
                args_list.to_clvm(allocator).into_gen()?
            };

            if let Some(bundle, cs_out) = self.get_transaction(
                allocator,
                coin_string,
                true,
                true,
                Some(previous_args),
                agg_sig_me_additional_data
            )? {
                bundle.puzzle.clone()
            } else {
                // Return err
                todo!();
            };
        };
        let args =
        {
            let current_state = self.current_state();
            let inner_conditions =
                (CREATE_COIN, (puzzle_reveal.sha256tree(allocator), (self.amount.clone(), ()))).to_clvm(allocator).into_gen()?;
            let (solution, sig): NodePtr =
                standard_solution(
                    allocator,
                    &self.my_private_key,
                    inner_conditions
                )?;
            let args_list: Vec<Node> =
                [current_state.move_data.to_clvm(allocator).into_gen()?,
                 current_state.validation_info_hash.to_clvm(allocator).into_gen(),
                 current_state.mover_share.to_clvm(allocator).into_gen()?,
                 current_state.max_move_size.to_clvm(allocator).into_gen()?,
                 current_state.referee_puzzle.clone(),
                 solution,
                ].into_iter().map(|n| Node(n));
            args_list.to_clvm(allocator).into_gen()?
        };

        self.get_transaction(
            allocator,
            coin_string,
            false,
            true,
            Some(args),
            agg_sig_me_additional_data
        )
    }

    pub fn get_my_share(
        &self,
        allocator: &mut AllocEncoder
    ) -> Amount {
        let current_state = self.current_state();
        match &current_state.game_handler {
            GameHandler::MyTurnGameHandler(_) => {
                current_state.mover_share.clone()
            }
            GameHandler::TheirTurnGameHandler(_) => {
                self.amount.clone() - current_state.mover_share.clone()
            }
        }
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        their_move: &[u8],
        validation_info_hash: &Hash,
        max_move_size: usize,
        mover_share: &Amount,
    ) -> Result<TheirTurnMoveResult, Error> {
        let (handler, last_state, last_move_data, last_mover_share)  =
        {
            let current_state = self.current_state();
            (current_state.game_handler.clone(),
             current_state.state.clone(),
             current_state.move_data.clone(),
             current_state.mover_share.clone()
            )
        };

        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.amount.clone(),
                last_state,
                last_move_data,
                last_mover_share,
                new_move: their_move,
                new_validation_info_hash: validation_info_hash.clone(),
                new_max_move_size: max_move_size,
                new_mover_share: mover_share.clone()
            }
        )?;

        match result {
            TheirTurnResult::MakeMove(handler, readable_move, message) => {
                let previous_validation_info_hash = self.current_state().validation_info_hash.clone();

                let puzzle_hash_for_unroll =
                {
                    // Update the turn
                    self.is_my_turn = !self.is_my_turn;
                    let current_state = self.current_state();
                    current_state.previous_validation_info_hash = previous_validation_info_hash;
                    current_state.move_data = their_move.clone();
                    current_state.validation_info_hash = validation_info_hash.clone();
                    current_state.mover_share = mover_share.clone();
                    current_state.max_move_size = max_move_size.clone();
                    current_state.handler = handler;

                    curry_referee_puzzle_hash(
                        allocator,
                        self.referee_coin_puzzle_hash.clone(),
                        &RefereePuzzleArgs {
                            // XXX check polarity
                            mover_puzzle_hash: self.my_referee_puzzle_hash.clone(),
                            waiter_puzzle_hash: self.their_referee_puzzle_hash.clone(),
                            timeout: self.timeout.clone(),
                            amount: self.amount.clone(),
                            referee_coin_puzzle_hash: self.referee_coin_puzzle_hash.clone(),
                            move_data: &current_state.move_data,
                            nonce: self.nonce,
                            max_move_size: current_state.max_move_size,
                            validation_info_hash: current_state.validation_info_hash.clone(),
                            mover_share: current_state.amount.clone(),
                            previous_validation_info_hash: current_state.previous_validation_info_hash.clone()
                        }
                    )?
                };

                // Coin calculated off the new new state.
                Ok(TheirTurnMoveResult {
                    puzzle_hash_for_unroll,
                    readable_move: readable_move.clone(),
                    message: message.clone()
                })
            }
            TheirTurnResult::Slash(evidence, signature) => {
                return Err(Error::ErrStr("slash when off chain".to_string()));
            }
        }
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &NodePtr
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Read parameters off conditions
        // Try null slashing
        // Call the game handler -> returns evident
        // Try slashing with evidence
        // Otherwise accept move by updating our state.
        todo!();
    }
}
