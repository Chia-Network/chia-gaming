use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{
    Evidence, PotatoMoveCachedData, ReadableMove, StateUpdateProgram, ValidationInfo,
};
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, sign_agg_sig_me, ChiaIdentity,
};
use crate::common::types::{
    chia_dialect, Aggsig, AllocEncoder, Amount, CoinSpend, CoinString, Error, Hash, IntoErr,
    Node, MAX_BLOCK_COST_CLVM,
    Program, ProgramRef, PublicKey, Puzzle, PuzzleHash, Sha256tree, Timeout,
};
use crate::utils::proper_list;

// =============================================================================
// SHARED TYPES
// =============================================================================

#[derive(Eq, PartialEq, Debug, Clone, Serialize, Deserialize)]
pub struct GameMoveStateInfo {
    pub move_made: Vec<u8>,
    pub mover_share: Amount,
    pub max_move_size: usize,
}

#[derive(Clone, Eq, PartialEq, Debug, Serialize, Deserialize)]
pub enum ValidationInfoHash {
    None,
    Initial,
    Hash(Hash),
}

impl ValidationInfoHash {
    pub fn is_some(&self) -> bool {
        !matches!(self, ValidationInfoHash::None)
    }

    pub fn is_none(&self) -> bool {
        matches!(self, ValidationInfoHash::None)
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for ValidationInfoHash {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        match self {
            ValidationInfoHash::None => encoder.encode_atom(clvm_traits::Atom::Borrowed(&[])),
            ValidationInfoHash::Initial => {
                encoder.encode_atom(clvm_traits::Atom::Borrowed(&[0x78]))
            }
            ValidationInfoHash::Hash(h) => encoder.encode_atom(clvm_traits::Atom::Borrowed(&h.0)),
        }
    }
}

#[derive(Debug, Eq, PartialEq, Clone, Serialize, Deserialize)]
pub struct GameMoveDetails {
    pub basic: GameMoveStateInfo,
    pub validation_program_hash: ValidationInfoHash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameMoveWireData {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub details: GameMoveDetails,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TheirTurnMoveResult {
    pub puzzle_hash_for_unroll: Option<PuzzleHash>,
    pub readable_move: ProgramRef,
    pub mover_share: Amount,
    pub message: Vec<u8>,
    pub slash: Option<Evidence>,
}

#[derive(Debug)]
pub enum SlashOutcome {
    NoReward,
    Reward {
        transaction: Box<CoinSpend>,
        my_reward_coin_string: CoinString,
        /// The mover_share the opponent claimed in their illegal move.
        /// If the slash times out, this is what we actually end up with.
        cheating_move_mover_share: Amount,
    },
}

#[derive(Debug)]
pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: Option<CoinString>,
    },
    Expected(usize, PuzzleHash, Amount, Option<Rc<PotatoMoveCachedData>>),
    Moved {
        // New iteration of the game coin.
        new_coin_string: CoinString,
        state_number: usize,
        readable: ReadableMove,
        mover_share: Amount,
    },
    Slash(Box<SlashOutcome>),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RMFixed {
    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub my_identity: ChiaIdentity,

    pub reward_puzzle_hash: PuzzleHash,
    pub their_reward_puzzle_hash: PuzzleHash,

    pub their_referee_pubkey: PublicKey,
    pub their_reward_payout_signature: Aggsig,
    pub my_reward_payout_signature: Aggsig,
    pub agg_sig_me_additional_data: Hash,

    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: u64,
}

// =============================================================================
// V1-SPECIFIC TYPES
// =============================================================================

pub const REM_CONDITION_FIELDS: usize = 4;

/// Validator result: `Some(new_state)` for a valid move payload, `None` for slash (`nil`).
pub type StateUpdateResult = Option<Rc<Program>>;

pub fn parse_validator_result(
    allocator: &mut AllocEncoder,
    node: NodePtr,
) -> Result<StateUpdateResult, Error> {
    let lst = if let Some(p) = proper_list(allocator.allocator(), node, true) {
        p
    } else {
        return Err(Error::StrErr("non-list in validator result".to_string()));
    };

    if lst.is_empty() {
        return Ok(None);
    }

    if lst.len() < 3 {
        return Err(Error::StrErr("short list for make move".to_string()));
    }

    Ok(Some(Rc::new(Program::from_nodeptr(allocator, lst[1])?)))
}

/// Adjudicates a two player turn based game
///
/// Curried args include MOVER_PUBKEY, WAITER_PUBKEY, TIMEOUT, AMOUNT, etc.
///
/// MOVE, VALIDATION_HASH and MOVER_SHARE were all accepted optimistically from the
/// last move.
///
/// Both VALIDATION_HASH values are a sha256 of a validation program hash and the
/// shatree of a state.
///
/// The next validation program hash may be nil which means no further moves are
/// allowed.
///
/// MOVER_SHARE is how much the mover will get if they fold/accept.
/// MOD_HASH should be the shatree of referee itself.
/// NONCE is for anti-replay prevention.
///
/// If action is timeout, args is (mover_payout_ph waiter_payout_ph).
///   Authorized via AGG_SIG_UNSAFE with pre-signed payout signatures.
///
/// If action is slash, args is (state validation_program evidence mover_payout_ph).
///   Authorized via AGG_SIG_UNSAFE MOVER_PUBKEY (concat 0x78 mover_payout_ph).
///
/// If action is move, args is (new_move infohash_c new_mover_share new_max_move_size).
///   Authorized via AGG_SIG_ME MOVER_PUBKEY (shatree args).
#[derive(Eq, PartialEq, Debug, Clone, Serialize, Deserialize)]
pub struct RefereePuzzleArgs {
    pub mover_pubkey: PublicKey,
    pub waiter_pubkey: PublicKey,
    pub timeout: Timeout,
    pub amount: Amount,
    pub nonce: u64,
    pub game_move: GameMoveDetails,
    pub validation_program: StateUpdateProgram,
    pub previous_validation_info_hash: ValidationInfoHash,
    pub referee_coin_puzzle_hash: PuzzleHash,
}

impl RefereePuzzleArgs {
    pub fn new(
        fixed_info: &RMFixed,
        initial_move: &GameMoveDetails,
        previous_validation_info_hash: ValidationInfoHash,
        validation_program: StateUpdateProgram,
        my_turn: bool,
    ) -> Self {
        RefereePuzzleArgs {
            mover_pubkey: if my_turn {
                fixed_info.my_identity.public_key.clone()
            } else {
                fixed_info.their_referee_pubkey.clone()
            },
            waiter_pubkey: if my_turn {
                fixed_info.their_referee_pubkey.clone()
            } else {
                fixed_info.my_identity.public_key.clone()
            },
            timeout: fixed_info.timeout.clone(),
            amount: fixed_info.amount.clone(),
            nonce: fixed_info.nonce,
            validation_program,
            referee_coin_puzzle_hash: fixed_info.referee_coin_puzzle_hash.clone(),
            game_move: initial_move.clone(),
            previous_validation_info_hash,
        }
    }

