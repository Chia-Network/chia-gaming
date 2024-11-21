use std::rc::Rc;

use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::serde::node_from_bytes;
use clvmr::Allocator;

use log::debug;

use rand::distributions::Standard;
use rand::prelude::*;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{FlatGameHandler, GameHandler};
use crate::common::constants::{CREATE_COIN, REM};
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_pk, read_hex_puzzle, standard_solution_partial,
    unsafe_sign_partial,
};
use crate::common::types::{
    atom_from_clvm, usize_from_atom, Aggsig, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinID,
    CoinSpend, CoinString, Error, GameID, Hash, IntoErr, Node, PrivateKey, Program, PublicKey,
    Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend, Timeout,
};
use crate::referee::{
    GameMoveDetails, GameMoveWireData, LiveGameReplay, RefereeMaker, RefereeOnChainTransaction,
    TheirTurnCoinSpentResult, TheirTurnMoveResult,
};

#[derive(Clone)]
pub struct ChannelHandlerPrivateKeys {
    pub my_channel_coin_private_key: PrivateKey,
    pub my_unroll_coin_private_key: PrivateKey,
    pub my_referee_private_key: PrivateKey,
}

impl Distribution<ChannelHandlerPrivateKeys> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> ChannelHandlerPrivateKeys {
        ChannelHandlerPrivateKeys {
            my_channel_coin_private_key: rng.gen(),
            my_unroll_coin_private_key: rng.gen(),
            my_referee_private_key: rng.gen(),
        }
    }
}

pub struct ChannelHandlerInitiationData {
    pub launcher_coin_id: CoinID,
    pub we_start_with_potato: bool,
    pub their_channel_pubkey: PublicKey,
    pub their_unroll_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub unroll_advance_timeout: Timeout,
}

#[derive(Clone)]
pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PotatoSignatures {
    // Half signed thing signing to the new state.
    pub my_channel_half_signature_peer: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
    pub my_unroll_half_signature_peer: Aggsig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GenericGameStartInfo<
    H: std::fmt::Debug + Clone,
    VP: std::fmt::Debug + Clone,
    S: std::fmt::Debug + Clone,
> {
    pub game_id: GameID,
    pub amount: Amount,
    pub game_handler: H,
    pub timeout: Timeout,

    pub my_contribution_this_game: Amount,
    pub their_contribution_this_game: Amount,

    pub initial_validation_program: VP,
    pub initial_state: S,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,
}

pub type GameStartInfo = GenericGameStartInfo<GameHandler, ValidationProgram, NodePtr>;
pub type FlatGameStartInfo = GenericGameStartInfo<FlatGameHandler, Program, Program>;

pub struct PrintableGameStartInfo<'a> {
    pub allocator: &'a mut Allocator,
    pub info: &'a GameStartInfo,
}

impl<'a> std::fmt::Debug for PrintableGameStartInfo<'a> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        writeln!(formatter, "- game_id: {:?}", self.info.game_id)?;
        writeln!(formatter, "- amount: {:?}", self.info.amount)?;
        writeln!(
            formatter,
            "- game_handler: {} {}",
            self.info.game_handler.is_my_turn(),
            disassemble(self.allocator, self.info.game_handler.to_nodeptr(), None)
        )?;
        writeln!(formatter, "- timeout: {:?}", self.info.timeout)?;
        writeln!(
            formatter,
            "- my_contribution_this_game: {:?}",
            self.info.my_contribution_this_game
        )?;
        writeln!(
            formatter,
            "- their_contribution_this_game: {:?}",
            self.info.their_contribution_this_game
        )?;
        writeln!(
            formatter,
            "- initial_validation_program: {}",
            disassemble(
                self.allocator,
                self.info.initial_validation_program.to_nodeptr(),
                None
            )
        )?;
        writeln!(
            formatter,
            "- initial_state: {}",
            disassemble(self.allocator, self.info.initial_state, None)
        )?;
        writeln!(formatter, "- initial_move: {:?}", self.info.initial_move)?;
        writeln!(
            formatter,
            "- initial_max_move_size: {:?}",
            self.info.initial_max_move_size
        )?;
        writeln!(
            formatter,
            "- initial_mover_share: {:?}",
            self.info.initial_mover_share
        )?;

        Ok(())
    }
}

