use std::collections::VecDeque;

use rand::Rng;
use serde::{Deserialize, Serialize};
use clvmr::NodePtr;

use crate::common::types::{Aggsig, Amount, CoinID, CoinString, Error, GameID, Hash, Program, PuzzleHash, Timeout, TransactionBundle, PublicKey, IntoErr};
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{ChannelHandlerEnv, PotatoSignatures, ReadableMove, ChannelHandlerPrivateKeys, ChannelHandlerInitiationData};
use crate::channel_handler::ChannelHandler;

struct LocalGameStart {
}

struct RemoteGameStart {
}

struct GameInfoMyTurn {
    id: GameID,
    their_turn_game_handler: GameHandler,
    validation_program: Program,
    validation_program_hash: Hash,
    state: NodePtr,
    move_made: Vec<u8>,
    max_move_size: usize,
    mover_share: Amount,
}

struct GameInfoTheirTurn {
    id: GameID,
    their_turn_game_handler: GameHandler,
    validation_program: Program,
    validation_program_hash: Hash,
    state: NodePtr,
    move_made: Vec<u8>,
    max_move_size: usize,
    mover_share: Amount,
}

/// Bootstrap wallet receiver
trait BootstrapWalletReceiver {
    fn received_channel_offer(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
    fn received_channel_transaction_completion(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
}

/// Async device for querying the wallet and the block chain at bootstrap time.
trait WalletBootstrap {
    /// Deliver the channel_puzzle_hash to the outer layer.
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error>;

    /// Out
    fn channel_offer(&mut self) -> Result<TransactionBundle, Error>;

    /// Out
    fn channel_transaction_completion(&mut self) -> Result<TransactionBundle, Error>;
}

/// Spend wallet receiver
trait SpendWalletReceiver {
    fn coin_created(&mut self, coin_id: &CoinString) -> Result<(), Error>;
    fn coin_spent(&mut self, coin_id: &CoinString) -> Result<(), Error>;
    fn coin_timeout_reached(&mut self, coin_id: &CoinString) -> Result<(), Error>;
}

/// Unroll time wallet interface.
trait WalletSpendInterface {
    fn spend_transaction_and_add_fee(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error>;
}

struct GameType(Vec<u8>);

trait UIReceiver {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_message(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error>;
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error>;

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error>;
    fn going_on_chain(&mut self) -> Result<(), Error>;
}

trait GameUI {
    /// Start games requires queueing so that we handle them one at a time only
    /// when the previous start game.
    ///
    /// Queue of games we want to start that are also waiting after this.
    ///
    /// We must request the potato if not had.
    ///
    /// General flow:
    ///
    /// Have queues of games we're starting and other side is starting.
    ///
    fn start_games(&mut self, i_initiated: bool, games: &[(GameType, bool, NodePtr)]) -> Result<GameID, Error>;
    fn make_move(&mut self, id: GameID, readable: ReadableMove) -> Result<(), Error>;
    fn accept(&mut self, id: GameID) -> Result<(), Error>;
    fn shut_down(&mut self) -> Result<(), Error>;
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HandshakeA {
    parent: CoinString,
    channel_public_key: PublicKey,
    unroll_public_key: PublicKey,
    reward_puzzle_hash: PuzzleHash,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HandshakeB {
    channel_public_key: PublicKey,
    unroll_public_key: PublicKey,
    reward_puzzle_hash: PuzzleHash,
    my_initial_channel_half_signature_peer: Aggsig,
}

#[derive(Serialize, Deserialize)]
pub enum PeerMessage {
    // Fixed in order sequence
    HandshakeA(HandshakeA),
    HandshakeB(HandshakeB),

    // HandshakeC and HandshakeD are Nil messages.

    /// Includes spend of launcher coin id.
    HandshakeE {
        bundle: TransactionBundle,
    },
    HandshakeF {
        bundle: TransactionBundle,
    },

    Nil(PotatoSignatures),
    Move(GameID, Vec<u8>, PotatoSignatures),
    Accept(GameID, PotatoSignatures),
    DataMessage(GameID, Vec<u8>),
    Shutdown(Aggsig),
    RequestPotato,
}

pub enum HandshakeState {
    Start,
    StepA,
    StepB(HandshakeA),
    StepC {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB
    },
    StepD {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB
    },
    StepE {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB
    },
    StepF {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        channel_initiation_offer: TransactionBundle,
    },
    Finished {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        channel_initiation_transaction: TransactionBundle,
    }
}

trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

struct PeerEnv<'a, G, WS, WB, PS, R>
where
    G: GameUI,
    WS: WalletSpendInterface,
    WB: WalletBootstrap,
    PS: PacketSender,
    R: Rng
{
    env: ChannelHandlerEnv<'a, R>,

    ui_holder: G,

    wallet_spend_interface: WS,

    wallet_bootstrap: WB,

    packet_sender: PS
}

/// Handle potato in flight when I request potato:
///
/// Every time i send the potato, if i have stuff i want to do, then i also send
/// the request potato message directly after so I can be prompted to take another
/// thing off.
///
/// General workflow:
///
/// Whenever we receive the potato, check the work queues, notify channel handler,
/// then take the channel handler result with the potato and send it on.
///
/// If there is more work left, also send a receive potato message at that time.
///
/// Also do this when any queue becomes non-empty.
struct Peer {
    have_potato: bool,

    handshake_state: HandshakeState,

    their_start_queue: VecDeque<RemoteGameStart>,
    my_start_queue: VecDeque<LocalGameStart>,

    channel_handler: Option<ChannelHandler>,

    private_keys: ChannelHandlerPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,
}

/// Peer interface for high level opaque messages.
///
/// ch1 has generated public key and passed that info via handshake a message to
/// peer 2 into ch2.
/// When alice gets message b, she sends a nil potato.
/// and at the same time calls up the stack, telling the owner "here is the initial
/// channel public key".
///
/// bob is going to do the same thing when he gets message b.
///
/// Alice is just going to get a message back from her peer after giving the
/// channel public key (finished aggregating).
///
/// Alice forgets the channel offer after sending it to bob (received via received_channel_offer from the wallet bootstrap object).
/// Bob receivs channel offer then is given the transaction completion by watching
/// the blockchain.
///
/// Alice sends the "received channel transaction completion" message.
///
/// once this object knows the channel puzzle hash they should register the coin.
impl Peer {
    pub fn received_message<G, WS, WB, PS, R: Rng>(
        &mut self,
        penv: &mut PeerEnv<G, WS, WB, PS, R>,
        msg: Vec<u8>
    ) -> Result<(), Error>
    where
        G: GameUI,
        WS: WalletSpendInterface,
        WB: WalletBootstrap,
        PS: PacketSender,
    {
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        match &self.handshake_state {
            HandshakeState::Start => {
                todo!();
            }
            HandshakeState::StepA => {
                let msg: HandshakeA = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                // XXX Call the UX saying the channel coin has been created
                // and play can happen.
                // Register the channel coin in the bootstrap provider.
                // Situation:
                // Before we've got notification of the channel coin, it's possible
                // alice will get a potato from bob or bob a request from alice.
                //
                // That should halt for the channel coin notifiation.
                let init_data = ChannelHandlerInitiationData {
                    launcher_coin_id: msg.parent.to_coin_id(),
                    we_start_with_potato: false,
                    their_channel_pubkey: msg.channel_public_key.clone(),
                    their_unroll_pubkey: msg.unroll_public_key.clone(),
                    their_referee_puzzle_hash: penv.env.referee_coin_puzzle_hash.clone(),
                    my_contribution: self.my_contribution.clone(),
                    their_contribution: self.their_contribution.clone(),
                };
                let (channel_handler, init_result) = ChannelHandler::new(
                    &mut penv.env,
                    self.private_keys.clone(),
                    &init_data
                )?;

                // init_result
                // pub channel_puzzle_hash_up: PuzzleHash,
                // pub my_initial_channel_half_signature_peer: Aggsig,

                let channel_public_key = channel_handler.get_aggregate_channel_public_key();
                let unroll_public_key = channel_handler.get_aggregate_unroll_public_key();


                let our_handshake_data = HandshakeB {
                    my_initial_channel_half_signature_peer: init_result.my_initial_channel_half_signature_peer.clone(),
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                };

                self.channel_handler = Some(channel_handler);
                self.handshake_state = HandshakeState::StepC {
                    first_player_hs_info: msg,
                    second_player_hs_info: our_handshake_data.clone(),
                };

                // Factor out to one method.
                self.have_potato = false;
                penv.packet_sender.send_message(&PeerMessage::HandshakeB(our_handshake_data))?;

                Ok(())
            }
            _ => {
                todo!();
            }
        }
    }
}
