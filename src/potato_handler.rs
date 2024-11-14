use std::collections::{BTreeMap, VecDeque};
use std::mem::swap;

use clvm_traits::ToClvm;
use clvmr::serde::node_from_bytes;
use clvmr::{run_program, Allocator, NodePtr};

use log::debug;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::chia_dialect;
use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerPrivateKeys, FlatGameStartInfo, GameStartInfo, MoveResult, OnChainGameCoin,
    PotatoSignatures, PrintableGameStartInfo, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinID, CoinSpend, CoinString, Error, GameID,
    Hash, IntoErr, Node, Program, PublicKey, PuzzleHash, Sha256Input, Sha256tree, Spend, SpendBundle, Timeout,
};
use clvm_tools_rs::classic::clvm::sexp::proper_list;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStart {
    pub game_type: GameType,
    pub timeout: Timeout,
    pub amount: Amount,
    pub my_contribution: Amount,
    pub my_turn: bool,
    pub parameters: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireGameStart {
    pub game_ids: Vec<GameID>,
    pub start: GameStart,
}

#[derive(Debug, Clone)]
pub struct GameStartQueueEntry;

#[derive(Debug, Clone)]
pub struct MyGameStartQueueEntry {
    my_games: Vec<GameStartInfo>,
    their_games: Vec<GameStartInfo>,
}

/// Async interface for messaging out of the game layer toward the wallet.
///
/// For this and its companion if instances are left in the documentation which
/// refer to the potato handler combining spend bundles, that work has been decided
/// to not take place in the potato handler.  The injected wallet bootstrap
/// dependency must be stateful enough that it can cope with receiving a partly
/// funded offer spend bundle and fully fund it if needed.
pub trait BootstrapTowardGame<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
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
    fn channel_offer<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a;

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
    fn channel_transaction_completion<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: &SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a;
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
pub trait SpendWalletReceiver<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
    fn coin_created<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
    fn coin_spent<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
    fn coin_timeout_reached<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
    fn coin_puzzle_and_solution<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
}

/// Unroll time wallet interface.
pub trait WalletSpendInterface {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error>;

    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinString, timeout: &Timeout) -> Result<(), Error>;

    /// Request the puzzle and solution for a spent coin
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error>;
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, PartialOrd, Ord)]
pub struct GameType(pub Vec<u8>);

pub trait ToLocalUI {
    fn self_move(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
        Ok(())
    }
    fn opponent_moved(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error>;
    fn raw_game_message(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
        Ok(())
    }
    fn game_message(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error>;
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error>;
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error>;

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error>;
    fn going_on_chain(&mut self) -> Result<(), Error>;
}

pub trait FromLocalUI<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
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
    fn start_games<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>
    where
        G: 'a,
        R: 'a;

    fn make_move<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;

    fn accept<'a>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>, id: &GameID) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;

    fn shut_down<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        condition: NodePtr,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    channel_public_key: PublicKey,
    unroll_public_key: PublicKey,
    reward_puzzle_hash: PuzzleHash,
    referee_puzzle_hash: PuzzleHash,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeA {
    parent: CoinString,
    simple: HandshakeB,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    // Fixed in order sequence
    HandshakeA(HandshakeA),
    HandshakeB(HandshakeB),

    /// Includes spend of launcher coin id.
    HandshakeE {
        bundle: SpendBundle,
    },
    HandshakeF {
        bundle: SpendBundle,
    },

    Nil(PotatoSignatures),
    Move(GameID, MoveResult),
    Message(GameID, Vec<u8>),
    Accept(GameID, Amount, PotatoSignatures),
    Shutdown(Aggsig, Program),
    RequestPotato(()),
    StartGames(PotatoSignatures, Vec<FlatGameStartInfo>),
}

#[derive(Debug, Clone)]
pub struct HandshakeStepInfo {
    #[allow(dead_code)]
    pub first_player_hs_info: HandshakeA,
    #[allow(dead_code)]
    pub second_player_hs_info: HandshakeB,
}

#[derive(Debug, Clone)]
pub struct HandshakeStepWithSpend {
    #[allow(dead_code)]
    pub info: HandshakeStepInfo,
    #[allow(dead_code)]
    pub spend: SpendBundle,
}

#[derive(Debug)]
pub enum HandshakeState {
    StepA,
    StepB,
    StepC(CoinString, Box<HandshakeA>),
    StepD(Box<HandshakeStepInfo>),
    StepE(Box<HandshakeStepInfo>),
    PostStepE(Box<HandshakeStepInfo>),
    StepF(Box<HandshakeStepInfo>),
    PostStepF(Box<HandshakeStepInfo>),
    Finished(Box<HandshakeStepWithSpend>),
    // Going on chain ourselves route.
    OnChainTransition(CoinString, Box<HandshakeStepWithSpend>),
    OnChainWaitingForUnrollTimeoutOrSpend(CoinString, Box<HandshakeStepWithSpend>),
    // Other party went on chain, we're catching up route.
    OnChainWaitForConditions(CoinString, Box<HandshakeStepWithSpend>),
    // Converge here to on chain state.
    OnChainWaitingForUnrollSpend(CoinString),
    OnChain(CoinString, Box<HandshakeStepWithSpend>),
    WaitingForShutdown(CoinString, CoinString),
    Completed,
}

pub trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

pub trait PeerEnv<'inputs, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    fn env(&mut self) -> (&mut ChannelHandlerEnv<'inputs, R>, &mut G);
}

enum PotatoState {
    Absent,
    Requested,
    Present,
}