impl GenericGameStartInfo<GameHandler, ValidationProgram, NodePtr> {
    pub fn is_my_turn(&self) -> bool {
        matches!(self.game_handler, GameHandler::MyTurnHandler(_))
    }

    pub fn from_serializable(
        allocator: &mut AllocEncoder,
        serializable: &FlatGameStartInfo,
    ) -> Result<GameStartInfo, Error> {
        let game_handler_nodeptr = node_from_bytes(
            allocator.allocator(),
            &serializable.game_handler.serialized.0,
        )
        .into_gen()?;
        let game_handler = if serializable.game_handler.my_turn {
            GameHandler::MyTurnHandler(game_handler_nodeptr)
        } else {
            GameHandler::TheirTurnHandler(game_handler_nodeptr)
        };
        let initial_validation_program_nodeptr = node_from_bytes(
            allocator.allocator(),
            &serializable.initial_validation_program.0,
        )
        .into_gen()?;
        let initial_validation_program =
            ValidationProgram::new(allocator, initial_validation_program_nodeptr);
        let initial_state_nodeptr =
            node_from_bytes(allocator.allocator(), &serializable.initial_state.0).into_gen()?;
        Ok(GenericGameStartInfo {
            game_id: serializable.game_id.clone(),
            amount: serializable.amount.clone(),
            game_handler,
            timeout: serializable.timeout.clone(),
            my_contribution_this_game: serializable.my_contribution_this_game.clone(),
            their_contribution_this_game: serializable.their_contribution_this_game.clone(),
            initial_validation_program,
            initial_state: initial_state_nodeptr,
            initial_move: serializable.initial_move.clone(),
            initial_max_move_size: serializable.initial_max_move_size,
            initial_mover_share: serializable.initial_mover_share.clone(),
        })
    }

    pub fn to_serializable(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<FlatGameStartInfo, Error> {
        let flat_game_handler = self.game_handler.to_serializable(allocator)?;
        let flat_validation_program =
            Program::from_nodeptr(allocator, self.initial_validation_program.to_nodeptr())?;
        let flat_state = Program::from_nodeptr(allocator, self.initial_state)?;

        Ok(GenericGameStartInfo {
            game_id: self.game_id.clone(),
            amount: self.amount.clone(),
            game_handler: flat_game_handler,
            timeout: self.timeout.clone(),
            my_contribution_this_game: self.my_contribution_this_game.clone(),
            their_contribution_this_game: self.their_contribution_this_game.clone(),
            initial_validation_program: flat_validation_program,
            initial_state: flat_state,
            initial_move: self.initial_move.clone(),
            initial_max_move_size: self.initial_max_move_size,
            initial_mover_share: self.initial_mover_share.clone(),
        })
    }

    pub fn from_clvm(
        allocator: &mut AllocEncoder,
        my_turn: bool,
        clvm: NodePtr,
    ) -> Result<Self, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator(), clvm, true) {
            lst
        } else {
            return Err(Error::StrErr(
                "game start info clvm wasn't a full list".to_string(),
            ));
        };

        if lst.len() != 11 {
            return Err(Error::StrErr(
                "game start info clvm needs 11 items".to_string(),
            ));
        }

        let returned_game_id = GameID::from_clvm(allocator, lst[0])?;
        let returned_amount = Amount::from_clvm(allocator, lst[1])?;
        let returned_handler = if my_turn {
            GameHandler::MyTurnHandler(lst[2])
        } else {
            GameHandler::TheirTurnHandler(lst[2])
        };
        let returned_timeout = Timeout::from_clvm(allocator, lst[3])?;
        let returned_my_contribution = Amount::from_clvm(allocator, lst[4])?;
        let returned_their_contribution = Amount::from_clvm(allocator, lst[5])?;

        let validation_program = ValidationProgram::new(allocator, lst[6]);
        let initial_state = lst[7];
        let initial_move = if let Some(a) = atom_from_clvm(allocator, lst[8]) {
            a.to_vec()
        } else {
            return Err(Error::StrErr("initial move wasn't an atom".to_string()));
        };
        let initial_max_move_size =
            if let Some(a) = atom_from_clvm(allocator, lst[9]).and_then(usize_from_atom) {
                a
            } else {
                return Err(Error::StrErr("bad initial max move size".to_string()));
            };
        let initial_mover_share = Amount::from_clvm(allocator, lst[10])?;