    pub fn swap(&self) -> RefereePuzzleArgs {
        RefereePuzzleArgs {
            mover_pubkey: self.waiter_pubkey.clone(),
            waiter_pubkey: self.mover_pubkey.clone(),
            ..self.clone()
        }
    }

    pub fn off_chain(&self) -> RefereePuzzleArgs {
        let mut new_result: RefereePuzzleArgs = self.clone();
        new_result.waiter_pubkey = PublicKey::default();
        new_result
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for RefereePuzzleArgs
where
    NodePtr: ToClvm<E>,
{
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        [
            self.mover_pubkey.to_clvm(encoder)?,
            if self.waiter_pubkey == PublicKey::default() {
                encoder.encode_atom(clvm_traits::Atom::Borrowed(&[]))?
            } else {
                self.waiter_pubkey.to_clvm(encoder)?
            },
            self.timeout.to_clvm(encoder)?,
            self.amount.to_clvm(encoder)?,
            self.referee_coin_puzzle_hash.to_clvm(encoder)?,
            self.nonce.to_clvm(encoder)?,
            encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.game_move.basic.move_made))?,
            self.game_move.basic.max_move_size.to_clvm(encoder)?,
            self.game_move.validation_program_hash.to_clvm(encoder)?,
            self.game_move.basic.mover_share.to_clvm(encoder)?,
            self.previous_validation_info_hash.to_clvm(encoder)?,
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

pub fn curry_referee_puzzle(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle: &Puzzle,
    args: &RefereePuzzleArgs,
) -> Result<Puzzle, Error> {
    let combined_args = args.to_clvm(allocator).into_gen()?;
    let curried_program_nodeptr = CurriedProgram {
        program: referee_coin_puzzle,
        args: clvm_curried_args!(Node(combined_args)),
    }
    .to_clvm(allocator)
    .into_gen()?;
    Puzzle::from_nodeptr(allocator, curried_program_nodeptr)
}

/// Arguments passed to the validator (state update program) for move queries.
/// Contains the game state and evidence for validation.
pub struct StateUpdateMoveArgs {
    pub state: Rc<Program>,
    pub evidence: Rc<Program>,
}

impl StateUpdateMoveArgs {
    pub fn to_nodeptr(
        &self,
        allocator: &mut AllocEncoder,
        me: StateUpdateProgram,
    ) -> Result<NodePtr, Error> {
        (&self.state, (me, (&self.evidence, ())))
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
        game_assert_eq!(
            self.referee_args.validation_program.hash(),
            self.validation_program.hash(),
            "ValidationInfo::run: validation_program hash mismatch"
        );
        let validation_program_mod_hash = self.validation_program.hash();
        let validation_program_nodeptr = self.validation_program.to_nodeptr(allocator)?;
        let validator_full_args_node = self.to_nodeptr(
            allocator,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;

        let raw_result_p = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen();
        let raw_result = raw_result_p?;

        parse_validator_result(allocator, raw_result.1)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OnChainRefereeMoveData {
    pub state: Rc<Program>,
    pub validation_program: StateUpdateProgram,
    pub new_move: GameMoveDetails,
    pub before_args: Rc<RefereePuzzleArgs>,
    pub after_args: Rc<RefereePuzzleArgs>,
}

impl OnChainRefereeMoveData {
    pub fn to_move(
        &self,
        allocator: &mut AllocEncoder,
        fixed: &RMFixed,
        coin_string: &CoinString,
    ) -> Result<OnChainRefereeMove, Error> {
        let infohash_c: Option<Hash> = if self.new_move.validation_program_hash.is_some() {
            let vi = ValidationInfo::new_state_update(
                allocator,
                self.validation_program.clone(),
                self.state.clone(),
            );
            Some(vi.hash().clone())
        } else {
            None
        };
        let solution_args_node = (
            allocator
                .encode_atom(clvm_traits::Atom::Borrowed(&self.new_move.basic.move_made))
                .into_gen()?,
            (
                infohash_c.as_ref(),
                (
                    self.new_move.basic.mover_share.clone(),
                    (self.new_move.basic.max_move_size, ()),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;
        let message = Node(solution_args_node).sha256tree(allocator);

        let signature = sign_agg_sig_me(
            &fixed.my_identity.private_key,
            message.bytes(),
            &coin_string.to_coin_id(),
            &fixed.agg_sig_me_additional_data,
        );

        Ok(OnChainRefereeMove {
            game_move: self.new_move.clone(),
            state: self.state.clone(),
            validation_program: self.validation_program.clone(),
            signature,
        })
    }
}

/// Dynamic arguments passed to the on chain referee to apply a move
#[derive(Debug, Clone)]
pub struct OnChainRefereeMove {
    /// The new move to make
    pub game_move: GameMoveDetails,
    /// Validation program that relates to this move.
    pub validation_program: StateUpdateProgram,
    /// State before this validation program ran.
    pub state: Rc<Program>,
    /// AGG_SIG_ME signature authorizing this move
    pub signature: Aggsig,
}

/// Dynamic arguments passed to the on chain referee to apply a slash.
/// The referee puzzle emits CREATE_COIN and AGG_SIG_UNSAFE for the mover's
/// reward payout, matching the timeout pattern.
#[derive(Debug, Clone)]
pub struct OnChainRefereeSlash {
    /// Validation program that relates to this move.
    pub validation_program: StateUpdateProgram,

    /// State before this validation program ran.
    pub state: Rc<Program>,

    /// clvm data about the slash.
    pub evidence: Evidence,

    /// Puzzle hash where the mover receives the full pot.
    pub reward_puzzle_hash: PuzzleHash,

    /// Pre-cached AGG_SIG_UNSAFE signature for reward payout.
    pub signature: Aggsig,
}

/// onchain referee solution
///
/// Timeout: (mover_payout_ph waiter_payout_ph)
/// Move: (new_move infohash_c new_mover_share new_max_move_size)
/// Slash: (previous_state previous_validation_program evidence mover_payout_ph)
#[derive(Debug, Clone)]
pub enum OnChainRefereeSolution {
    Timeout {
        mover_payout_ph: Option<PuzzleHash>,
        waiter_payout_ph: Option<PuzzleHash>,
        aggregate_signature: Aggsig,
    },
    Move(Rc<OnChainRefereeMove>),
    Slash(Rc<OnChainRefereeSlash>),
}

impl OnChainRefereeSolution {
    pub fn get_signature(&self) -> Option<Aggsig> {
        match self {
            OnChainRefereeSolution::Timeout {
                aggregate_signature,
                ..
            } => Some(aggregate_signature.clone()),
            OnChainRefereeSolution::Move(refmove) => Some(refmove.signature.clone()),
            OnChainRefereeSolution::Slash(refslash) => Some(refslash.signature.clone()),
        }
    }

    pub fn to_nodeptr(
        &self,
        encoder: &mut AllocEncoder,
        _fixed: &RMFixed,
    ) -> Result<NodePtr, Error> {
        match self {
            OnChainRefereeSolution::Timeout {
                mover_payout_ph,
                waiter_payout_ph,
                ..
            } => (mover_payout_ph.as_ref(), (waiter_payout_ph.as_ref(), ()))
                .to_clvm(encoder)
                .into_gen(),
            OnChainRefereeSolution::Move(refmove) => {
                let move_atom = encoder
                    .encode_atom(clvm_traits::Atom::Borrowed(
                        &refmove.game_move.basic.move_made,
                    ))
                    .into_gen()?;
                let infohash_c: Option<Hash> =
                    if refmove.game_move.validation_program_hash.is_some() {
                        let vi = ValidationInfo::new_state_update(
                            encoder,
                            refmove.validation_program.clone(),
                            refmove.state.clone(),
                        );
                        Some(vi.hash().clone())
                    } else {
                        None
                    };

                (
                    move_atom,
                    (
                        infohash_c.as_ref(),
                        (
                            refmove.game_move.basic.mover_share.clone(),
                            (refmove.game_move.basic.max_move_size, ()),
                        ),
                    ),
                )
                    .to_clvm(encoder)
                    .into_gen()
            }
            OnChainRefereeSolution::Slash(refslash) => (
                refslash.state.clone(),
                (
                    refslash.validation_program.clone(),
                    (
                        refslash.evidence.clone(),
                        (refslash.reward_puzzle_hash.clone(), ()),
                    ),
                ),
            )
                .to_clvm(encoder)
                .into_gen(),
        }
    }
}