enum GameAction {
    Move(GameID, ReadableMove, Hash),
    Accept(GameID),
    Shutdown(NodePtr),
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
///
/// State machine surrounding game starts:
///
/// First peer receives game start from the ui
/// First peer tries to acquire the potato and when we have it, send a peer level start game
/// message.
/// First peer creates the game by giving channel_handler the game definitions.
/// second peer receives the game start from the first peer and stores it.
///
/// When the channel handler game start is reeived, we must receive a matching datum to
/// the one we receive in the channel handler game start.  If we receive that, we allow
/// the message through to the channel handler.
#[allow(dead_code)]
pub struct PotatoHandler {
    initiator: bool,
    have_potato: PotatoState,

    handshake_state: HandshakeState,

    // Waiting game starts at the peer level.
    their_start_queue: VecDeque<GameStartQueueEntry>,
    // Our outgoing game starts.
    my_start_queue: VecDeque<MyGameStartQueueEntry>,

    game_action_queue: VecDeque<GameAction>,

    next_game_id: Vec<u8>,

    channel_handler: Option<ChannelHandler>,
    channel_initiation_transaction: Option<SpendBundle>,
    channel_finished_transaction: Option<SpendBundle>,

    game_types: BTreeMap<GameType, Program>,

    private_keys: ChannelHandlerPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    waiting_to_start: bool,
    // This is also given to unroll coin to set a timelock based on it.
    // We'll be notified by the timeout handler when we can spend the unroll coin.
    channel_timeout: Timeout,
}

fn init_game_id(private_keys: &ChannelHandlerPrivateKeys) -> Vec<u8> {
    Sha256Input::Array(vec![
        Sha256Input::Bytes(&private_keys.my_channel_coin_private_key.bytes()),
        Sha256Input::Bytes(&private_keys.my_unroll_coin_private_key.bytes()),
        Sha256Input::Bytes(&private_keys.my_referee_private_key.bytes()),
    ])
    .hash()
    .bytes()
    .to_vec()
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
impl PotatoHandler {
    pub fn new(
        have_potato: bool,
        private_keys: ChannelHandlerPrivateKeys,
        game_types: BTreeMap<GameType, Program>,
        my_contribution: Amount,
        their_contribution: Amount,
        channel_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
    ) -> PotatoHandler {
        PotatoHandler {
            initiator: have_potato,
            have_potato: if have_potato {
                PotatoState::Present
            } else {
                PotatoState::Absent
            },
            handshake_state: if have_potato {
                HandshakeState::StepA
            } else {
                HandshakeState::StepB
            },

            next_game_id: Vec::new(),
            game_types,

            their_start_queue: VecDeque::default(),
            my_start_queue: VecDeque::default(),
            game_action_queue: VecDeque::default(),

            channel_handler: None,
            channel_initiation_transaction: None,
            channel_finished_transaction: None,

            waiting_to_start: true,

            private_keys,
            my_contribution,
            their_contribution,
            channel_timeout,
            reward_puzzle_hash,
        }
    }

    pub fn amount(&self) -> Amount {
        self.my_contribution.clone() + self.their_contribution.clone()
    }

    pub fn is_on_chain(&self) -> bool {
        matches!(
            self.handshake_state,
            HandshakeState::OnChainTransition(_, _) | HandshakeState::OnChain(_, _)
        )
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        if let Some(ch) = &self.channel_handler {
            Ok(ch)
        } else {
            Err(Error::StrErr("no channel handler".to_string()))
        }
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        if let Some(ch) = &mut self.channel_handler {
            Ok(ch)
        } else {
            Err(Error::StrErr("no channel handler".to_string()))
        }
    }

    pub fn handshake_finished(&self) -> bool {
        matches!(self.handshake_state, HandshakeState::Finished(_))
    }

    /// Tell whether this peer has the potato.  If it has been sent but not received yet
    /// then both will say false
    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn start<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &'a mut dyn PeerEnv<'a, G, R>,
        parent_coin: CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let (env, system_interface) = penv.env();
        let channel_public_key =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;

        debug!("Start: our channel public key {:?}", channel_public_key);

        assert!(matches!(self.handshake_state, HandshakeState::StepA));
        let my_hs_info = HandshakeA {
            parent: parent_coin.clone(),
            simple: HandshakeB {
                channel_public_key,
                unroll_public_key,
                reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                referee_puzzle_hash,
            },
        };
        self.handshake_state =
            HandshakeState::StepC(parent_coin.clone(), Box::new(my_hs_info.clone()));
        system_interface.send_message(&PeerMessage::HandshakeA(my_hs_info))?;

        Ok(())
    }

    fn update_channel_coin_after_receive<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        spend: &ChannelCoinSpendInfo,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        self.have_potato = PotatoState::Present;

        if self.have_potato_start_game(penv)? {
            return Ok(());
        }

        if self.have_potato_move(penv)? {
            return Ok(());
        }

        let (channel_coin, channel_public_key) = {
            let ch = self.channel_handler()?;
            let cc = ch.state_channel_coin().coin_string().clone();
            (cc, ch.get_aggregate_channel_public_key())
        };

        if let HandshakeState::Finished(hs) = &mut self.handshake_state {
            let (env, _) = penv.env();
            debug!("hs spend is {:?}", hs.spend);
            let channel_coin_puzzle = puzzle_for_synthetic_public_key(
                env.allocator,
                &env.standard_puzzle,
                &channel_public_key,
            )?;
            hs.spend.spends = vec![CoinSpend {
                coin: channel_coin,
                bundle: Spend {
                    solution: Program::from_nodeptr(env.allocator, spend.solution)?,
                    signature: spend.aggsig.clone(),
                    puzzle: channel_coin_puzzle,
                },
            }];
            debug!("updated spend to {:?}", hs.spend.spends[0]);
        }

        Ok(())
    }

