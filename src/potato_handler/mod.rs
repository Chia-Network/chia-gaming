use std::borrow::Borrow;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::mem::swap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{run_program, Allocator, NodePtr};

use log::debug;
use rand::Rng;

use serde::{Serialize, Deserialize};
use serde_json_any_key::*;

use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerInitiationData, ChannelHandlerPrivateKeys, GameStartInfo,
    GameStartInfoInterface, PotatoSignatures, ReadableMove,
};
use crate::channel_handler::v1;
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{
    chia_dialect, AllocEncoder, Amount, CoinCondition, CoinID, CoinSpend, CoinString, Error,
    GameID, GetCoinStringParts, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256Input,
    Sha256tree, Spend, SpendBundle, Timeout
};
use crate::utils::proper_list;

use crate::potato_handler::on_chain::OnChainPotatoHandler;
use crate::shutdown::{get_conditions_with_channel_handler, ShutdownConditions};

use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, ConditionWaitKind, FromLocalUI, GameAction,
    GameFactory, GameStart, GameStartQueueEntry, GameType, HandshakeA, HandshakeB, HandshakeState,
    HandshakeStepInfo, HandshakeStepWithSpend, MyGameStartQueueEntry, PacketSender, PeerEnv,
    PeerMessage, PotatoHandlerImpl, PotatoHandlerInit, PotatoState, ShutdownActionHolder,
    SpendWalletReceiver, ToLocalUI, WalletSpendInterface, GSI,
};

pub mod on_chain;
pub mod types;

pub type GameStartInfoPair = (
    Vec<Rc<dyn GameStartInfoInterface>>,
    Vec<Rc<dyn GameStartInfoInterface>>,
);

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
#[derive(Serialize, Deserialize)]
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

    #[serde(with = "any_key_map")]
    game_types: BTreeMap<GameType, GameFactory>,

    private_keys: ChannelHandlerPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    waiting_to_start: bool,
    // This is also given to unroll coin to set a timelock based on it.
    // We'll be notified by the timeout handler when we can spend the unroll coin.
    channel_timeout: Timeout,
    // Unroll timeout
    unroll_timeout: Timeout,

    my_game_spends: HashSet<PuzzleHash>,
    incoming_messages: VecDeque<Rc<PeerMessage>>,
}

