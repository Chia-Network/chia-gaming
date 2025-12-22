use rand::prelude::*;

use rand::distributions::Standard;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{PotatoSignatures, UnrollCoin};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, Hash, PrivateKey, PublicKey, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};

/// These are the core secrets needed by the channel.
#[derive(Clone, Serialize, Deserialize)]
pub struct ChannelHandlerPrivateKeys {
    /// The channel coin is a standard coin (in that it isn't smart, it's just spendable with a specific
    /// signature).  Its job is to create the unroll coin at a particular unroll coin puzzle hash.
    ///
    /// The channel handshake ensures that the channel coin is created in a neutral state with the
    /// original inputs of mojo unallocated.
    ///
    /// The channel coin is spent with a combination of signatures generated from the two users' channel
    /// coin private keys.  In each channel handler message, the user that sent the message sends their
    /// own signature for the move before that, allowing that signature to be combined with the receiver's
    /// own signature over that move to be able to spend the channel coin at that point.  The receiver
    /// can test this by simulating a spend of the channel coin locally to ensure that the signature they
    /// received works.
    ///
    /// Because the startup includes two nil updates in a round trip, both sides have a default position
    /// from which they can spend the channel coin into the unroll coin if something goes wrong later.
    /// If nothing else works, the channel coin can be dissolved into an unroll coin tha represents the
    /// state of the channel handler before any actions were taken.
    pub my_channel_coin_private_key: PrivateKey,
    /// The unroll coin private key is this user's signature which when combined with the other user's
    /// signature will allow cooperative spends of the unroll coin.  Because each user has the ability
    /// to create the unroll coin at any state in the past, there is a time lock that allows the other
    /// user the ability to create it at a later time from their perspective (which eliminates the
    /// opponent's ability to permanently regress a move that wasn't good.
    pub my_unroll_coin_private_key: PrivateKey,
    /// When on chain, each game is separately represented by a referee coin.  The referee private key
    /// is used to communicate with it on our turn.  Except for timeout, the referee coin is driven by
    /// each user's referee private key separately.  The referee private key also sometimes is in
    /// command of standard coins emitted as a reward from a game that ended and must be moved to
    /// the user's own wallet.  In the future, this mechanism should become more flexible,
    /// allowing non-standard coins.
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

/// This represents the information needed to start a channel.
pub struct ChannelHandlerInitiationData {
    /// The parent coin of the channel coin, needed to create channel coin spends when we
    /// finish the channel or go on chain.
    pub launcher_coin_id: CoinID,
    /// Whether this is the A or B side of the channel.  A few important things are
    /// determined by this such as whether my state numbers are the odd or even ones.
    pub we_start_with_potato: bool,
    /// We must know the peer channel public key so we can make the aggregate public key
    /// to check signatures with.  The channel coin will use that aggregate public key
    /// (the sum of both users' channel public key) as the basis of its standard puzzle.
    pub their_channel_pubkey: PublicKey,
    /// We must know the public key associated with the other users' unroll private key
    /// so we can check a signature given to us.  The inner spend puzzle of the unroll
    /// coin, despite its extra logic is also a standard coin puzzle formed around the
    /// sum of the two public keys.
    pub their_unroll_pubkey: PublicKey,
    /// The puzzle has of a standard coin that responds to the opponent's referee private
    /// key is given here so we can use it to know the puzzle hash of a referee coin moving
    /// on to their turn.
    pub their_referee_puzzle_hash: PuzzleHash,
    /// If the channel coin is amicably dissolved, then this is the puzzle hash to which
    /// the opponent's share will be spent.
    pub their_reward_puzzle_hash: PuzzleHash,
    /// Record of how much my input coin gave the channel coin.
    pub my_contribution: Amount,
    /// Record of how much the opponent's coin gave the channel coin.
    pub their_contribution: Amount,
    /// The unroll coin waits a certain amount of time before becoming 'anyone spend' to
    /// unroll and create the referee coins when going on chain.  This is how many blocks
    /// the opponent of the user that created it will have to advance history to the last
    /// place it was agreed on at in case their opponent chose an earlier time.
    pub unroll_advance_timeout: Timeout,
    /// Our reward puzzle hash to spend our rewards to on an amicable shutdown.
    pub reward_puzzle_hash: PuzzleHash,
}

/// Indicate the earliest possible state of the channel coin and enough information to
/// continue the handshake.
#[derive(Clone)]
pub struct ChannelHandlerInitiationResult {
    /// The time 0 puzzle hash of the channel coin, to watch for creation on the blockchain.
    pub channel_puzzle_hash_up: PuzzleHash,
    /// My half of the signature to spend the channel coin at t0 and give the inputs back.
    pub my_initial_channel_half_signature_peer: Aggsig,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ChannelHandlerUnrollSpendInfo {
    /// Contains the half signature, puzzle and conditions needed to spend.
    pub coin: UnrollCoin,
    /// Contains the other half of the signature.
    pub signatures: PotatoSignatures,
}

/// A reason for a failed game start that is not a hard error causing us
/// to go on chain.  Any other conditions which cause a game not to start
/// but don't disturb the system state as a whole should be reported here.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum GameStartFailed {
    OutOfMoney,
}

/// A result indicating whether the system started the requested games
/// or not.
#[derive(Clone, Debug)]
pub enum StartGameResult {
    Failure(GameStartFailed),
    Success(Box<PotatoSignatures>),
}

/// A set of environmental inputs to channel handler.
///
/// These are neccessary things to know about the outside world and
/// how to operate in it as well as references to the mutable objects
/// that are canonically accessible to channel handler and the referee.
///
/// Bram's original design is OO first, so mutation runs fairly deep.
pub struct ChannelHandlerEnv<'a, R: Rng> {
    /// The clvm allocator.  It should be assumed to be ephemeral
    /// so descendants should not store NodePtrs that it returns,
    /// instead converting to and from Program and similar.
    pub allocator: &'a mut AllocEncoder,
    /// The rng to be used for the entropy data in a move.
    pub rng: &'a mut R,
    /// The unroll metapuzzle is the signature lock puzzle used by the
    /// unroll coin.  It emits a simple AGG_SIG_UNSAFE requirement for
    /// the unroll coin so that a spend for it can be requested by either
    /// party.
    pub unroll_metapuzzle: Puzzle,
    /// The unroll puzzle controls the user's ability to set the point
    /// in time from which spilling games on chain continues.  From
    /// whatever point it's created at, it allows the other player to
    /// update it to one of the opposite side future updates if one
    /// exists.  It has a time lock that allows for a certain amount
    /// of time before anyone can spend it to create the on chain games
    /// and to distribute the unallocated mojo in the channel.
    pub unroll_puzzle: Puzzle,