    fn pass_on_channel_handler_message<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        msg: Vec<u8>,
    ) -> Result<Option<HandshakeState>, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let timeout = self.channel_timeout.clone();
        let ch = self.channel_handler_mut()?;

        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;

        debug!("msg {msg_envelope:?}");
        match msg_envelope {
            PeerMessage::Nil(n) => {
                debug!("about to receive empty potato");
                let spend_info = {
                    let (env, _system_interface) = penv.env();
                    ch.received_empty_potato(env, &n)?
                };
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Move(game_id, m) => {
                let (spend_info, readable_move, message) = {
                    let (env, _) = penv.env();
                    ch.received_potato_move(env, &game_id, &m)?
                };
                {
                    let (env, system_interface) = penv.env();
                    system_interface.opponent_moved(
                        env.allocator,
                        &game_id,
                        ReadableMove::from_nodeptr(readable_move),
                    )?;
                    if !message.is_empty() {
                        system_interface.send_message(&PeerMessage::Message(game_id, message))?;
                    }
                }
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let (env, _) = penv.env();
                    ch.received_message(env, &game_id, &message)?
                };

                let (env, system_interface) = penv.env();
                system_interface.raw_game_message(&game_id, &message)?;
                system_interface.game_message(env.allocator, &game_id, decoded_message)?;
                // Does not affect potato.
            }
            PeerMessage::Accept(game_id, amount, sigs) => {
                let spend_info = {
                    let (env, system_interface) = penv.env();
                    let result = ch.received_potato_accept(env, &sigs, &game_id)?;
                    system_interface.game_finished(&game_id, amount)?;
                    Ok(result)
                }?;
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Shutdown(sig, conditions) => {
                let coin = ch.state_channel_coin().coin_string();
                let (env, system_interface) = penv.env();
                let clvm_conditions = conditions.to_nodeptr(env.allocator)?;
                // conditions must have a reward coin targeted at our referee_public_key.
                // this is how we'll know we're being paid.
                let want_public_key = private_to_public_key(&ch.referee_private_key());
                let want_puzzle_hash = puzzle_hash_for_pk(env.allocator, &want_public_key)?;
                let want_amount = ch.clean_shutdown_amount();
                let condition_list = CoinCondition::from_nodeptr(env.allocator, clvm_conditions);
                let found_conditions = condition_list.iter().any(|cond| {
                    if let CoinCondition::CreateCoin(ph, amt) = cond {
                        *ph == want_puzzle_hash && *amt >= want_amount
                    } else {
                        false
                    }
                });

                if !found_conditions {
                    return Err(Error::StrErr(
                        "given conditions don't pay our referee puzzle hash what's expected"
                            .to_string(),
                    ));
                }

                let my_reward =
                    CoinString::from_parts(&coin.to_coin_id(), &want_puzzle_hash, &want_amount);
                system_interface.register_coin(&my_reward, &timeout)?;

                system_interface.register_coin(coin, &timeout)?;
                let full_spend = ch.received_potato_clean_shutdown(env, &sig, clvm_conditions)?;

                let solution = Program::from_nodeptr(env.allocator, full_spend.solution)?;
                let channel_puzzle_public_key = ch.get_aggregate_channel_public_key();
                let puzzle = puzzle_for_synthetic_public_key(
                    env.allocator,
                    &env.standard_puzzle,
                    &channel_puzzle_public_key,
                )?;
                system_interface.spend_transaction_and_add_fee(&SpendBundle {
                    spends: vec![CoinSpend {
                        coin: coin.clone(),
                        bundle: Spend {
                            solution,
                            puzzle,
                            signature: full_spend.signature.clone(),
                        },
                    }],
                })?;

                // Expected reward coin is shutdown amount + puzzle hash of referee
                // coin and parent is the reported reward coin.
                return Ok(Some(HandshakeState::WaitingForShutdown(
                    my_reward,
                    coin.clone(),
                )));
            }
            _ => {
                todo!("unhandled passthrough message {msg_envelope:?}");
            }
        }

        Ok(None)
    }

    pub fn try_complete_step_body<'a, G, R: Rng + 'a, F>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        ctor: F,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        F: FnOnce(&SpendBundle) -> Result<PeerMessage, Error>
    {
        if let Some(spend) = self.channel_initiation_transaction.as_ref() {
            self.handshake_state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend: spend.clone(),
            }));

            // Outer layer already knows the launcher coin string.
            //
            // Provide the channel puzzle hash to the full node bootstrap and
            // it replies with the channel puzzle hash
            {
                let (_env, system_interface) = penv.env();
                system_interface.send_message(&ctor(spend)?)?;
            }
        }

        Ok(())
    }


    pub fn try_complete_step_e<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        self.try_complete_step_body(
            penv,
            first_player_hs_info,
            second_player_hs_info,
            |spend| {
                Ok(PeerMessage::HandshakeE {
                    bundle: spend.clone(),
                })
            }
        )
    }

    pub fn try_complete_step_f<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        // Haven't got the channel coin yet.
        if self.waiting_to_start {
            debug!("waiting to start");
            return Ok(());
        }

        self.try_complete_step_body(
            penv,
            first_player_hs_info,
            second_player_hs_info,
            |spend| {
                Ok(PeerMessage::HandshakeF {
                    bundle: spend.clone(),
                })
            }
        )
    }

    // We have the potato so we can send a message that starts a game if there are games
    // to start.
    //
    // This returns bool so that it can be put into the receive potato pipeline so we
    // can automatically send new game starts on the next potato receive.
    fn have_potato_start_game<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let Some(desc) = self.my_start_queue.pop_front() {
            let mut dehydrated_games = Vec::new();

            let sigs = {
                let ch = self.channel_handler_mut()?;
                let (env, _) = penv.env();
                for game in desc.their_games.iter() {
                    dehydrated_games.push(game.to_serializable(env.allocator)?);
                }
                for game in desc.my_games.iter() {
                    debug!(
                        "using game {:?}",
                        PrintableGameStartInfo {
                            allocator: env.allocator.allocator(),
                            info: game
                        }
                    );
                }
                ch.send_potato_start_game(env, &desc.my_games)?
            };

            debug!("dehydrated_games {dehydrated_games:?}");
            let (_, system_interface) = penv.env();
            system_interface.send_message(&PeerMessage::StartGames(sigs, dehydrated_games))?;
            return Ok(true);
        }

        Ok(false)
    }

    fn have_potato_move<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        match self.game_action_queue.pop_front() {
            Some(GameAction::Move(game_id, readable_move, new_entropy)) => {
                let move_result = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    ch.send_potato_move(env, &game_id, &readable_move, new_entropy)?
                };

                let (_, system_interface) = penv.env();
                system_interface.self_move(&game_id, &move_result.game_move.basic.move_made)?;

                system_interface.send_message(&PeerMessage::Move(game_id, move_result))?;
                self.have_potato = PotatoState::Absent;

                Ok(true)
            }
            Some(GameAction::Accept(game_id)) => {
                let (sigs, amount) = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    ch.send_potato_accept(env, &game_id)?
                };

                let (_, system_interface) = penv.env();
                system_interface.send_message(&PeerMessage::Accept(
                    game_id.clone(),
                    amount.clone(),
                    sigs,
                ))?;
                self.have_potato = PotatoState::Absent;
                system_interface.game_finished(&game_id, amount)?;

                Ok(true)
            }
            Some(GameAction::Shutdown(conditions)) => {
                let timeout = self.channel_timeout.clone();
                let (state_channel_coin, spend, want_puzzle_hash, want_amount) = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    let spend = ch.send_potato_clean_shutdown(env, conditions)?;

                    // conditions must have a reward coin targeted at our referee_public_key.
                    // this is how we'll know we're being paid.
                    let want_public_key = private_to_public_key(&ch.referee_private_key());
                    let want_puzzle_hash = puzzle_hash_for_pk(env.allocator, &want_public_key)?;
                    let want_amount = ch.clean_shutdown_amount();
                    (
                        ch.state_channel_coin().coin_string(),
                        spend,
                        want_puzzle_hash,
                        want_amount,
                    )
                };

                let my_reward = CoinString::from_parts(
                    &state_channel_coin.to_coin_id(),
                    &want_puzzle_hash,
                    &want_amount,
                );

                let (env, system_interface) = penv.env();
                system_interface.register_coin(&my_reward, &timeout)?;
                self.handshake_state =
                    HandshakeState::WaitingForShutdown(my_reward, state_channel_coin.clone());

                // If the state channel coin is spent, then we signal full shutdown.
                let shutdown_condition_program = Program::from_nodeptr(env.allocator, conditions)?;
                system_interface.send_message(&PeerMessage::Shutdown(
                    spend.signature.clone(),
                    shutdown_condition_program,
                ))?;

                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn get_games_by_start_type<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        game_start: &GameStart,
    ) -> Result<(Vec<GameStartInfo>, Vec<GameStartInfo>), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let starter = if let Some(starter) = self.game_types.get(&game_start.game_type) {
            starter
        } else {
            return Err(Error::StrErr(format!(
                "no such game {:?}",
                game_start.game_type
            )));
        };

        let (env, _) = penv.env();
        let starter_clvm = starter.to_clvm(env.allocator).into_gen()?;
        let params_clvm =
            node_from_bytes(env.allocator.allocator(), &game_start.parameters).into_gen()?;
        let program_run_args = (
            game_start.amount.clone(),
            (game_start.my_contribution.clone(), (Node(params_clvm), ())),
        )
            .to_clvm(env.allocator)
            .into_gen()?;

        let program_output = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            starter_clvm,
            program_run_args,
            0,
        )
        .into_gen()?
        .1;

        let to_list =
            |allocator: &mut Allocator, node: NodePtr, err: &str| -> Result<Vec<NodePtr>, Error> {
                if let Some(p) = proper_list(allocator, node, true) {
                    Ok(p)
                } else {
                    Err(Error::StrErr(format!("bad factory output: {err}")))
                }
            };

        // The result is two parallel lists of opposite sides of game starts.
        // Well re-glue these together into a list of pairs.
        let pair_of_output_lists = to_list(
            env.allocator.allocator(),
            program_output,
            "not a pair of lists",
        )?;

        if pair_of_output_lists.len() != 2 {
            return Err(Error::StrErr("output wasn't a list of 2 items".to_string()));
        }

        let my_info_list = to_list(
            env.allocator.allocator(),
            pair_of_output_lists[0],
            "not a list (first)",
        )?;
        let their_info_list = to_list(
            env.allocator.allocator(),
            pair_of_output_lists[1],
            "not a list (second)",
        )?;

        if their_info_list.len() != my_info_list.len() {
            return Err(Error::StrErr(
                "mismatched my and their game starts".to_string(),
            ));
        }

        let mut game_ids = Vec::new();
        for _ in my_info_list.iter() {
            game_ids.push(self.next_game_id()?);
        }

        let convert_info_list = |allocator: &mut AllocEncoder,
                                 my_turn: bool,
                                 my_info_list: &[NodePtr]|
         -> Result<Vec<GameStartInfo>, Error> {
            let mut result_start_info = Vec::new();
            for (i, node) in my_info_list.iter().enumerate() {
                let new_game = GameStartInfo::from_clvm(allocator, my_turn, *node)?;
                // Timeout and game_id are supplied here.
                result_start_info.push(GameStartInfo {
                    game_id: game_ids[i].clone(),
                    timeout: game_start.timeout.clone(),
                    ..new_game
                });
            }
            Ok(result_start_info)
        };

        let my_result_start_info = convert_info_list(env.allocator, true, &my_info_list)?;
        let their_result_start_info = convert_info_list(env.allocator, false, &their_info_list)?;

        Ok((my_result_start_info, their_result_start_info))
    }

    fn request_potato<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if matches!(self.have_potato, PotatoState::Requested) {
            return Ok(());
        }

        debug!("requesting potato");

        let (_, system_interface) = penv.env();
        system_interface.send_message(&PeerMessage::RequestPotato(()))?;
        self.have_potato = PotatoState::Requested;
        Ok(())
    }

    fn next_game_id(&mut self) -> Result<GameID, Error> {
        if self.next_game_id.is_empty() {
            return Err(Error::StrErr("no game id set".to_string()));
        }

        let game_id = self.next_game_id.clone();
        for b in self.next_game_id.iter_mut() {
            *b += 1;

            if *b != 0 {
                break;
            }
        }

        Ok(GameID::from_bytes(&game_id))
    }

    fn received_game_start<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        sigs: &PotatoSignatures,
        games: &[FlatGameStartInfo],
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        // We must have received a peer layer message indicating that we're waiting for this
        // game start.
        if self.their_start_queue.pop_front().is_none() {
            return Err(Error::StrErr("no waiting games to start".to_string()));
        };

        let ch = self.channel_handler_mut()?;
        let spend_info = {
            let (env, _system_interface) = penv.env();
            let mut rehydrated_games = Vec::new();
            for game in games.iter() {
                let new_rehydrated_game = GameStartInfo::from_serializable(env.allocator, game)?;
                let re_dehydrated = new_rehydrated_game.to_serializable(env.allocator)?;
                assert_eq!(&re_dehydrated, game);
                debug!(
                    "their game {:?}",
                    PrintableGameStartInfo {
                        allocator: env.allocator.allocator(),
                        info: &new_rehydrated_game
                    }
                );
                rehydrated_games.push(new_rehydrated_game);
            }
            ch.received_potato_start_game(env, sigs, &rehydrated_games)?
        };

        self.update_channel_coin_after_receive(penv, &spend_info)?;

        Ok(())
    }

    pub fn received_message<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        msg: Vec<u8>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;

        let make_channel_handler_initiation =
            |parent: CoinID, start_potato, msg: &HandshakeB| ChannelHandlerInitiationData {
                launcher_coin_id: parent,
                we_start_with_potato: start_potato,
                their_channel_pubkey: msg.channel_public_key.clone(),
                their_unroll_pubkey: msg.unroll_public_key.clone(),
                their_referee_puzzle_hash: msg.referee_puzzle_hash.clone(),
                my_contribution: self.my_contribution.clone(),
                their_contribution: self.their_contribution.clone(),
                unroll_advance_timeout: self.channel_timeout.clone(),
            };

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

                debug!(
                    "StepA: their channel public key {:?}",
                    msg.simple.channel_public_key
                );

                todo!();
            }

            HandshakeState::StepC(parent_coin, handshake_a) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                // XXX Call the UX saying the channel coin has been created
                // and play can happen.
                // Register the channel coin in the bootstrap provider.
                // Situation:
                // Before we've got notification of the channel coin, it's possible
                // alice will get a potato from bob or bob a request from alice.
                //
                // That should halt for the channel coin notifiation.
                let init_data =
                    make_channel_handler_initiation(parent_coin.to_coin_id(), false, &msg);
                let (mut channel_handler, _init_result) = {
                    let (env, _system_interface) = penv.env();
                    ChannelHandler::new(env, self.private_keys.clone(), &init_data)?
                };

                let channel_coin = channel_handler.state_channel_coin();
                let channel_puzzle_hash =
                    if let Some((_, puzzle_hash, _)) = channel_coin.coin_string().to_parts() {
                        puzzle_hash
                    } else {
                        return Err(Error::StrErr(
                            "could not understand channel coin parts".to_string(),
                        ));
                    };

                // Send the boostrap wallet interface the channel puzzle hash to use.
                // it will reply at some point with the channel offer.
                {
                    let (_env, system_interface) = penv.env();
                    system_interface.channel_puzzle_hash(&channel_puzzle_hash)?;
                    system_interface
                        .register_coin(channel_coin.coin_string(), &self.channel_timeout)?;
                };

                let channel_public_key =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let unroll_public_key =
                    private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash = {
                    let (env, _system_interface) = penv.env();
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?
                };

                let our_handshake_data = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                {
                    let (env, system_interface) = penv.env();
                    let nil_msg = channel_handler.send_empty_potato(env)?;
                    system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                }

                self.next_game_id = init_game_id(&self.private_keys);
                self.channel_handler = Some(channel_handler);

                self.handshake_state = HandshakeState::StepE(Box::new(HandshakeStepInfo {
                    first_player_hs_info: *handshake_a.clone(),
                    second_player_hs_info: our_handshake_data.clone(),
                }));
            }

            HandshakeState::StepE(info) => {
                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepE(info.clone());

                self.pass_on_channel_handler_message(penv, msg)?;

                self.try_complete_step_e(penv, first_player_hs, second_player_hs)?;
            }

            // potato progression
            HandshakeState::StepB => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                let init_data =
                    make_channel_handler_initiation(msg.parent.to_coin_id(), true, &msg.simple);
                let (channel_handler, _init_result) = {
                    let (env, _system_interface) = penv.env();
                    ChannelHandler::new(env, self.private_keys.clone(), &init_data)?
                };

                let channel_public_key =
                    private_to_public_key(&channel_handler.channel_private_key());
                let unroll_public_key =
                    private_to_public_key(&channel_handler.unroll_private_key());
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash = {
                    let (env, _system_interface) = penv.env();
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?
                };

                let my_hs_info = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                self.next_game_id = init_game_id(&self.private_keys);
                self.channel_handler = Some(channel_handler);
                self.handshake_state = HandshakeState::StepD(Box::new(HandshakeStepInfo {
                    first_player_hs_info: msg.clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));

                {
                    let (_env, system_interface) = penv.env();
                    system_interface.send_message(&PeerMessage::HandshakeB(my_hs_info))?;
                }
            }

            HandshakeState::StepD(info) => {
                self.handshake_state = HandshakeState::StepF(info.clone());

                self.pass_on_channel_handler_message(penv, msg)?;

                let ch = self.channel_handler_mut()?;
                {
                    let (env, system_interface) = penv.env();
                    let nil_msg = ch.send_empty_potato(env)?;
                    system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                }
            }

            HandshakeState::StepF(info) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let bundle = if let PeerMessage::HandshakeE { bundle } = msg_envelope {
                    bundle
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake e message, got {msg_envelope:?}"
                    )));
                };

                let channel_coin = {
                    let ch = self.channel_handler()?;
                    ch.state_channel_coin()
                };

                debug!("PH: channel_coin {:?}", channel_coin.coin_string());

                {
                    let (_env, system_interface) = penv.env();
                    if bundle.spends.is_empty() {
                        return Err(Error::StrErr(
                            "No spends to draw the channel coin from".to_string(),
                        ));
                    }

                    // Ensure we're watching for this coin.
                    system_interface
                        .register_coin(channel_coin.coin_string(), &self.channel_timeout)?;

                    system_interface.received_channel_offer(&bundle)?;
                }

                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepF(info.clone());

                self.have_potato = PotatoState::Absent;
                self.try_complete_step_f(penv, first_player_hs, second_player_hs)?;
            }

            HandshakeState::Finished(_) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;

                debug!("running: got message {:?}", msg_envelope);

                match msg_envelope {
                    PeerMessage::HandshakeF { bundle } => {
                        self.channel_finished_transaction = Some(bundle.clone());
                        let (_, system_interface) = penv.env();
                        system_interface.received_channel_offer(&bundle)?;
                    }
                    PeerMessage::RequestPotato(_) => {
                        {
                            let (env, system_interface) = penv.env();
                            let ch = self.channel_handler_mut()?;
                            let nil_msg = ch.send_empty_potato(env)?;
                            system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                        }
                        self.have_potato = PotatoState::Absent;
                    }
                    PeerMessage::StartGames(sigs, g) => {
                        self.received_game_start(penv, &sigs, &g)?;
                    }
                    _ => {
                        self.pass_on_channel_handler_message(penv, msg)?;
                    }
                }

                return Ok(());
            }

            _ => {
                return Err(Error::StrErr(format!(
                    "should not receive message in state {:?}",
                    self.handshake_state
                )));
            }
        }

        Ok(())
    }

    // Tell whether the channel coin was spent in a way that requires us potentially to
    // fast forward games using interactions with their on-chain coin forms.
    fn check_unroll_spent<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let Some(ch) = self.channel_handler.as_ref() {
            let channel_coin = ch.state_channel_coin();
            if coin_id == channel_coin.coin_string() {
                // Channel coin was spent so we're going on chain.
                let mut hs = HandshakeState::StepA;
                swap(&mut hs, &mut self.handshake_state);
                match hs {
                    HandshakeState::OnChainTransition(cs, t) => {
                        debug!("notified of channel coin spend in on chain transition state");
                        return Ok(true);
                    }
                    HandshakeState::Finished(hs) => {
                        debug!("notified of channel coin spend in run state");
                        self.handshake_state = HandshakeState::OnChainWaitForConditions(
                            channel_coin.coin_string().clone(),
                            hs,
                        );
                        let (_, system_interface) = penv.env();
                        system_interface.request_puzzle_and_solution(coin_id)?;
                        return Ok(true);
                    }
                    _ => {
                        return Err(Error::StrErr(
                            "channel coin spend in non-handshake state".to_string(),
                        ));
                    }
                }
            }
        }

        Ok(false)
    }

    pub fn do_channel_spend_to_unroll<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        spend: Box<HandshakeStepWithSpend>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (env, system_interface) = penv.env();
        let player_ch = self.channel_handler()?;
        // Channel coin
        let finished_unroll_coin = player_ch.get_unroll_coin();
        let pre_unroll_data = player_ch.get_create_unroll_coin_transaction(env, &finished_unroll_coin, false)?;
        debug!(
            "channel unroll to on chain puzzle: {}",
            pre_unroll_data.transaction.puzzle.to_hex()
        );
        debug!(
            "unroll to on chain solution: {}",
            pre_unroll_data.transaction.solution.to_hex()
        );

        let run_puzzle = pre_unroll_data
            .transaction
            .puzzle
            .to_clvm(env.allocator)
            .into_gen()?;
        let run_args = pre_unroll_data
            .transaction
            .solution
            .to_clvm(env.allocator)
            .into_gen()?;
        let puzzle_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        let condition_list = CoinCondition::from_nodeptr(env.allocator, puzzle_result.1);
        let unroll_result = if let Some(unroll_coin) = condition_list
            .iter()
            .filter_map(|cond| {
                if let CoinCondition::CreateCoin(ph, amt) = cond {
                    if *amt > Amount::default() {
                        return Some(CoinString::from_parts(&player_ch.state_channel_coin().to_coin_id(), ph, amt));
                    }
                }

                None
            })
            .next()
        {
            unroll_coin.clone()
        } else {
            return Err(Error::StrErr("no unroll coin created".to_string()));
        };

        // We have everything needed so let's register for the spend
        self.handshake_state =
            HandshakeState::OnChainWaitingForUnrollTimeoutOrSpend(unroll_result.clone(), spend);

        // We'll wait for the unroll result to be spent, which means we're on chain.
        system_interface.register_coin(&unroll_result, &self.channel_timeout)?;
        // The coin outputs represent the ongoing games if any and the reward coins.
        let ch = self.channel_handler_mut()?;
        let coins = ch.get_game_coins(env)?;
        debug!("game coins {coins:?}");

        Ok(())
    }

    pub fn do_unroll_spend_to_games<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        unroll_coin: &CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (env, system_interface) = penv.env();
        let player_ch = self.channel_handler()?;
        // Channel coin
        let finished_unroll_coin = player_ch.get_unroll_coin();
        let pre_unroll_data = player_ch.get_create_unroll_coin_transaction(env, &finished_unroll_coin, false)?;
        debug!(
            "unroll to on chain puzzle: {}",
            pre_unroll_data.transaction.puzzle.to_hex()
        );
        debug!(
            "unroll to on chain solution: {}",
            pre_unroll_data.transaction.solution.to_hex()
        );

        let run_puzzle = pre_unroll_data
            .transaction
            .puzzle
            .to_clvm(env.allocator)
            .into_gen()?;
        let run_args = pre_unroll_data
            .transaction
            .solution
            .to_clvm(env.allocator)
            .into_gen()?;
        let puzzle_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;

        let condition_list = CoinCondition::from_nodeptr(env.allocator, puzzle_result.1);
        let unroll_result = if let Some(unroll_coin) = condition_list
            .iter()
            .filter_map(|cond| {
                if let CoinCondition::CreateCoin(ph, amt) = cond {
                    if *amt > Amount::default() {
                        return Some(CoinString::from_parts(&unroll_coin.to_coin_id(), ph, amt));
                    }
                }

                None
            })
            .next()
        {
            unroll_coin.clone()
        } else {
            return Err(Error::StrErr("no unroll coin created".to_string()));
        };

        system_interface.spend_transaction_and_add_fee(&SpendBundle {
            spends: vec![CoinSpend {
                bundle: pre_unroll_data.transaction.clone(),
                coin: unroll_coin.clone(),
            }]
        })?;

        // We have everything needed so let's register for the spend
        self.handshake_state =
            HandshakeState::OnChainWaitingForUnrollSpend(unroll_result.clone());
        // We'll wait for the unroll result to be spent, which means we're on chain.
        system_interface.register_coin(&unroll_result, &self.channel_timeout)?;

        Ok(())
    }

    /// Short circuit to go on chain.
    /// We'll use the current state as we know it to go on chain and launch a transaction
    /// to update to the current move.
    ///
    /// This should also be used if a timeout is encountered or if we receive an error back
    /// from any off chain activity while consuming the peer's message.
    pub fn go_on_chain<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let mut hs_state = HandshakeState::StepA;
        swap(&mut hs_state, &mut self.handshake_state);
        if let HandshakeState::Finished(t) = hs_state {
            self.do_channel_spend_to_unroll(penv, t)
        } else {
            self.handshake_state = hs_state;
            Err(Error::StrErr(
                "go on chain before handshake finished".to_string(),
            ))
        }
    }

    fn do_game_action<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        action: GameAction,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(
                "move without finishing handshake".to_string(),
            ));
        }

        self.game_action_queue.push_back(action);

        if !matches!(self.have_potato, PotatoState::Present) {
            self.request_potato(penv)?;
            return Ok(());
        }

        self.have_potato_move(penv)?;

        Ok(())
    }

    fn handle_channel_coin_spent<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr(
                "Retrieve of puzzle and solution failed for channel coin".to_string(),
            ));
        };

        let ch = self.channel_handler_mut()?;
        let (env, system_interface) = penv.env();
        let run_puzzle = puzzle.to_nodeptr(env.allocator)?;
        let run_args = solution.to_nodeptr(env.allocator)?;
        let conditions = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        let cs_spend_result = ch.channel_coin_spent(env, conditions.1)?;
        debug!("cs_spend_result {cs_spend_result:?}");

        // Respond to getting this result by spending the unroll coin
        // We need to know what the unroll coin would be.  We'll interpret the conditions
        // and find out.
        let unroll_coin_string =
            if let Some(created_unroll_coin) =
            CoinCondition::from_nodeptr(env.allocator, conditions.1).iter().filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    // assert_eq!(ph, &cs_spend_result.transaction.puzzle.sha256tree(env.allocator));
                    Some(CoinString::from_parts(&coin_id.to_coin_id(), ph, amt))
                } else {
                    None
                }
            }).next() {
                created_unroll_coin
            } else {
                return Err(Error::StrErr("no conditions parsed".to_string()));
            };

        debug!("unroll_coin_string {unroll_coin_string:?}");
        system_interface.spend_transaction_and_add_fee(&SpendBundle {
            spends: vec![CoinSpend {
                coin: unroll_coin_string,
                bundle: cs_spend_result.transaction.clone()
            }]
        })?;

        Ok(())
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    FromLocalUI<G, R> for PotatoHandler
{
    fn start_games<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        R: 'a,
    {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "start games without finishing handshake: {:?}",
                self.handshake_state
            )));
        }

        let (my_games, their_games) = self.get_games_by_start_type(penv, game)?;

        let game_id_list = my_games.iter().map(|g| g.game_id.clone()).collect();

        // This comes to both peers before any game start happens.
        // In the didn't initiate scenario, we hang onto the game start to ensure that
        // we know what we're receiving from the remote end.
        if i_initiated {
            self.my_start_queue.push_back(MyGameStartQueueEntry {
                my_games,
                their_games,
            });

            if !matches!(self.have_potato, PotatoState::Present) {
                self.request_potato(penv)?;
                return Ok(game_id_list);
            }

            self.have_potato_start_game(penv)?;
        } else {
            // All checking needed is done by channel handler.
            self.their_start_queue.push_back(GameStartQueueEntry);
        }

        Ok(game_id_list)
    }

    fn make_move<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        self.do_game_action(
            penv,
            GameAction::Move(id.clone(), readable.clone(), new_entropy),
        )
    }

    fn accept<'a>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>, id: &GameID) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        self.do_game_action(penv, GameAction::Accept(id.clone()))
    }

    fn shut_down<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        conditions: NodePtr,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(
                "shut_down without finishing handshake".to_string(),
            ));
        }

        self.do_game_action(penv, GameAction::Shutdown(conditions))
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    BootstrapTowardGame<G, R> for PotatoHandler
{
    fn channel_offer<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a,
    {
        self.channel_initiation_transaction = Some(bundle);

        debug!("channel offer: {:?}", self.handshake_state);
        if let HandshakeState::PostStepE(info) = &self.handshake_state {
            self.try_complete_step_e(
                penv,
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
        }

        Ok(())
    }

    fn channel_transaction_completion<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: &SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a,
    {
        self.channel_finished_transaction = Some(bundle.clone());

        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            self.try_complete_step_f(
                penv,
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
        }

        Ok(())
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    SpendWalletReceiver<G, R> for PotatoHandler
{
    fn coin_created<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        // When the channel coin is created, we know we can proceed in playing the game.
        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            let channel_coin_created = self
                .channel_handler()
                .ok()
                .map(|ch| ch.state_channel_coin().coin_string());

            debug!("checking created coin {coin:?} vs expected {channel_coin_created:?}");
            if let Some(_coin) = channel_coin_created {
                self.waiting_to_start = false;
                self.try_complete_step_f(
                    penv,
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?;
            }
        }

        if let Some(reward) =
            if let HandshakeState::WaitingForShutdown(reward, _state) = &self.handshake_state {
                Some(reward.clone())
            } else {
                None
            }
        {
            if reward == *coin {
                // We have the expected reward coin.
                self.handshake_state = HandshakeState::Completed;
                let (_, system_interface) = penv.env();
                system_interface.shutdown_complete(&reward)?;
            }
        }

        Ok(())
    }

    fn coin_spent<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        if let Some((reward, state_coin)) =
            if let HandshakeState::WaitingForShutdown(reward, coin) = &self.handshake_state {
                Some((reward.clone(), coin.clone()))
            } else {
                None
            }
        {
            if *coin_id == state_coin {
                if let Some((_parent, _ph, amount)) = reward.to_parts() {
                    if amount == Amount::default() {
                        // 0 reward so spending the state channel coin means the game is over.
                        self.handshake_state = HandshakeState::Completed;
                        let (_, system_interface) = penv.env();
                        system_interface.shutdown_complete(&reward)?;
                    }
                }

                // We're in shutdown state so we're waiting for our reward coin to appear.
                return Ok(());
            }
        }

        self.check_unroll_spent(penv, coin_id)?;

        Ok(())
    }

    fn coin_timeout_reached<'a>(
        &mut self,
        _penv: &mut dyn PeerEnv<'a, G, R>,
        _coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        // We should be in state OnChainWaitingForUnrollTimeoutOrSpend
        // We'll spend the unroll coin via do_unroll_spend_to_games with the default
        // reveal and go to OnChainWaitingForUnrollSpend, transitioning to OnChain when
        // we receive the unroll coin spend.
        todo!();
    }

    fn coin_puzzle_and_solution<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        let state_coin_id = if let HandshakeState::OnChainWaitForConditions(state_coin_id, _data) =
            &self.handshake_state
        {
            state_coin_id.clone()
        } else {
            return Ok(());
        };

        if *coin_id == state_coin_id {
            return self.handle_channel_coin_spent(penv, coin_id, puzzle_and_solution);
        }

        Ok(())
    }
}