fn init_game_id(parent_coin_string: &[u8]) -> Vec<u8> {
    Sha256Input::Bytes(parent_coin_string)
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
    pub fn new(phi: PotatoHandlerInit) -> PotatoHandler {
        PotatoHandler {
            initiator: phi.have_potato,
            have_potato: if phi.have_potato {
                PotatoState::Present
            } else {
                PotatoState::Absent
            },
            handshake_state: if phi.have_potato {
                HandshakeState::StepA
            } else {
                HandshakeState::StepB
            },

            game_types: phi.game_types,

            their_start_queue: VecDeque::default(),
            my_start_queue: VecDeque::default(),
            game_action_queue: VecDeque::default(),

            next_game_id: Vec::new(),

            channel_handler: None,
            channel_initiation_transaction: None,
            channel_finished_transaction: None,

            waiting_to_start: true,

            private_keys: phi.private_keys,
            my_contribution: phi.my_contribution,
            their_contribution: phi.their_contribution,
            channel_timeout: phi.channel_timeout,
            unroll_timeout: phi.unroll_timeout,
            reward_puzzle_hash: phi.reward_puzzle_hash,
            my_game_spends: HashSet::default(),
            incoming_messages: VecDeque::default(),
        }
    }

    pub fn amount(&self) -> Amount {
        self.my_contribution.clone() + self.their_contribution.clone()
    }

    pub fn is_on_chain(&self) -> bool {
        matches!(self.handshake_state, HandshakeState::OnChain(_))
    }

    pub fn handshake_done(&self) -> bool {
        !matches!(
            self.handshake_state,
            HandshakeState::StepA
                | HandshakeState::StepB
                | HandshakeState::StepC(_, _)
                | HandshakeState::StepD(_)
                | HandshakeState::StepE(_)
                | HandshakeState::PostStepE(_)
                | HandshakeState::StepF(_)
                | HandshakeState::PostStepF(_)
        )
    }

    pub fn examine_game_action_queue<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut dyn Iterator<Item = &GameAction>) -> R,
    {
        let mut iter = self.game_action_queue.iter();
        f(&mut iter)
    }

    pub fn examine_incoming_messages<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut dyn Iterator<Item = Rc<PeerMessage>>) -> R,
    {
        let mut iter = self.incoming_messages.iter().cloned();
        f(&mut iter)
    }

    pub fn push_action(&mut self, action: GameAction) {
        debug!("pushed action {action:?}");
        self.game_action_queue.push_back(action);
    }

    pub fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        if let HandshakeState::OnChain(ocs) = &self.handshake_state {
            return ocs.my_move_in_game(game_id);
        }

        if let Ok(ch) = self.channel_handler() {
            return ch.game_is_my_turn(game_id);
        }

        None
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        if let Some(ch) = &self.channel_handler {
            return Ok(ch);
        }

        if let HandshakeState::OnChain(on_chain) = &self.handshake_state {
            return Ok(on_chain.channel_handler());
        }

        Err(Error::StrErr("no channel handler".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        if let Some(ch) = &mut self.channel_handler {
            return Ok(ch);
        }

        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            return Ok(on_chain.channel_handler_mut());
        }

        Err(Error::StrErr("no channel handler".to_string()))
    }

    pub fn handshake_finished(&self) -> bool {
        matches!(
            self.handshake_state,
            HandshakeState::Finished(_) | HandshakeState::OnChain(_)
        )
    }

    /// Tell whether this peer has the potato.  If it has been sent but not received yet
    /// then both will say false
    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn get_reward_puzzle_hash<'a, G, R: Rng + 'a>(
        &self,
        penv: &'a mut dyn PeerEnv<'a, G, R>,
    ) -> Result<PuzzleHash, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let player_ch = self.channel_handler()?;
        let (env, _) = penv.env();
        player_ch.get_reward_puzzle_hash(env)
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
                referee_puzzle_hash,
                reward_puzzle_hash: self.reward_puzzle_hash.clone(),
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
                    solution: spend.solution.clone().into(),
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
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Option<HandshakeState>, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let timeout = self.channel_timeout.clone();
        let ch = self.channel_handler_mut()?;

        debug!("msg {msg_envelope:?}");
        match msg_envelope.borrow() {
            PeerMessage::Nil(n) => {
                debug!("about to receive empty potato");
                let spend_info = {
                    let (env, _system_interface) = penv.env();
                    ch.received_empty_potato(env, n)?
                };
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Move(game_id, m) => {
                let move_result = {
                    let (env, _) = penv.env();
                    ch.received_potato_move(env, game_id, m)?
                };
                {
                    let (env, system_interface) = penv.env();
                    let opponent_readable =
                        ReadableMove::from_program(move_result.readable_their_move);
                    system_interface.opponent_moved(
                        env.allocator,
                        game_id,
                        move_result.state_number,
                        opponent_readable,
                        move_result.mover_share,
                    )?;
                    if !move_result.message.is_empty() {
                        system_interface.send_message(&PeerMessage::Message(
                            game_id.clone(),
                            move_result.message,
                        ))?;
                    }
                }
                self.update_channel_coin_after_receive(penv, &move_result.spend_info)?;
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let (env, _) = penv.env();
                    ch.received_message(env, game_id, message)?
                };

                let (env, system_interface) = penv.env();
                system_interface.raw_game_message(game_id, message)?;
                system_interface.game_message(env.allocator, game_id, decoded_message)?;
                // Does not affect potato.
            }
            PeerMessage::Accept(game_id, amount, sigs) => {
                let spend_info = {
                    let (env, system_interface) = penv.env();
                    let result = ch.received_potato_accept(env, sigs, game_id)?;
                    system_interface.game_finished(game_id, amount.clone())?;
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
                let want_puzzle_hash = ch.get_reward_puzzle_hash(env)?;
                let want_amount = ch.clean_shutdown_amount();
                if want_amount != Amount::default() {
                    let condition_list =
                        CoinCondition::from_nodeptr(env.allocator, clvm_conditions);
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
                }

                let my_reward =
                    CoinString::from_parts(&coin.to_coin_id(), &want_puzzle_hash, &want_amount);
                system_interface.register_coin(&my_reward, &timeout, Some("reward"))?;

                system_interface.register_coin(coin, &timeout, Some("parent"))?;
                let full_spend = ch.received_potato_clean_shutdown(env, sig, clvm_conditions)?;

                let channel_puzzle_public_key = ch.get_aggregate_channel_public_key();
                let puzzle = puzzle_for_synthetic_public_key(
                    env.allocator,
                    &env.standard_puzzle,
                    &channel_puzzle_public_key,
                )?;
                let spend = Spend {
                    solution: full_spend.solution.clone(),
                    puzzle,
                    signature: full_spend.signature.clone(),
                };
                system_interface.spend_transaction_and_add_fee(&SpendBundle {
                    name: Some("Create unroll".to_string()),
                    spends: vec![CoinSpend {
                        coin: coin.clone(),
                        bundle: spend,
                    }],
                })?;

                self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(coin.clone());
            }
            _ => {
                return Err(Error::StrErr(format!(
                    "unhandled passthrough message {msg_envelope:?}"
                )));
            }
        }

        Ok(None)
    }

    pub fn try_complete_step_body<'a, G, R: Rng + 'a, F>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        maybe_transaction: Option<SpendBundle>,
        ctor: F,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        F: FnOnce(&SpendBundle) -> Result<PeerMessage, Error>,
    {
        if let Some(spend) = maybe_transaction {
            // Outer layer already knows the launcher coin string.
            //
            // Provide the channel puzzle hash to the full node bootstrap and
            // it replies with the channel puzzle hash
            {
                let (_env, system_interface) = penv.env();
                system_interface.send_message(&ctor(&spend)?)?;
            }

            self.handshake_state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend,
            }));
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
            self.channel_initiation_transaction.clone(),
            |spend| {
                Ok(PeerMessage::HandshakeE {
                    bundle: spend.clone(),
                })
            },
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

        debug!("starting");
        self.try_complete_step_body(
            penv,
            first_player_hs_info,
            second_player_hs_info,
            self.channel_finished_transaction.clone(),
            |spend| {
                Ok(PeerMessage::HandshakeF {
                    bundle: spend.clone(),
                })
            },
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
        debug!(
            "have potato start game: my queue length {}",
            self.my_start_queue.len()
        );
        if let Some(desc) = self.my_start_queue.pop_front() {
            let mut dehydrated_games = Vec::new();

            let sigs = {
                let ch = self.channel_handler_mut()?;
                let (env, _) = penv.env();
                for game in desc.their_games.iter() {
                    debug!("their game {:?}", game);
                    dehydrated_games.push(game.clone());
                }
                for game in desc.my_games.iter() {
                    debug!("using game {:?}", game);
                }
                let unwrapped_games: Vec<Rc<dyn GameStartInfoInterface>> = desc.my_games.iter().map(|g| g.0.clone()).collect();
                ch.send_potato_start_game(env, &unwrapped_games)?
            };

            debug!("dehydrated_games {dehydrated_games:?}");
            self.have_potato = PotatoState::Absent;
            let (_, system_interface) = penv.env();
            system_interface.send_message(&PeerMessage::StartGames(sigs, dehydrated_games))?;
            return Ok(true);
        }

        debug!("have_potato_start_game: no games in queue");
        Ok(false)
    }

    fn send_potato_request_if_needed<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if matches!(self.have_potato, PotatoState::Present) {
            debug!(
                "don't send a potato request because have_potato is {:?}",
                self.have_potato
            );
            return Ok(true);
        }

        if matches!(self.have_potato, PotatoState::Absent) {
            let (_, system_interface) = penv.env();
            system_interface.send_message(&PeerMessage::RequestPotato(()))?;
            self.have_potato = PotatoState::Requested;
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
        let action = self.game_action_queue.pop_front();
        debug!("have_potato_move, dequeue {action:?}");
        match action {
            Some(GameAction::LocalStartGame) => {
                self.have_potato_start_game(penv)?;
                Ok(true)
            }
            Some(GameAction::Move(game_id, readable_move, new_entropy)) => {
                assert!(matches!(self.have_potato, PotatoState::Present));
                let move_result = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    debug!("our turn in game {game_id:?}: {game_is_my_turn:?}");
                    if let Some(true) = game_is_my_turn {
                        debug!("have_potato_move, send to channel handler {game_id:?} {readable_move:?}");
                        ch.send_potato_move(env, &game_id, &readable_move, new_entropy)?
                    } else {
                        debug!("have_potato_move, not my turn {game_id:?} {readable_move:?}");
                        self.game_action_queue.push_front(GameAction::Move(
                            game_id,
                            readable_move,
                            new_entropy,
                        ));
                        return Ok(false);
                    }
                };

                let (_, system_interface) = penv.env();
                debug!("have_potato_move: self move notify {move_result:?}");
                system_interface.self_move(
                    &game_id,
                    move_result.state_number,
                    &move_result.game_move.basic.move_made,
                )?;

                debug!("have_potato_move: send move message");
                system_interface.send_message(&PeerMessage::Move(game_id, move_result))?;
                self.have_potato = PotatoState::Absent;

                Ok(true)
            }
            Some(GameAction::RedoMoveV0(_game_id, _coin, _new_ph, _transaction)) => {
                Err(Error::StrErr("redo move when not on chain".to_string()))
            }
            Some(GameAction::RedoMoveV1(_game_id, _coin, _new_ph, _transaction, _)) => {
                Err(Error::StrErr("redo move when not on chain".to_string()))
            }
            Some(GameAction::RedoAccept(_, _, _, _)) => {
                Err(Error::StrErr("redo accept when not on chain".to_string()))
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
                let real_conditions = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    get_conditions_with_channel_handler(env, ch, conditions.0.borrow())?
                };
                let (state_channel_coin, spend, want_puzzle_hash, want_amount) = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    let spend = ch.send_potato_clean_shutdown(env, real_conditions)?;

                    // conditions must have a reward coin targeted at our referee_public_key.
                    // this is how we'll know we're being paid.
                    let want_puzzle_hash = ch.get_reward_puzzle_hash(env)?;
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
                system_interface.register_coin(&my_reward, &timeout, Some("reward"))?;

                // If the state channel coin is spent, then we signal full shutdown.
                let shutdown_condition_program =
                    Rc::new(Program::from_nodeptr(env.allocator, real_conditions)?);
                system_interface.send_message(&PeerMessage::Shutdown(
                    spend.signature.clone(),
                    shutdown_condition_program.into(),
                ))?;

                self.handshake_state =
                    HandshakeState::OnChainWaitingForUnrollSpend(state_channel_coin.clone());

                Ok(true)
            }
            Some(GameAction::SendPotato) => {
                let (env, system_interface) = penv.env();
                let ch = self.channel_handler_mut()?;
                let nil_msg = ch.send_empty_potato(env)?;
                system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                self.have_potato = PotatoState::Absent;
                Ok(false)
            }
            None => Ok(false),
        }
    }

    fn start_version_0<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game_start: &GameStart,
        starter_clvm: NodePtr,
        params_clvm: NodePtr,
    ) -> Result<GameStartInfoPair, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (env, _) = penv.env();
        let program_run_args = (
            i_initiated,
            (
                game_start.my_contribution.clone(),
                (
                    game_start.amount.clone() - game_start.my_contribution.clone(),
                    (Node(params_clvm), ()),
                ),
            ),
        )
            .to_clvm(env.allocator)
            .into_gen()?;

        debug!("running program to get game start");
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

        let game_ids = [game_start.game_id.clone()];
        let convert_info_list = |allocator: &mut AllocEncoder,
                                 my_info_list: &[NodePtr]|
         -> Result<Vec<Rc<dyn GameStartInfoInterface>>, Error> {
            let mut result_start_info: Vec<Rc<dyn GameStartInfoInterface>> = Vec::new();
            for (i, node) in my_info_list.iter().enumerate() {
                let new_game = GameStartInfo::from_clvm(allocator, *node)?;
                // Timeout and game_id are supplied here.
                result_start_info.push(Rc::new(GameStartInfo {
                    game_id: game_ids[i].clone(),
                    timeout: game_start.timeout.clone(),
                    ..new_game
                }));
            }
            Ok(result_start_info)
        };

        let my_result_start_info = convert_info_list(env.allocator, &my_info_list)?;
        let their_result_start_info = convert_info_list(env.allocator, &their_info_list)?;

        Ok((my_result_start_info, their_result_start_info))
    }

    fn start_version_1<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game_start: &GameStart,
        program: Rc<Program>,
        params: Rc<Program>,
    ) -> Result<GameStartInfoPair, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (env, _) = penv.env();
        let their_contribution = game_start.amount.clone() - game_start.my_contribution.clone();
        let program_run_args = (
            game_start.my_contribution.clone(),
            (their_contribution.clone(), (params.clone(), ())),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        let params_prog = Rc::new(Program::from_nodeptr(env.allocator, program_run_args)?);
        let alice_game = v1::game::Game::new_program(
            env.allocator,
            i_initiated,
            &game_start.game_id,
            program.clone().into(),
            params_prog.clone(),
        )?;
        let alice_result: Vec<Rc<dyn GameStartInfoInterface>> = alice_game
            .starts
            .iter()
            .map(|g| {
                let rc: Rc<dyn GameStartInfoInterface> = Rc::new(g.game_start(
                    &game_start.game_id,
                    &game_start.amount,
                    &game_start.timeout,
                    &game_start.my_contribution,
                    &their_contribution,
                ));
                rc
            })
            .collect();
        let bob_game = v1::game::Game::new_program(
            env.allocator,
            !i_initiated,
            &game_start.game_id,
            program.into(),
            params_prog,
        )?;
        let bob_result: Vec<Rc<dyn GameStartInfoInterface>> = bob_game
            .starts
            .iter()
            .map(|g| {
                let rc: Rc<dyn GameStartInfoInterface> = Rc::new(g.game_start(
                    &game_start.game_id,
                    &game_start.amount,
                    &game_start.timeout,
                    &their_contribution,
                    &game_start.my_contribution,
                ));
                rc
            })
            .collect();
        Ok((alice_result, bob_result))
    }

    fn get_games_by_start_type<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game_start: &GameStart,
    ) -> Result<GameStartInfoPair, Error>
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

        if starter.version == 0 {
            let (starter_clvm, params_clvm) = {
                let (env, _) = penv.env();
                let starter_clvm = starter.program.to_clvm(env.allocator).into_gen()?;
                let params_clvm = game_start.parameters.to_clvm(env.allocator).into_gen()?;
                (starter_clvm, params_clvm)
            };

            self.start_version_0(penv, i_initiated, game_start, starter_clvm, params_clvm)
        } else {
            let params = Rc::new(game_start.parameters.clone());
            self.start_version_1(
                penv,
                i_initiated,
                game_start,
                starter.program.clone(),
                params,
            )
        }
    }

    pub fn next_game_id(&mut self) -> Result<GameID, Error> {
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
        games: &[GSI],
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        // We must have received a peer layer message indicating that we're waiting for this
        // game start.
        let our_game_ids =
            if let Some(GameStartQueueEntry(game_ids)) = self.their_start_queue.pop_front() {
                game_ids
            } else {
                return Err(Error::StrErr("no waiting games to start".to_string()));
            };
        let game_id_set: HashSet<&GameID> = our_game_ids.iter().collect();
        debug!("game start queue: {game_id_set:?}");

        let ch = self.channel_handler_mut()?;
        let spend_info = {
            let (env, _system_interface) = penv.env();
            let mut rehydrated_games = Vec::new();
            for game in games.iter() {
                debug!("their game {:?} {:?}", game.0.game_id(), game);
                rehydrated_games.push(game.0.clone());
            }
            let (game_ids, spend_info) =
                ch.received_potato_start_game(env, sigs, &rehydrated_games)?;
            debug!("game_ids from channel handler {game_ids:?}");

            if game_ids.len() != our_game_ids.len() {
                return Err(Error::StrErr(format!(
                    "wrong number of game_ids {game_ids:?} vs {our_game_ids:?}"
                )));
            }

            for g in game_ids.iter() {
                if !game_id_set.contains(g) {
                    return Err(Error::StrErr(format!("channel handler got a game id that didn't match one of the game ids we predicted {:?}", g)));
                }
            }

            spend_info
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
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        self.incoming_messages.push_back(Rc::new(msg_envelope));
        self.process_incoming_message(penv)?;
        while let Some(action) = self.game_action_queue.pop_front() {
            if !self.do_game_action(penv, action)? {
                break;
            }
        }

        Ok(())
    }

    pub fn process_incoming_message<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let msg_envelope = if let Some(msg) = self.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(());
        };

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
                their_reward_puzzle_hash: msg.reward_puzzle_hash.clone(),
                reward_puzzle_hash: self.reward_puzzle_hash.clone(),
            };

        match &self.handshake_state {
            // non potato progression
            HandshakeState::StepA => {
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope.borrow() {
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
            }

            HandshakeState::StepC(parent_coin, handshake_a) => {
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope.borrow() {
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
                    make_channel_handler_initiation(parent_coin.to_coin_id(), false, msg);
                let (mut channel_handler, _init_result) = {
                    let (env, _system_interface) = penv.env();
                    ChannelHandler::new(env, self.private_keys.clone(), &init_data)?
                };

                let channel_coin = channel_handler.state_channel_coin();
                let (_, channel_puzzle_hash, _) =
                    channel_coin.coin_string().get_coin_string_parts()?;

                // Send the boostrap wallet interface the channel puzzle hash to use.
                // it will reply at some point with the channel offer.
                {
                    let (_env, system_interface) = penv.env();
                    system_interface.channel_puzzle_hash(&channel_puzzle_hash)?;
                    system_interface.register_coin(
                        channel_coin.coin_string(),
                        &self.channel_timeout,
                        Some("channel"),
                    )?;
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

                self.next_game_id = init_game_id(parent_coin.to_bytes());
                debug!("StepC next game id {:?}", self.next_game_id);
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

                self.pass_on_channel_handler_message(penv, msg_envelope)?;

                self.try_complete_step_e(penv, first_player_hs, second_player_hs)?;
            }

            // potato progression
            HandshakeState::StepB => {
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope.borrow() {
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
                let parent_coin = info.first_player_hs_info.parent.clone();
                self.handshake_state = HandshakeState::StepF(info.clone());

                self.next_game_id = init_game_id(parent_coin.to_bytes());
                debug!("StepD next game id {:?}", self.next_game_id);

                self.pass_on_channel_handler_message(penv, msg_envelope)?;

                let ch = self.channel_handler_mut()?;
                {
                    let (env, system_interface) = penv.env();
                    let nil_msg = ch.send_empty_potato(env)?;
                    system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                }
            }

            HandshakeState::StepF(info) => {
                let bundle = if let PeerMessage::HandshakeE { bundle } = msg_envelope.borrow() {
                    bundle
                } else {
                    self.incoming_messages.push_front(msg_envelope.clone());
                    return Ok(());
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
                    system_interface.register_coin(
                        channel_coin.coin_string(),
                        &self.channel_timeout,
                        Some("channel"),
                    )?;

                    system_interface.received_channel_offer(bundle)?;
                }

                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepF(info.clone());

                self.have_potato = PotatoState::Absent;
                self.try_complete_step_f(penv, first_player_hs, second_player_hs)?;
            }

            HandshakeState::Finished(_) => {
                debug!("running: got message {:?}", msg_envelope);
                match msg_envelope.borrow() {
                    PeerMessage::HandshakeF { bundle } => {
                        self.channel_finished_transaction = Some(bundle.clone());
                        let (_, system_interface) = penv.env();
                        system_interface.received_channel_offer(bundle)?;
                    }
                    PeerMessage::RequestPotato(_) => {
                        if matches!(self.have_potato, PotatoState::Present) {
                            self.do_game_action(penv, GameAction::SendPotato)?;
                        } else {
                            self.push_action(GameAction::SendPotato);
                        }
                    }
                    PeerMessage::StartGames(sigs, g) => {
                        self.received_game_start(penv, sigs, g)?;
                    }
                    _ => {
                        self.pass_on_channel_handler_message(penv, msg_envelope)?;
                    }
                }

                return Ok(());
            }

            _ => {
                let (handshake_actions, game_actions): (
                    Vec<Rc<PeerMessage>>,
                    Vec<Rc<PeerMessage>>,
                ) = self
                    .incoming_messages
                    .iter()
                    .cloned()
                    .partition(|x| x.is_handshake());
                self.incoming_messages.clear();
                for m in handshake_actions {
                    self.incoming_messages.push_back(m);
                }
                self.incoming_messages.push_back(msg_envelope);
                for m in game_actions {
                    self.incoming_messages.push_back(m);
                }
                return Ok(());
            }
        }

        Ok(())
    }

    // Tell whether the channel coin was spent in a way that requires us potentially to
    // fast forward games using interactions with their on-chain coin forms.
    fn check_channel_spent<'a, G, R: Rng + 'a>(
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
                    HandshakeState::OnChainTransition(unroll_coin, _t) => {
                        debug!(
                            "{} notified of channel coin spend in on chain transition state",
                            ch.is_initial_potato()
                        );
                        self.handshake_state =
                            HandshakeState::OnChainWaitingForUnrollTimeoutOrSpend(
                                unroll_coin.clone(),
                            );
                        let (_, system_interface) = penv.env();
                        system_interface.register_coin(
                            &unroll_coin,
                            &self.unroll_timeout,
                            Some("unroll"),
                        )?;
                        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
                        return Ok(true);
                    }
                    HandshakeState::Finished(hs) => {
                        debug!(
                            "{} notified of channel coin spend in run state",
                            ch.is_initial_potato()
                        );
                        self.handshake_state = HandshakeState::OnChainWaitForConditions(
                            channel_coin.coin_string().clone(),
                            hs,
                        );
                        let (_, system_interface) = penv.env();
                        system_interface.request_puzzle_and_solution(coin_id)?;
                        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
                        return Ok(true);
                    }
                    HandshakeState::OnChainWaitingForUnrollSpend(_) => {
                        debug!(
                            "{} notified of channel coin spend in waiting for unroll state.  this is used to collect rewards in a clean shutdown.",
                            ch.is_initial_potato()
                        );
                        self.handshake_state = HandshakeState::Completed;
                        let (_, system_interface) = penv.env();
                        system_interface.shutdown_complete(None)?;
                        return Ok(false);
                    }
                    x => {
                        self.handshake_state = x;
                        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
                        return Err(Error::StrErr(
                            "channel coin spend in non-handshake state".to_string(),
                        ));
                    }
                }
            }
        }

        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
        Ok(false)
    }

    // Both participants arrive here to check the unroll spend conditions.
    fn unroll_start_condition_check<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        self.handshake_state = HandshakeState::OnChainWaitingForUnrollConditions(coin_id.clone());
        let (_, system_interface) = penv.env();
        system_interface.request_puzzle_and_solution(coin_id)
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
        // Channel coin was spent so we're going on chain.
        let is_unroll_coin = match &self.handshake_state {
            HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin) => coin_id == unroll_coin,
            HandshakeState::OnChainWaitingForUnrollTimeoutOrSpend(unroll_coin) => {
                coin_id == unroll_coin
            }
            _ => false,
        };

        if is_unroll_coin {
            self.unroll_start_condition_check(penv, coin_id)?;
            return Ok(true);
        }

        Ok(false)
    }

    // Do work needed to set us up in on chain state waiting for the spend of the channel
    // coin as specified.
    fn setup_for_on_chain_waiting_for_unroll<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        spend: Box<HandshakeStepWithSpend>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (env, _) = penv.env();
        let player_ch = self.channel_handler()?;
        let run_puzzle = spend.spend.spends[0]
            .bundle
            .puzzle
            .to_program()
            .to_nodeptr(env.allocator)?;
        let run_args = spend.spend.spends[0]
            .bundle
            .solution
            .to_nodeptr(env.allocator)?;
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
                        let coin_id = CoinString::from_parts(
                            &player_ch.state_channel_coin().to_coin_id(),
                            ph,
                            amt,
                        );
                        debug!("spend to unroll coin {coin_id:?}");
                        return Some(coin_id);
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

        self.handshake_state = HandshakeState::OnChainTransition(unroll_result.clone(), spend);

        Ok(())
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

        {
            let player_ch = self.channel_handler_mut()?;
            player_ch.set_initiated_on_chain();
        }

        let player_ch = self.channel_handler()?;
        debug!("GO ON CHAIN: initiated {}", player_ch.is_initial_potato());
        // Channel coin
        let finished_unroll_coin = player_ch.get_finished_unroll_coin();

        // For debugging: get internal idea of what's signed.
        let unroll_puzzle_solution = finished_unroll_coin
            .coin
            .get_internal_conditions_for_unroll_coin_spend()?;
        let unroll_puzzle_solution_hash = unroll_puzzle_solution.sha256tree(env.allocator);
        let aggregate_unroll_signature = finished_unroll_coin.coin.get_unroll_coin_signature()?
            + finished_unroll_coin
                .signatures
                .my_unroll_half_signature_peer
                .clone();

        debug!("{} CHANNEL: AGGREGATE UNROLL hash {unroll_puzzle_solution_hash:?} {aggregate_unroll_signature:?}", player_ch.is_initial_potato());

        system_interface.spend_transaction_and_add_fee(&spend.spend)?;
        self.setup_for_on_chain_waiting_for_unroll(penv, spend)
    }

    pub fn do_unroll_spend_to_games<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        unroll_coin: &CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        debug!("spend from unroll coin {unroll_coin:?}");
        let (env, system_interface) = penv.env();
        let player_ch = self.channel_handler()?;
        // Channel coin
        let finished_unroll_coin = player_ch.get_finished_unroll_coin();
        let curried_unroll_puzzle = finished_unroll_coin
            .coin
            .make_curried_unroll_puzzle(env, &player_ch.get_aggregate_unroll_public_key())?;
        let curried_unroll_program = Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?;
        let unroll_solution = finished_unroll_coin
            .coin
            .make_unroll_puzzle_solution(env, &player_ch.get_aggregate_unroll_public_key())?;
        let unroll_solution_program = Program::from_nodeptr(env.allocator, unroll_solution)?;

        // For debugging: get internal idea of what's signed.
        let unroll_puzzle_solution = finished_unroll_coin
            .coin
            .get_internal_conditions_for_unroll_coin_spend()?;
        let unroll_puzzle_solution_hash = unroll_puzzle_solution.sha256tree(env.allocator);
        let aggregate_unroll_signature = finished_unroll_coin
            .signatures
            .my_unroll_half_signature_peer
            .clone()
            + finished_unroll_coin.coin.get_unroll_coin_signature()?;
        assert!(aggregate_unroll_signature.verify(
            &player_ch.get_aggregate_unroll_public_key(),
            unroll_puzzle_solution_hash.bytes()
        ));

        debug!("{} SPEND: AGGREGATE UNROLL hash {unroll_puzzle_solution_hash:?} {aggregate_unroll_signature:?}", player_ch.is_initial_potato());
        system_interface.spend_transaction_and_add_fee(&SpendBundle {
            name: Some("create unroll".to_string()),
            spends: vec![CoinSpend {
                bundle: Spend {
                    puzzle: curried_unroll_program,
                    solution: unroll_solution_program.into(),
                    signature: aggregate_unroll_signature,
                },
                coin: unroll_coin.clone(),
            }],
        })?;

        self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin.clone());

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
        got_error: bool,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        debug!("going on chain due to error {got_error}");
        let mut hs_state = HandshakeState::StepA;
        swap(&mut hs_state, &mut self.handshake_state);
        match hs_state {
            HandshakeState::Finished(t) => {
                let player_ch = self.channel_handler_mut()?;
                player_ch.set_on_chain_for_error();
                self.do_channel_spend_to_unroll(penv, t)?;
                Ok(())
            }
            x => {
                self.handshake_state = x;
                Err(Error::StrErr(
                    "go on chain before handshake finished".to_string(),
                ))
            }
        }
    }

    fn do_game_action<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        action: GameAction,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            on_chain.do_on_chain_action(penv, action)?;
            return Ok(true);
        }

        if matches!(
            &self.handshake_state,
            HandshakeState::OnChainWaitingForUnrollConditions(_)
                | HandshakeState::OnChainWaitingForUnrollSpend(_)
        ) {
            self.push_action(action);
            return Ok(false);
        }

        if matches!(self.handshake_state, HandshakeState::Finished(_)) {
            debug!("potato handler enqueue game action in finished state: {action:?}");
            self.push_action(action);

            if !self.send_potato_request_if_needed(penv)? {
                debug!("potato handler don't have potato");
                return Ok(false);
            }

            return self.have_potato_move(penv);
        }

        Err(Error::StrErr(format!(
            "move without finishing handshake (state {:?})",
            self.handshake_state
        )))
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
        let i_did_channel_spend = matches!(
            self.handshake_state,
            HandshakeState::OnChainTransition(_, _)
        );

        if i_did_channel_spend {
            // Wait for timeout.
            return Ok(());
        }

        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr(
                "Retrieve of puzzle and solution failed for channel coin".to_string(),
            ));
        };

        let (env, system_interface) = penv.env();
        let channel_conditions =
            CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

        // XXX If I wasn't the one who initiated the on chain transition, determine whether
        // to bump the unroll coin.

        let unroll_coin = if let Some(coin_id) = channel_conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    let created = CoinString::from_parts(&coin_id.to_coin_id(), ph, amt);
                    debug!("created unroll coin {created:?}");
                    return Some(created);
                }

                None
            })
            .next()
        {
            coin_id
        } else {
            return Err(Error::StrErr(
                "channel conditions didn't include a coin creation".to_string(),
            ));
        };

        self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin.clone());
        system_interface.register_coin(&unroll_coin, &self.unroll_timeout, Some("unroll"))?;

        Ok(())
    }

    // All remaining work to finish the on chain transition.  We have the state number and
    // the actual coins used to go on chain with.  We must construct a view of the games that
    // matches the state system given so on chain play can proceed.
    fn finish_on_chain_transition<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        unroll_coin: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr("no conditions for unroll coin".to_string()));
        };

        let game_map = {
            let player_ch = self.channel_handler_mut()?;
            debug!(
                "{} FINISH ON CHAIN TRANSITION",
                player_ch.is_initial_potato()
            );

            let (env, _system_interface) = penv.env();
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
            let created_coins: Vec<PuzzleHash> = conditions
                .iter()
                .filter_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *amt > Amount::default() {
                            return Some(ph.clone());
                        }
                    }

                    None
                })
                .collect();

            // We have a collection puzzle hash and amount pairs.  We need to match these to the
            // games in the channel handler.
            debug!("have unrolled coins {created_coins:?}");
            player_ch.set_state_for_coins(env, unroll_coin, &created_coins)?
        };

        for (_coin, def) in game_map.iter() {
            let player_ch = self.channel_handler()?;
            debug!(
                "{}: game {:?} our turn {:?}",
                player_ch.is_initial_potato(),
                def.game_id,
                player_ch.game_is_my_turn(&def.game_id)
            );
        }

        // Register each coin that corresponds to a game.
        for coin in game_map.keys() {
            let (_env, system_interface) = penv.env();
            system_interface.register_coin(coin, &self.channel_timeout, Some("game coin"))?;
        }

        for coin in game_map.keys() {
            let player_ch = self.channel_handler_mut()?;
            let (env, _system_interface) = penv.env();
            if let Some(redo_move) = player_ch.get_redo_action(env, coin)? {
                debug!("redo move: {redo_move:?}");
                self.game_action_queue.push_front(redo_move);
            }
        }

        debug!("we can proceed with game");

        let mut on_chain_queue = VecDeque::new();
        let mut swap_player_ch: Option<ChannelHandler> = None;
        swap(&mut self.game_action_queue, &mut on_chain_queue);
        swap(&mut self.channel_handler, &mut swap_player_ch);
        if let Some(channel_handler) = swap_player_ch {
            let mut on_chain = OnChainPotatoHandler::new(
                PotatoState::Present,
                self.channel_timeout.clone(),
                channel_handler,
                on_chain_queue,
                game_map,
            );
            on_chain.next_action(penv)?;
            self.handshake_state = HandshakeState::OnChain(Box::new(on_chain));
        } else {
            return Err(Error::StrErr("no channel handler yet".to_string()));
        }

        Ok(())
    }

    fn check_game_coin_spent<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            debug!("game coin spent in on chain mode {coin_id:?}");
            return on_chain.check_game_coin_spent(penv, coin_id);
        }

        Ok(false)
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

        let (my_games, their_games) = self.get_games_by_start_type(penv, i_initiated, game)?;

        let game_id_list: Vec<GameID> = my_games.iter().map(|g| g.game_id().clone()).collect();

        // This comes to both peers before any game start happens.
        // In the didn't initiate scenario, we hang onto the game start to ensure that
        // we know what we're receiving from the remote end.
        if i_initiated {
            self.my_start_queue.push_back(MyGameStartQueueEntry {
                my_games: my_games.into_iter().map(GSI).collect(),
                their_games: their_games.into_iter().map(GSI).collect()
            });

            self.push_action(GameAction::LocalStartGame);

            if !self.send_potato_request_if_needed(penv)? {
                return Ok(game_id_list.clone());
            }

            self.have_potato_move(penv)?;
        } else {
            // All checking needed is done by channel handler.
            self.their_start_queue
                .push_back(GameStartQueueEntry(game_id_list.clone()));
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
        debug!("potato handler make move {id:?} {readable:?}");
        self.do_game_action(
            penv,
            GameAction::Move(id.clone(), readable.clone(), new_entropy),
        )?;

        Ok(())
    }

    fn accept<'a>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>, id: &GameID) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        self.do_game_action(penv, GameAction::Accept(id.clone()))?;

        Ok(())
    }

    fn shut_down<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        let mut hs_state = HandshakeState::Completed;
        swap(&mut hs_state, &mut self.handshake_state);
        match hs_state {
            HandshakeState::OnChain(mut on_chain) => {
                if on_chain.shut_down(penv, conditions.clone())? {
                    self.channel_handler = Some(on_chain.into_channel_handler());
                    self.handshake_state = HandshakeState::Completed;
                } else {
                    self.handshake_state = HandshakeState::OnChain(on_chain);
                }
                return Ok(());
            }
            x => {
                self.handshake_state = x;
            }
        }

        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "shut_down without finishing handshake {:?}",
                self.handshake_state
            )));
        }

        self.do_game_action(penv, GameAction::Shutdown(ShutdownActionHolder(conditions)))?;

        Ok(())
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
        debug!("coin created: {coin:?}");
        // When the channel coin is created, we know we can proceed in playing the game.
        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            let channel_coin_created = self
                .channel_handler()
                .ok()
                .map(|ch| ch.state_channel_coin().coin_string());

            debug!("checking created coin {coin:?} vs expected {channel_coin_created:?}");
            if channel_coin_created.is_some() {
                self.waiting_to_start = false;
                self.try_complete_step_f(
                    penv,
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?;
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
        self.check_channel_spent(penv, coin_id)?;

        self.check_unroll_spent(penv, coin_id)?;

        self.check_game_coin_spent(penv, coin_id)?;

        Ok(())
    }

    fn coin_timeout_reached<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        // We should be in state OnChainWaitingForUnrollTimeoutOrSpend
        // We'll spend the unroll coin via do_unroll_spend_to_games with the default
        // reveal and go to OnChainWaitingForUnrollSpend, transitioning to OnChain when
        // we receive the unroll coin spend.
        let unroll_timed_out =
            if let HandshakeState::OnChainWaitingForUnrollTimeoutOrSpend(unroll) =
                &self.handshake_state
            {
                coin_id == unroll
            } else {
                false
            };

        // out from under the immutable borrow.
        if unroll_timed_out {
            return self.do_unroll_spend_to_games(penv, coin_id);
        }

        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            return on_chain.coin_timeout_reached(penv, coin_id);
        }

        Ok(())
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
        if let (HandshakeState::OnChain(on_chain), Some((p, s))) =
            (&mut self.handshake_state, puzzle_and_solution)
        {
            debug!("passing on game coin spend to on chain handler {coin_id:?}");
            return on_chain.handle_game_coin_spent(penv, coin_id, p, s);
        }

        if let Some((puzzle, solution)) = puzzle_and_solution {
            let player_ch = self.channel_handler_mut()?;
            let (env, system_interface) = penv.env();
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

            if let Some(spend_bundle) = player_ch.handle_reward_spends(env, coin_id, &conditions)? {
                system_interface.spend_transaction_and_add_fee(&spend_bundle)?;
            }
        }

        let state_coin_id = match &self.handshake_state {
            HandshakeState::OnChainWaitForConditions(state_coin_id, _data) => {
                Some(ConditionWaitKind::Channel(state_coin_id.clone()))
            }
            HandshakeState::OnChainWaitingForUnrollSpend(unroll_id) => {
                Some(ConditionWaitKind::Unroll(unroll_id.clone()))
            }
            HandshakeState::OnChainWaitingForUnrollConditions(unroll_id) => {
                Some(ConditionWaitKind::Unroll(unroll_id.clone()))
            }
            _ => None,
        };

        let player_ch = self.channel_handler()?;
        debug!(
            "{} coin puzzle and solution {coin_id:?} = {state_coin_id:?}",
            player_ch.is_initial_potato()
        );

        match state_coin_id {
            Some(ConditionWaitKind::Channel(state_coin_id)) => {
                if *coin_id == state_coin_id {
                    return self.handle_channel_coin_spent(penv, coin_id, puzzle_and_solution);
                }
            }
            Some(ConditionWaitKind::Unroll(unroll_coin_id)) => {
                if *coin_id == unroll_coin_id {
                    return self.finish_on_chain_transition(penv, coin_id, puzzle_and_solution);
                }
            }
            _ => {}
        }

        Ok(())
    }
}
