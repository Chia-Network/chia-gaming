use std::collections::VecDeque;

use clvmr::NodePtr;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerPrivateKeys, PotatoSignatures, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk};
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinString, Error, GameID, IntoErr, PublicKey, PuzzleHash, SpendBundle,
    Timeout, TransactionBundle,
};

struct LocalGameStart {}

struct RemoteGameStart {}

// struct GameInfoMyTurn {
//     id: GameID,
//     their_turn_game_handler: GameHandler,
//     validation_program: Program,
//     validation_program_hash: Hash,
//     state: NodePtr,
//     move_made: Vec<u8>,
//     max_move_size: usize,
//     mover_share: Amount,
// }

// struct GameInfoTheirTurn {
//     id: GameID,
//     their_turn_game_handler: GameHandler,
//     validation_program: Program,
//     validation_program_hash: Hash,
//     state: NodePtr,
//     move_made: Vec<u8>,
//     max_move_size: usize,
//     mover_share: Amount,
// }

/// Async interface for messaging out of the game layer toward the wallet.
///
/// For this and its companion if instances are left in the documentation which
/// refer to the potato handler combining spend bundles, that work has been decided
/// to not take place in the potato handler.  The injected wallet bootstrap
/// dependency must be stateful enough that it can cope with receiving a partly
/// funded offer spend bundle and fully fund it if needed.
pub trait BootstrapTowardGame {
    /// Gives a partly signed offer to the wallet bootstrap.
    ///
    /// Intended use: channel_puzzle_hash delivers the desired puzzle hash and this
    /// is the reply which delivers a transaction bundle for an already spent
    /// transaction creating the channel coin.
    ///
    /// The launcher program is passed a list of conditions and returns that list
    /// of conditions with an announcement including their shatree as an
    /// announcement.
    ///
    /// The launcher coin is implicit in the returned transaction bundle in that
    /// we can compute its coin string from this information.
    ///
    /// The launcher coin must be a specific program such as the singleton
    /// launcher.
    ///
    /// The launcher coin targets the channel puzzle with the right amount.
    ///
    /// "Half funded" transaction in a spend bundle to which spends will be
    /// added that fully fund it, condition on the given announcement named
    /// above by the launcher coin.
    ///
    /// The launcher coin will be in here so the other guy can pick it out and
    /// make the assumption that it is the launcher coin.  It is identifiable by
    /// its puzzle hash.
    ///
    /// We forward this spend bundle over a potato message and the peer passes
    /// it to the other guy's injected wallet dependency via received_channel_offer
    /// below.
    ///
    /// channel offer should deliver both the launcher coin id and the partly
    /// funded spend bundle.  Alice absolutely needs the channel coin id in some
    /// way from here.
    ///
    /// Only alice sends this spend bundle in message E, but only after receiving
    /// message D.
    fn channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error>;

    /// Gives the fully signed offer to the wallet bootstrap.
    /// Causes bob to send this spend bundle down the wire to the other peer.
    ///
    /// When these spend bundles are combined and deduplicated, together a
    /// fully spendble transaction will result, to which fee might need to be
    /// added.
    ///
    /// Alice sends this to the wallet interface via received_channel_transaction
    /// completion to finish this phase of execution.
    ///
    /// Bob receives this callback from the wallet interface with the fully funded
    /// but not fee adjusted spend bundle on bob's side.  It is given back to alice
    /// and must contain appropriate spends to generate the launcher coin
    /// announcement.
    ///
    /// This is sent back to alice as message F.
    ///
    /// Both alice and bob, upon knowing the full channel coin id, use the more
    /// general wallet interface to register for notifications of the channel coin.
    fn channel_transaction_completion(&mut self, bundle: &SpendBundle) -> Result<(), Error>;
}

/// Async interface implemented by Peer to receive notifications about wallet
/// state.
pub trait BootstrapTowardWallet {
    /// Deliver the channel_puzzle_hash to the wallet.
    ///
    /// Only alice calls this.  Bob does not need this information because the
    /// information needed will be held at the level of the injected object instead.
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error>;

    /// Tells the game layer that we received a partly funded offer to which we
    /// added our own coins and sent to the bootstrap wallet interface to use.
    /// We had previously received a partly funded spend bundle via the reply to
    /// channel_puzzle_hash,
    /// Should add a fee and try to spend.
    ///
    /// Asynchronously, channel_transaction_completion is delivered back to the
    /// potato handler.
    ///
    /// Only bob sends this, upon receiving message E, bob makes this call to
    /// inform the injected wallet bootstrap dependency that the spend bundle
    /// has been received (partly funded so far) and it is the job of the bootstrap
    /// wallet object injected dependency to finish funding this and actually
    /// spend it.
    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error>;

