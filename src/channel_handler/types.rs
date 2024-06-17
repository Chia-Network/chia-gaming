use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use rand::distributions::Standard;
use rand::prelude::*;

use crate::channel_handler::game_handler::GameHandler;
use crate::common::constants::{CREATE_COIN, REM};
use crate::common::standard_coin::{read_hex_puzzle, private_to_public_key, puzzle_hash_for_pk, standard_solution_partial, unsafe_sign_partial};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinString, Error, GameID, Hash, IntoErr, Node, PrivateKey,
    PublicKey, Puzzle, PuzzleHash, Sha256Input, Sha256tree, SpecificTransactionBundle, Timeout, TransactionBundle
};
use crate::referee::{GameMoveDetails, RefereeMaker};

#[derive(Default)]
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
}

pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

#[derive(Debug, Clone, Default)]
pub struct PotatoSignatures {
    // Half signed thing signing to the new state.
    pub my_channel_half_signature_peer: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
    pub my_unroll_half_signature_peer: Aggsig,
}

#[derive(Debug, Clone)]
pub struct GameStartInfo {
    pub game_id: GameID,
    pub amount: Amount,
    pub game_handler: GameHandler,
    pub timeout: Timeout,
    pub initial_validation_program: ValidationProgram,
    pub initial_state: NodePtr,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,
}

#[derive(Clone)]
pub struct ReadableMove(NodePtr);

impl ReadableMove {
    pub fn from_nodeptr(n: NodePtr) -> Self {
        ReadableMove(n)
    }
}

impl ToClvm<NodePtr> for ReadableMove {
    fn to_clvm(
        &self,
        _encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

#[derive(Clone)]
pub struct ReadableUX(NodePtr);

pub struct MoveResult {
    pub signatures: PotatoSignatures,
    pub game_move: GameMoveDetails,
}

pub struct OnChainGameCoin<'a> {
    pub game_id_up: GameID,
    pub coin_string_up: Option<CoinString>,
    pub referee_up: &'a RefereeMaker,
}

#[derive(Clone)]
pub struct CoinSpentMoveUp {
    pub game_id: GameID,
    pub spend_before_game_coin: SpecificTransactionBundle,
    pub after_update_game_coin: CoinString,
}

#[derive(Clone)]
pub struct CoinSpentAccept {
    pub game_id: GameID,
    pub spend: SpecificTransactionBundle,
    pub reward_coin: CoinString,
}

// Disposition
#[derive(Clone)]
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

pub struct CoinSpentResult<'a> {
    pub my_clean_reward_coin_string_up: CoinString,
    // New coins that now exist.
    pub new_game_coins_on_chain: Vec<OnChainGameCoin<'a>>,
    pub disposition: Option<CoinSpentDisposition>,
}

pub fn read_unroll_metapuzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "resources/unroll_meta_puzzle.hex")
}

pub fn read_unroll_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(
        allocator,
        "resources/unroll_puzzle_state_channel_unrolling.hex",
    )
}

pub struct ChannelHandlerEnv<'a, R: Rng> {
    pub allocator: &'a mut AllocEncoder,
    pub rng: &'a mut R,
    pub unroll_metapuzzle: Puzzle,
    pub unroll_puzzle: Puzzle,

    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub agg_sig_me_additional_data: Hash,
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
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
            agg_sig_me_additional_data,
        }
    }
}

pub struct LiveGame {
    pub game_id: GameID,
    pub referee_maker: Box<RefereeMaker>,
}

pub struct PotatoAcceptCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub live_game: LiveGame,
    pub at_stake_amount: Amount,
    pub our_share_amount: Amount,
}

pub struct PotatoMoveCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub amount: Amount,
}

pub enum CachedPotatoRegenerateLastHop {
    PotatoCreatedGame(Vec<GameID>, Amount, Amount),
    PotatoAccept(PotatoAcceptCachedData),
    PotatoMoveHappening(PotatoMoveCachedData),
}

pub struct ChannelCoinSpentResult {
    pub transaction: TransactionBundle,
    pub timeout: bool,
    pub games_canceled: Vec<GameID>,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default)]
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
    pub fn new(
        allocator: &mut AllocEncoder,
        validation_program: NodePtr
    ) -> Self {
        ValidationProgram {
            validation_program: validation_program,
            validation_program_hash: Node(validation_program).sha256tree(allocator).hash().clone()
        }
    }

    pub fn to_nodeptr(&self) -> NodePtr { self.validation_program.clone() }

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
        hash: Hash
    }
}

