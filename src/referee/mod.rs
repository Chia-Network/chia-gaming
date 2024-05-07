use clvmr::allocator::NodePtr;
use clvm_traits::ToClvm;
use rand::Rng;

use crate::common::types::{Aggsig, Amount, CoinString, PuzzleHash, Hash, Puzzle, Program, Timeout, PrivateKey, Error, AllocEncoder, Node, Sha256Input, IntoErr, Sha256tree};
use crate::common::types::TransactionBundle;
use crate::common::standard_coin::{curry_and_treehash, private_to_public_key, puzzle_hash_for_pk};
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

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
pub struct RefereeMaker {
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub my_referee_puzzle_hash: PuzzleHash,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub my_private_key: PrivateKey,
    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
    pub state: NodePtr,
    pub validation_program: NodePtr,
    pub validation_program_hash: Hash,
    pub previous_validation_program_hash: Hash,
    pub most_recent_move: Vec<u8>,
    pub most_recent_max_move_size: usize,
    pub most_recent_mover_share: Amount,
    pub message_handler: Option<MessageHandler>,
    pub game_handler: GameHandler,
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
        Ok(RefereeMaker {
            referee_coin_puzzle_hash,
            my_referee_puzzle_hash,

            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_private_key: my_private_key.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce: nonce,
            state: game_start_info.initial_state.clone(),
            validation_program: game_start_info.initial_validation_puzzle.clone(),
            validation_program_hash: game_start_info.initial_validation_puzzle_hash.hash().clone(),
            previous_validation_program_hash: Hash::default(),
            message_handler: None,
            most_recent_move: Vec::default(),
            most_recent_max_move_size: game_start_info.initial_max_move_size,
            most_recent_mover_share: game_start_info.initial_mover_share.clone(),
            game_handler: game_start_info.game_handler.clone(),
        })
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
        let result = self.game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.amount.clone(),
                last_state: self.state.clone(),
                last_move: &self.most_recent_move,
                last_mover_share: self.most_recent_mover_share.clone(),
                entropy: new_entropy
            }
        )?;

        self.game_handler = result.waiting_driver;
        self.most_recent_move = result.move_data.clone();
        self.validation_program = result.validation_program;
        self.validation_program_hash = result.validation_program_hash;
        self.state = result.state;
        self.most_recent_max_move_size = result.max_move_size;
        self.most_recent_mover_share = result.mover_share.clone();
        self.message_handler = result.message_parser;

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
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
                move_data: &self.most_recent_move,
                max_move_size: self.most_recent_max_move_size,
                mover_share: self.most_recent_mover_share.clone(),
                validation_info_hash: self.validation_program_hash.clone(),
                previous_validation_info_hash: self.previous_validation_program_hash.clone(),
            }
        )?;

        let state_shatree = Node(self.state).sha256tree(allocator);
        let validation_info_hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&self.validation_program_hash),
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
        let result =
            if let Some(handler) = self.message_handler.as_ref() {
                handler.run(
                    allocator,
                    &MessageInputs {
                        message,
                        amount: self.amount.clone(),
                        state: self.state.clone(),
                        move_data: self.most_recent_move.clone(),
                        mover_share: self.most_recent_mover_share.clone()
                    }
                )?
            } else {
                return Err(Error::StrErr("no message handler but have a message".to_string()));
            };

        self.message_handler = None;

        Ok(result)
    }

    pub fn get_transaction_for_accept(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString
    ) -> Result<(TransactionBundle, CoinString), Error> {
        todo!();
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString
    ) -> Result<(TransactionBundle, CoinString), Error> {
        todo!();
    }

    pub fn get_my_share(&self, _allocator: &mut AllocEncoder) -> Amount {
        todo!();
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        _allocator: &mut AllocEncoder,
        _their_move: &[u8],
        _validation_info_hash: &Hash,
        _max_move_size: usize,
        _mover_share: &Amount
    ) -> Result<TheirTurnMoveResult, Error> {
        todo!();
    }

    pub fn their_turn_coin_spent(&mut self, _allocator: &mut AllocEncoder, _coin_string: &CoinString, _conditions: &NodePtr) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
    }
}