    /// Bob has sent this to us via the potato interface and it is given here to
    /// the wallet injected dependency to actually spend.  Alice must add a fee
    /// if needed.
    ///
    /// Both alice and bob, upon knowing the full channel coin id, use the more
    /// general wallet interface to register for notifications of the channel coin.
    fn received_channel_transaction_completion(
        &mut self,
        bundle: &SpendBundle,
    ) -> Result<(), Error>;
}

/// Spend wallet receiver
pub trait SpendWalletReceiver {
    fn coin_created(&mut self, coin_id: &CoinString) -> Result<(), Error>;
    fn coin_spent(&mut self, coin_id: &CoinString) -> Result<(), Error>;
    fn coin_timeout_reached(&mut self, coin_id: &CoinString) -> Result<(), Error>;
}

/// Unroll time wallet interface.
pub trait WalletSpendInterface {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error>;
}

#[allow(dead_code)]
pub struct GameType(Vec<u8>);

pub trait ToLocalUI {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_message(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error>;
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error>;

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error>;
    fn going_on_chain(&mut self) -> Result<(), Error>;
}

#[allow(dead_code)]
trait FromLocalUI {
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
    fn start_games(
        &mut self,
        i_initiated: bool,
        games: &[(GameType, bool, NodePtr)],
    ) -> Result<GameID, Error>;
    fn make_move(&mut self, id: GameID, readable: ReadableMove) -> Result<(), Error>;
    fn accept(&mut self, id: GameID) -> Result<(), Error>;
    fn shut_down(&mut self) -> Result<(), Error>;
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeA {
    parent: CoinString,
    channel_public_key: PublicKey,
    unroll_public_key: PublicKey,
    reward_puzzle_hash: PuzzleHash,
    referee_puzzle_hash: PuzzleHash,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    channel_public_key: PublicKey,
    unroll_public_key: PublicKey,
    reward_puzzle_hash: PuzzleHash,
    referee_puzzle_hash: PuzzleHash,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    // Fixed in order sequence
    HandshakeA(HandshakeA),
    HandshakeB(HandshakeB),

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
    PreInit,
    StepA,
    StepB(CoinString, HandshakeA),
    StepC {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    },
    StepD {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    },
    StepE {
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
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
    },
}

pub trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

pub struct PeerEnv<'a, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    pub env: &'a mut ChannelHandlerEnv<'a, R>,

    pub system_interface: &'a mut G,
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
#[allow(dead_code)]
pub struct Peer {
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
    pub fn new(
        have_potato: bool,
        private_keys: ChannelHandlerPrivateKeys,
        my_contribution: Amount,
        their_contribution: Amount,
        reward_puzzle_hash: PuzzleHash,
    ) -> Peer {
        Peer {
            have_potato,
            handshake_state: if have_potato {
                HandshakeState::PreInit
            } else {
                HandshakeState::StepA
            },

            their_start_queue: VecDeque::default(),
            my_start_queue: VecDeque::default(),

            channel_handler: None,

            private_keys,
            my_contribution,
            their_contribution,
            reward_puzzle_hash,
        }
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        if let Some(ch) = &mut self.channel_handler {
            Ok(ch)
        } else {
            Err(Error::StrErr("no channel handler".to_string()))
        }
    }

    pub fn start<G, R: Rng>(
        &mut self,
        penv: &mut PeerEnv<G, R>,
        parent_coin: CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let channel_public_key =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(penv.env.allocator, &referee_public_key)?;

        eprintln!("Start: our channel public key {:?}", channel_public_key);

        assert!(matches!(self.handshake_state, HandshakeState::PreInit));
        let my_hs_info = HandshakeA {
            parent: parent_coin.clone(),
            channel_public_key,
            unroll_public_key,
            reward_puzzle_hash: self.reward_puzzle_hash.clone(),
            referee_puzzle_hash,
        };
        self.handshake_state = HandshakeState::StepB(parent_coin, my_hs_info.clone());
        penv.system_interface
            .send_message(&PeerMessage::HandshakeA(my_hs_info))?;

        Ok(())
    }