impl ValidationInfo {
    pub fn new(
        allocator: &mut AllocEncoder,
        validation_program: ValidationProgram,
        game_state: NodePtr
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(validation_program.hash()),
            Sha256Input::Hash(&Node(game_state).sha256tree(allocator).hash()),
        ]).hash();
        ValidationInfo::FromProgram {
            game_state,
            validation_program,
            hash
        }
    }
    pub fn new_hash(hash: Hash) -> Self {
        ValidationInfo::FromHash { hash }
    }
    pub fn new_from_validation_program_hash_and_state(
        allocator: &mut AllocEncoder,
        validation_program_hash: Hash,
        game_state: NodePtr
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&validation_program_hash),
            Sha256Input::Hash(&Node(game_state).sha256tree(allocator).hash()),
        ]).hash();
        ValidationInfo::FromProgramHash {
            game_state,
            validation_program_hash,
            hash
        }
    }
    pub fn hash(&self) -> &Hash {
        match self {
            ValidationInfo::FromProgramHash { hash, .. } | ValidationInfo::FromProgram { hash, .. } | ValidationInfo::FromHash { hash } => &hash
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

    pub fn coin_string(&self) -> &CoinString { &self.state_channel_coin }
    pub fn to_coin_id(&self) -> CoinID { self.state_channel_coin.to_coin_id() }

    pub fn get_solution_and_signature_from_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        conditions: NodePtr,
        aggregate_public_key: &PublicKey,
    ) -> Result<(NodePtr, Aggsig), Error> {
        standard_solution_partial(
            env.allocator,
            &private_key,
            &self.state_channel_coin.to_coin_id(),
            conditions,
            &aggregate_public_key,
            &env.agg_sig_me_additional_data,
            true
        )
    }
}

#[derive(Default)]
pub struct ChannelCoinInfo {
    pub coin: Option<ChannelCoin>,
    pub amount: Amount,
    // Used in unrolling.
    pub spend: TransactionBundle,
}

pub struct UnrollCoinConditionInputs {
    pub ref_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub state_number: usize,
    pub my_balance: Amount,
    pub their_balance: Amount,
    pub puzzle_hashes_and_amounts: Vec<(PuzzleHash, Amount)>,
}

#[derive(Clone)]
pub struct UnrollCoinOutcome {
    pub conditions: NodePtr,
    pub conditions_without_hash: NodePtr,
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
/// or
/// - meta_puzzle conditions since conditions are passed through metapuzzle.
///
/// At the end of the day update and verify should produce the same conditions for
/// a specific generation and verify the same message.
#[derive(Default, Clone)]
pub struct UnrollCoin {
    pub started_with_potato: bool,
    // State number for unroll.
    // Always equal to or 1 less than the current state number.
    // Updated when potato arrives.
    pub state_number: usize,

    pub outcome: Option<UnrollCoinOutcome>,
}

// XXX bram: this can be removed.
#[deprecated]
fn prepend_default_conditions_hash<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    let conditions_hash = Node(conditions).sha256tree(env.allocator);
    let default_hash_rem = (REM, (conditions_hash, ()));
    (default_hash_rem, Node(conditions))
        .to_clvm(env.allocator)
        .into_gen()
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
    fn get_internal_conditions_for_unroll_coin_spend(&self) -> Result<NodePtr, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions_without_hash)
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
        state: usize,
    ) -> Result<NodePtr, Error> {
        let conditions_hash = self.get_conditions_hash_for_unroll_puzzle()?;
        let shared_puzzle_hash = puzzle_hash_for_pk(env.allocator, &aggregate_public_key)?;

        CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(shared_puzzle_hash.clone(), state, conditions_hash),
        }
        .to_clvm(env.allocator)
            .into_gen()
    }

    pub fn make_unroll_puzzle_solution<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        current_state_number: usize,
    ) -> Result<NodePtr, Error> {
        let unroll_inner_puzzle = env.unroll_metapuzzle.clone();
        let unroll_puzzle_solution = (
            unroll_inner_puzzle,
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
        inputs: &UnrollCoinConditionInputs
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
        prepend_rem_conditions(env, inputs.state_number, result_coins_node)
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
        let unroll_conditions = self.compute_unroll_coin_conditions(
            env,
            inputs,
        )?;
        let external_conditions = prepend_default_conditions_hash(env, unroll_conditions)?;
        let d = disassemble(
            env.allocator.allocator(),
            unroll_conditions,
            None
        );
        let conditions_hash = Node(unroll_conditions).sha256tree(env.allocator);
        let unroll_public_key = private_to_public_key(&unroll_private_key);
        let unroll_aggregate_key =
            unroll_public_key.clone() + their_unroll_coin_public_key.clone();
        let unroll_signature = unsafe_sign_partial(
            &unroll_private_key,
            &unroll_aggregate_key,
            &conditions_hash.bytes(),
        );
        self.outcome = Some(UnrollCoinOutcome {
            conditions: external_conditions,
            conditions_without_hash: unroll_conditions,
            hash: conditions_hash,
            signature: unroll_signature.clone()
        });

        eprintln!(
            "UNROLL UPDATE {}",
            disassemble(
                env.allocator.allocator(),
                unroll_conditions,
                None
            )
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
        let unroll_puzzle_solution_hash =
            Node(unroll_puzzle_solution).sha256tree(env.allocator);

        let aggregate_unroll_signature = signature.clone()
            + self.get_unroll_coin_signature()?;

        let mut message = unroll_puzzle_solution_hash.bytes().to_vec();

        Ok(aggregate_unroll_signature.verify(
            &aggregate_unroll_public_key,
            &message
        ))
    }
}
