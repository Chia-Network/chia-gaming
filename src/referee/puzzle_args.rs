use log::debug;

use clvm_traits::{ClvmEncoder, ToClvm, clvm_curried_args};
use clvm_utils::CurriedProgram;

use crate::common::types::{AllocEncoder, Amount, Error, Hash, IntoErr, Node, Puzzle, PuzzleHash, Sha256tree, Timeout};
use crate::common::standard_coin::{calculate_hash_of_quoted_mod_hash, curry_and_treehash};
use crate::referee::types::{RefereeMakerGameState, RMFixed, GameMoveDetails, GameMoveStateInfo};

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
///
/// Flow of game:
///
/// alice
///
/// bob
///
/// calpoker_bob_driver_a -
///  first run with state from init
///  then we should call the validator from the init and use the returned
///  state for the next driver call, bob driver b.
///
/// calpoker_bob_driver_b -
///  subsequent run, we start with state returned from our validation program a
///  which was part of the init, or the our validation program from the last
///  move.
///
///  run the our validation program yielded from the previous turn.  use that
///  state for the subsequent turn.
///
#[derive(Eq, PartialEq, Debug)]
pub struct RefereePuzzleArgs {
    pub mover_puzzle_hash: PuzzleHash,
    pub waiter_puzzle_hash: PuzzleHash,
    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: usize,
    pub game_move: GameMoveDetails,
    pub previous_validation_info_hash: Option<Hash>,
}

/*
        their_puzzle_hash: &PuzzleHash,
*/

impl RefereePuzzleArgs {
    pub fn new(
        fixed_info: &RMFixed,
        game_move: &GameMoveStateInfo,
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
                        .unwrap_or_else(|| game_move.mover_share.clone()),
                    ..game_move.clone()
                },
                validation_info_hash: validation_info_hash.clone(),
            },
            previous_validation_info_hash: previous_validation_info_hash.cloned(),
        }
    }

    pub fn to_node_list(
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

pub fn curry_referee_puzzle_hash(
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
pub fn curry_referee_puzzle(
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