    fn update_channel_coin_after_receive<G, R: Rng>(
        &mut self,
        _penv: &mut PeerEnv<G, R>,
        _spend: &ChannelCoinSpendInfo,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        todo!();
    }

    fn pass_on_channel_handler_message<G, R: Rng>(
        &mut self,
        penv: &mut PeerEnv<G, R>,
        msg: Vec<u8>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let ch = self.channel_handler_mut()?;

        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;

        eprintln!("msg {msg_envelope:?}");
        match msg_envelope {
            PeerMessage::Nil(n) => {
                eprintln!("about to receive empty potato");
                let spend_info = ch.received_empty_potato(penv.env, &n)?;
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            _ => {
                todo!();
            }
        }

        Ok(())
    }

    pub fn received_message<G, R: Rng>(
        &mut self,
        penv: &mut PeerEnv<G, R>,
        msg: Vec<u8>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        match &self.handshake_state {
            // non potato progression
            HandshakeState::StepA => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                eprintln!(
                    "StepA: their channel public key {:?}",
                    msg.channel_public_key
                );

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
                    their_referee_puzzle_hash: msg.referee_puzzle_hash.clone(),
                    my_contribution: self.my_contribution.clone(),
                    their_contribution: self.their_contribution.clone(),
                };
                let (channel_handler, _init_result) =
                    ChannelHandler::new(penv.env, self.private_keys.clone(), &init_data)?;

                // init_result
                // pub channel_puzzle_hash_up: PuzzleHash,
                // pub my_initial_channel_half_signature_peer: Aggsig,

                let channel_public_key =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let unroll_public_key =
                    private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash =
                    puzzle_hash_for_pk(penv.env.allocator, &referee_public_key)?;

                let our_handshake_data = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                self.channel_handler = Some(channel_handler);
                self.handshake_state = HandshakeState::StepC {
                    first_player_hs_info: msg,
                    second_player_hs_info: our_handshake_data.clone(),
                };

                // Factor out to one method.
                penv.system_interface
                    .send_message(&PeerMessage::HandshakeB(our_handshake_data))?;
            }

            HandshakeState::StepC { ..
                // first_player_hs_info,
                // second_player_hs_info,
            } => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let nil_msg = if let PeerMessage::Nil(nil_msg) = msg_envelope {
                    nil_msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                let ch = self.channel_handler_mut()?;
                ch.received_empty_potato(penv.env, &nil_msg)?;
                let nil_msg = ch.send_empty_potato(penv.env)?;

                penv.system_interface
                    .send_message(&PeerMessage::Nil(nil_msg))?;
            }

            // potato progression
            HandshakeState::StepB(parent_coin, my_hs_info) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                let init_data = ChannelHandlerInitiationData {
                    launcher_coin_id: parent_coin.to_coin_id(),
                    we_start_with_potato: true,
                    their_channel_pubkey: msg.channel_public_key.clone(),
                    their_unroll_pubkey: msg.unroll_public_key.clone(),
                    their_referee_puzzle_hash: msg.referee_puzzle_hash.clone(),
                    my_contribution: self.my_contribution.clone(),
                    their_contribution: self.their_contribution.clone(),
                };
                let (mut channel_handler, _init_result) =
                    ChannelHandler::new(penv.env, self.private_keys.clone(), &init_data)?;

                let nil_sigs = channel_handler.send_empty_potato(penv.env)?;

                self.channel_handler = Some(channel_handler);
                self.handshake_state = HandshakeState::StepD {
                    first_player_hs_info: my_hs_info.clone(),
                    second_player_hs_info: msg,
                };

                penv.system_interface
                    .send_message(&PeerMessage::Nil(nil_sigs))?;
            }

            HandshakeState::StepD { ..
                 // _first_player_hs_info,
                 // _second_player_hs_info,
            } => {
                self.pass_on_channel_handler_message(penv, msg)?;

                todo!();
                // self.handshake_state = HandshakeState::StepF {
                // first_player_hs_info: first_player_hs_info.clone(),
                // second_player_hs_info: second_player_hs_info.clone()
                // };

                // Outer layer already knows the launcher coin string.
                //
                // Provide the channel puzzle hash to the full node bootstrap and
                // it replies with the channel puzzle hash
                // penv.system_interface.send_message(&PeerMessage::HandshakeE {
                // bundle:
                // })?;
            }

            _ => {
                todo!();
            }
        }

        Ok(())
    }
}