        Ok(GameStartInfo {
            game_id: returned_game_id,
            amount: returned_amount,
            game_handler: returned_handler,
            timeout: returned_timeout,
            my_contribution_this_game: returned_my_contribution,
            their_contribution_this_game: returned_their_contribution,
            initial_validation_program: validation_program,
            initial_state,
            initial_move,
            initial_max_move_size,
            initial_mover_share,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ReadableMove(Program);

impl ReadableMove {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Self, Error> {
        Ok(ReadableMove(Program::from_nodeptr(allocator, n)?))
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.0.to_nodeptr(allocator)
    }

    pub fn from_program(p: Program) -> Self {
        ReadableMove(p)
    }
}

impl ToClvm<NodePtr> for ReadableMove {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        Ok(self.0.to_clvm(encoder)?)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveResult {
    pub signatures: PotatoSignatures,
    pub game_move: GameMoveDetails,
}

#[derive(Debug, Clone)]
pub struct OnChainGameCoin {
    pub game_id_up: GameID,
    pub coin_string_up: Option<CoinString>,
}

#[derive(Debug, Clone)]
pub struct CoinSpentMoveUp {
    pub game_id: GameID,
    pub spend_before_game_coin: CoinSpend,
    pub after_update_game_coin: CoinString,
}

#[derive(Debug, Clone)]
pub struct CoinSpentAccept {
    pub game_id: GameID,
    pub spend: CoinSpend,
    pub reward_coin: CoinString,
}

// Disposition
#[derive(Debug, Clone)]
pub enum CoinSpentDisposition {
    CancelledUX(Vec<GameID>),
    Move(CoinSpentMoveUp),
    Accept(CoinSpentAccept),
}

pub struct DispositionResult {
    pub skip_game: Vec<GameID>,
    pub skip_coin_id: Option<GameID>,
    pub our_contribution_adjustment: Amount,
    pub disposition: CoinSpentDisposition,
}

#[derive(Debug, Clone)]
pub struct CoinSpentResult {
    pub my_clean_reward_coin_string_up: CoinString,
    // New coins that now exist.
    pub new_game_coins_on_chain: Vec<OnChainGameCoin>,
    pub disposition: Option<CoinSpentDisposition>,
}

pub fn read_unroll_metapuzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "clsp/unroll/unroll_meta_puzzle.hex")
}

pub fn read_unroll_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(
        allocator,
        "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
    )
}

pub struct ChannelHandlerEnv<'a, R: Rng> {
    pub allocator: &'a mut AllocEncoder,
    pub rng: &'a mut R,
    pub unroll_metapuzzle: Puzzle,
    pub unroll_puzzle: Puzzle,

    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub standard_puzzle: Puzzle,

    pub agg_sig_me_additional_data: Hash,
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
        standard_puzzle: Puzzle,
        agg_sig_me_additional_data: Hash,
    ) -> ChannelHandlerEnv<'a, R> {
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data,
        }
    }
}

pub struct LiveGame {
    pub game_id: GameID,
    pub rewind_outcome: Option<usize>,
    pub last_referee_puzzle_hash: PuzzleHash,
    referee_maker: Box<RefereeMaker>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

pub struct PotatoAcceptCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub live_game: LiveGame,
    pub at_stake_amount: Amount,
    pub our_share_amount: Amount,
}

#[derive(Debug)]
pub struct PotatoMoveCachedData {
    pub state_number: usize,
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub move_data: ReadableMove,
    pub move_entropy: Hash,
    pub amount: Amount,
}

pub enum CachedPotatoRegenerateLastHop {
    PotatoCreatedGame(Vec<GameID>, Amount, Amount),
    PotatoAccept(PotatoAcceptCachedData),
    PotatoMoveHappening(PotatoMoveCachedData),
}

#[derive(Clone, Debug)]
pub struct ChannelCoinSpentResult {
    pub transaction: Spend,
    pub timeout: bool,
    pub games_canceled: Vec<GameID>,
}

#[derive(Clone, Debug)]
pub struct ChannelCoinSpendInfo {
    pub solution: Rc<Program>,
    pub conditions: Rc<Program>,
    pub aggsig: Aggsig,
}

#[derive(Clone)]
pub struct HandshakeResult {
    pub channel_puzzle_reveal: Puzzle,
    pub amount: Amount,
    pub spend: ChannelCoinSpendInfo,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default, Clone)]