    /// This stores the referee puzzle for the 'v0' referee style, the
    /// original game interface which was written for chia-gaming.
    ///
    /// v0 games will eventually be removed but as some test
    /// infrastructure hasn't been ported forward, this is retained.
    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    /// This stores the referee puzzle for the 'v1' referee style, which
    /// was written in mid 2025.  Games should be written in v1 style
    /// until the change to introduce v2 style is done.
    pub referee_coin_puzzle_v1: Puzzle,
    pub referee_coin_puzzle_hash_v1: PuzzleHash,

    /// This stores the coin puzzle used for inner AGG_SIG_ME signature
    /// locks.  The channel code currently makes some not-completely
    /// necessary assumptions about the locks using the standard coin
    /// but a future revision should make that code more modular.
    ///
    /// In future this should be replaced with trait setting out the
    /// methods and lifecycle of the inner lock puzzle with enough
    /// generality to support other coin types such as nfts.
    pub standard_puzzle: Puzzle,

    /// This is the hash associated with each distinct chia chain.  It
    /// appears here to allow support for testnets, when implemented.
    pub agg_sig_me_additional_data: Hash,
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_v1: Puzzle,
        standard_puzzle: Puzzle,
        agg_sig_me_additional_data: Hash,
    ) -> ChannelHandlerEnv<'a, R> {
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        let referee_coin_puzzle_hash_v1 = referee_coin_puzzle_v1.sha256tree(allocator);
        ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            referee_coin_puzzle_v1,
            referee_coin_puzzle_hash_v1,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data,
        }
    }
}