pub struct ChannelHandlerUnrollSpendInfo {
    /// Contains the half signature, puzzle and conditions needed to spend.
    pub coin: UnrollCoin,
    /// Contains the other half of the signature.
    pub signatures: PotatoSignatures,
}

#[derive(Debug, Clone)]
pub struct Evidence(NodePtr);

impl Evidence {
    pub fn from_nodeptr(n: NodePtr) -> Evidence {
        Evidence(n)
    }

    pub fn nil(allocator: &mut AllocEncoder) -> Evidence {
        Evidence(allocator.allocator().null())
    }

    pub fn to_nodeptr(&self) -> NodePtr {
        self.0
    }
}

impl ToClvm<NodePtr> for Evidence {
    fn to_clvm(
        &self,
        _encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

/// Represents a validation program, as opposed to validation info or any of the
/// other kinds of things that are related.
///
/// This can give a validation program hash or a validation info hash, given state.
#[derive(Debug, Clone)]
pub struct ValidationProgram {
    validation_program: NodePtr,
    validation_program_hash: Hash,
}

impl ValidationProgram {
    pub fn new(allocator: &mut AllocEncoder, validation_program: NodePtr) -> Self {
        ValidationProgram {
            validation_program,
            validation_program_hash: Node(validation_program)
                .sha256tree(allocator)
                .hash()
                .clone(),
        }
    }

    pub fn to_nodeptr(&self) -> NodePtr {
        self.validation_program
    }

    pub fn hash(&self) -> &Hash {
        &self.validation_program_hash
    }
}

/// The pair of state and validation program is the source of the validation hash
#[derive(Clone, Debug)]
pub enum ValidationInfo {
    FromProgram {
        game_state: NodePtr,
        validation_program: ValidationProgram,
        hash: Hash,
    },
    FromProgramHash {
        game_state: NodePtr,
        validation_program_hash: Hash,
        hash: Hash,
    },
    FromHash {
        hash: Hash,
    },
}

impl ValidationInfo {
    pub fn new(
        allocator: &mut AllocEncoder,
        validation_program: ValidationProgram,
        game_state: NodePtr,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(validation_program.hash()),
            Sha256Input::Hash(Node(game_state).sha256tree(allocator).hash()),
        ])
        .hash();
        ValidationInfo::FromProgram {
            game_state,
            validation_program,
            hash,
        }
    }
    pub fn new_hash(hash: Hash) -> Self {
        ValidationInfo::FromHash { hash }
    }
    pub fn new_from_validation_program_hash_and_state(
        allocator: &mut AllocEncoder,
        validation_program_hash: Hash,
        game_state: NodePtr,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&validation_program_hash),
            Sha256Input::Hash(Node(game_state).sha256tree(allocator).hash()),
        ])
        .hash();
        ValidationInfo::FromProgramHash {
            game_state,
            validation_program_hash,
            hash,
        }
    }
    pub fn hash(&self) -> &Hash {
        match self {
            ValidationInfo::FromProgramHash { hash, .. }
            | ValidationInfo::FromProgram { hash, .. }
            | ValidationInfo::FromHash { hash } => hash,
        }
    }
}

/// Describes all aspects of the channel coin spend.
/// Allows the user to get the solution, conditions, quoted condition program
/// and signature for the channel coin spend.
pub struct ChannelCoin {
    state_channel_coin: CoinString,
}

impl ChannelCoin {
    pub fn new(state_channel_coin: CoinString) -> Self {
        ChannelCoin { state_channel_coin }
    }

    pub fn coin_string(&self) -> &CoinString {
        &self.state_channel_coin
    }
    pub fn to_coin_id(&self) -> CoinID {
        self.state_channel_coin.to_coin_id()
    }

    pub fn get_solution_and_signature_from_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_public_key: &PublicKey,
        conditions: Rc<Program>,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!("STATE CONDITONS: {conditions:?}");
        let conditions_nodeptr = conditions.to_nodeptr(env.allocator)?;
        let spend = standard_solution_partial(
            env.allocator,
            private_key,
            &self.state_channel_coin.to_coin_id(),
            conditions_nodeptr,
            aggregate_public_key,
            &env.agg_sig_me_additional_data,
            true,
        )?;
        Ok(spend)
    }

    pub fn get_solution_and_signature<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_channel_public_key: &PublicKey,
        aggregate_unroll_public_key: &PublicKey,
        amount: &Amount,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!(
            "making solution for channel coin with unroll state {}",
            unroll_coin.state_number
        );
        let unroll_puzzle =
            unroll_coin.make_curried_unroll_puzzle(env, aggregate_unroll_public_key)?;
        let unroll_puzzle_hash = Node(unroll_puzzle).sha256tree(env.allocator);
        let create_conditions = vec![Node(
            (
                CREATE_COIN,
                (unroll_puzzle_hash.clone(), (amount.clone(), ())),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        )];
        let create_conditions_obj = create_conditions.to_clvm(env.allocator).into_gen()?;
        let create_conditions_with_rem =
            prepend_rem_conditions(env, unroll_coin.state_number, create_conditions_obj)?;
        let ccrem_program = Program::from_nodeptr(env.allocator, create_conditions_with_rem)?;
        self.get_solution_and_signature_from_conditions(
            env,
            private_key,
            aggregate_channel_public_key,
            Rc::new(ccrem_program),
        )
    }
}

pub struct ChannelCoinInfo {
    pub coin: ChannelCoin,
    pub amount: Amount,
    // Used in unrolling.
    pub spend: Spend,
}

#[derive(Debug)]
pub struct UnrollCoinConditionInputs {
    pub ref_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub my_balance: Amount,
    pub their_balance: Amount,
    pub puzzle_hashes_and_amounts: Vec<(PuzzleHash, Amount)>,
}

#[derive(Clone, Debug)]
pub struct UnrollCoinOutcome {
    pub conditions: NodePtr,
    pub conditions_without_hash: NodePtr,
    pub state_number: usize,
    pub hash: PuzzleHash,
    pub signature: Aggsig,
}

/// Represents the unroll coin which will come to exist if the channel coin
/// is spent.  This isolates how the unroll coin functions.
///
/// Unroll takes these curried parameters:
///
/// - SHARED_PUZZLE_HASH
/// - OLD_SEQUENCE_NUMBER
/// - DEFAULT_CONDITIONS_HASH
///
/// The fully curried unroll program takes either
/// - reveal
///
/// or
///
/// - meta_puzzle conditions since conditions are passed through metapuzzle.
///
/// At the end of the day update and verify should produce the same conditions for
/// a specific generation and verify the same message.
///
/// UnrollCoin is responsible for enforcing that a time lock (ASSERT_RELATIVE ...) etc
/// so that the other player has an opportunity to challenge the unroll.
///
/// The unrolling player will have to trigger the "reveal" part as below after a time
/// if the other player doesn't successfully challenge by providing another program that
/// produces new conditions that match the parity criteria.
///
/// XXX TODO: Add time lock
#[derive(Default, Clone)]
pub struct UnrollCoin {
    pub started_with_potato: bool,
    // State number for unroll.
    // Always equal to or 1 less than the current state number.
    // Updated when potato arrives.
    pub state_number: usize,

    pub outcome: Option<UnrollCoinOutcome>,
}

fn prepend_state_number_rem_to_conditions<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    // Add rem condition for the state number
    let rem_condition = (REM, (state_number, ()));
    (rem_condition, Node(conditions))
        .to_clvm(env.allocator)
        .into_gen()
}

pub fn prepend_rem_conditions<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    prepend_state_number_rem_to_conditions(env, state_number, conditions)
}

impl UnrollCoin {
    pub fn get_internal_conditions_for_unroll_coin_spend(&self) -> Result<NodePtr, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions_without_hash)
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    fn get_old_state_number(&self) -> Result<usize, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.state_number)
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_conditions_for_unroll_coin_spend(&self) -> Result<NodePtr, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions)
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_conditions_hash_for_unroll_puzzle(&self) -> Result<PuzzleHash, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.hash.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_unroll_coin_signature(&self) -> Result<Aggsig, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.signature.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    /// What a spend can bring:
    /// Either a game creation that got cancelled happens,
    /// move we did that needs to be replayed on chain.
    /// game folding that we need to replay on chain.
    pub fn make_curried_unroll_puzzle<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_public_key: &PublicKey,
    ) -> Result<NodePtr, Error> {
        let conditions_hash = self.get_conditions_hash_for_unroll_puzzle()?;
        let shared_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(aggregate_public_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;
        let shared_puzzle_hash = Node(shared_puzzle).sha256tree(env.allocator);

        CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                shared_puzzle_hash,
                self.get_old_state_number()? - 1,
                conditions_hash
            ),
        }
        .to_clvm(env.allocator)
        .into_gen()
    }

    pub fn make_unroll_puzzle_solution<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_public_key: &PublicKey,
    ) -> Result<NodePtr, Error> {
        let unroll_inner_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(aggregate_public_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;

        let unroll_puzzle_solution = (
            Node(unroll_inner_puzzle),
            (Node(self.get_conditions_for_unroll_coin_spend()?), ()),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        Ok(unroll_puzzle_solution)
    }

    /// Returns a list of create coin conditions which the unroll coin should do.
    /// We don't care about the parent coin id since we're not constraining it.
    ///
    /// The order is important and the first two coins' order are determined by
    /// whether the potato was ours first.
    /// Needs rem of sequence number and the default conditions hash.
    fn compute_unroll_coin_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<NodePtr, Error> {
        let their_first_coin = (
            CREATE_COIN,
            (
                inputs.their_referee_puzzle_hash.clone(),
                (inputs.their_balance.clone(), ()),
            ),
        );

        let standard_puzzle_hash_of_ref = puzzle_hash_for_pk(env.allocator, &inputs.ref_pubkey)?;

        let our_first_coin = (
            CREATE_COIN,
            (standard_puzzle_hash_of_ref, (inputs.my_balance.clone(), ())),
        );

        let (start_coin_one, start_coin_two) = if self.started_with_potato {
            (our_first_coin, their_first_coin)
        } else {
            (their_first_coin, our_first_coin)
        };

        let start_coin_one_clvm = start_coin_one.to_clvm(env.allocator).into_gen()?;
        let start_coin_two_clvm = start_coin_two.to_clvm(env.allocator).into_gen()?;
        let mut result_coins: Vec<Node> =
            vec![Node(start_coin_one_clvm), Node(start_coin_two_clvm)];

        // Signatures for the unroll puzzle are always unsafe.
        // Signatures for the channel puzzle are always safe (std format).
        // Meta puzzle for the unroll can't be standard.
        for (ph, a) in inputs.puzzle_hashes_and_amounts.iter() {
            let clvm_conditions = (CREATE_COIN, (ph.clone(), (a.clone(), ())))
                .to_clvm(env.allocator)
                .into_gen()?;
            result_coins.push(Node(clvm_conditions));
        }

        let result_coins_node = result_coins.to_clvm(env.allocator).into_gen()?;
        prepend_rem_conditions(env, self.state_number, result_coins_node)
    }

    /// Given new inputs, recompute the state of the unroll coin and store the
    /// conditions and signature necessary for the channel coin to create it.
    pub fn update<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_private_key: &PrivateKey,
        their_unroll_coin_public_key: &PublicKey,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<Aggsig, Error> {
        let unroll_conditions = self.compute_unroll_coin_conditions(env, inputs)?;
        let conditions_hash = Node(unroll_conditions).sha256tree(env.allocator);
        let unroll_public_key = private_to_public_key(unroll_private_key);
        let unroll_aggregate_key = unroll_public_key.clone() + their_unroll_coin_public_key.clone();
        debug!(
            "conditions {}",
            disassemble(env.allocator.allocator(), unroll_conditions, None)
        );
        debug!("conditions_hash {conditions_hash:?}");
        let unroll_signature = unsafe_sign_partial(
            unroll_private_key,
            &unroll_aggregate_key,
            conditions_hash.bytes(),
        );
        self.outcome = Some(UnrollCoinOutcome {
            conditions: unroll_conditions,
            conditions_without_hash: unroll_conditions,
            state_number: self.state_number,
            hash: conditions_hash,
            signature: unroll_signature.clone(),
        });

        debug!("AGGREGATE PUBLIC KEY {:?}", unroll_aggregate_key);
        debug!(
            "SIGNATURE {} {:?}",
            self.started_with_potato, unroll_signature
        );
        debug!(
            "UNROLL UPDATE {} {}",
            self.started_with_potato,
            disassemble(env.allocator.allocator(), unroll_conditions, None)
        );

        Ok(unroll_signature)
    }

    pub fn verify<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_unroll_public_key: &PublicKey,
        signature: &Aggsig,
    ) -> Result<bool, Error> {
        // Check the signature of the unroll coin spend.
        let unroll_puzzle_solution = self.get_internal_conditions_for_unroll_coin_spend()?;
        let unroll_puzzle_solution_hash = Node(unroll_puzzle_solution).sha256tree(env.allocator);

        let aggregate_unroll_signature = signature.clone() + self.get_unroll_coin_signature()?;
        debug!("{} VERIFY: AGGREGATE UNROLL hash {unroll_puzzle_solution_hash:?} {aggregate_unroll_signature:?}", self.started_with_potato);

        Ok(aggregate_unroll_signature.verify(
            aggregate_unroll_public_key,
            unroll_puzzle_solution_hash.bytes(),
        ))
    }
}

pub struct CoinDataForReward {
    pub coin_string: CoinString,
    // parent: CoinID,
    // puzzle_hash: PuzzleHash,
    // amount: Amount,
}

pub struct UnrollTarget {
    pub state_number: usize,
    pub unroll_puzzle_hash: PuzzleHash,
    pub my_amount: Amount,
    pub their_amount: Amount,
}

#[derive(Debug)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
}

impl LiveGame {
    pub fn new(
        game_id: GameID,
        last_referee_puzzle_hash: PuzzleHash,
        referee_maker: RefereeMaker,
        my_contribution: Amount,
        their_contribution: Amount,
    ) -> LiveGame {
        LiveGame {
            game_id,
            last_referee_puzzle_hash,
            referee_maker: Box::new(referee_maker),
            my_contribution,
            their_contribution,
            rewind_outcome: None,
        }
    }

    pub fn is_my_turn(&self) -> bool {
        self.referee_maker.is_my_turn()
    }

    pub fn processing_my_turn(&self) -> bool {
        self.referee_maker.processing_my_turn()
    }

    pub fn internal_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        assert!(self.referee_maker.is_my_turn());
        let referee_result =
            self.referee_maker
                .my_turn_make_move(allocator, readable_move, new_entropy.clone(), state_number)?;
        self.last_referee_puzzle_hash = referee_result.puzzle_hash_for_unroll.clone();
        Ok(referee_result)
    }

    pub fn internal_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        game_move: &GameMoveDetails,
        state_number: usize,
    ) -> Result<TheirTurnMoveResult, Error> {
        assert!(!self.referee_maker.is_my_turn());
        let their_move_result = self
            .referee_maker
            .their_turn_move_off_chain(allocator, game_move, state_number)?;
        self.last_referee_puzzle_hash = their_move_result.puzzle_hash_for_unroll.clone();
        Ok(their_move_result)
    }

    pub fn get_rewind_outcome(&self) -> Option<usize> {
        self.rewind_outcome.clone()
    }

    pub fn get_amount(&self) -> Amount {
        self.referee_maker.get_amount()
    }

    pub fn get_our_current_share(&self) -> Amount {
        self.referee_maker.get_our_current_share()
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        game_coin: &CoinString,
        agg_sig_me: &Hash,
    ) -> Result<RefereeOnChainTransaction, Error> {
        assert!(self.referee_maker.processing_my_turn());
        self.referee_maker
            .get_transaction_for_move(allocator, game_coin, agg_sig_me)
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        data: &[u8],
    ) -> Result<ReadableMove, Error> {
        assert!(!self.referee_maker.is_my_turn());
        self.referee_maker.receive_readable(allocator, data)
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &NodePtr,
        current_state: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        assert!(!self.referee_maker.is_my_turn());
        self.referee_maker
            .their_turn_coin_spent(allocator, coin_string, conditions, current_state)
    }

    /// Regress the live game state to the state we know so that we can generate the puzzle
    /// for that state.  We'll return the move needed to advance it fully.
    pub fn set_state_for_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        want_ph: &PuzzleHash,
        initiated: bool,
        current_state: usize,
    ) -> Result<Option<usize>, Error> {
        let referee_puzzle_hash = self
            .referee_maker
            .curried_referee_puzzle_hash_for_validator(allocator, true)?;

        debug!("live game: current state is {referee_puzzle_hash:?} want {want_ph:?}");
        if referee_puzzle_hash == *want_ph {
            self.rewind_outcome = Some(current_state);
            return Ok(Some(current_state));
        }

        let result = self.referee_maker.rewind(allocator, want_ph, initiated)?;
        if let Some(current_state) = &result {
            self.rewind_outcome = Some(*current_state);
        }

        Ok(result)
    }
}
