use std::borrow::Borrow;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::mem::swap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{run_program, Allocator, NodePtr};

use log::debug;
use rand::Rng;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationResult, ChannelHandlerPrivateKeys,
    GameStartInfo, GameStartInfoInterface, PotatoSignatures, ReadableMove, StartGameResult,
};
use crate::channel_handler::game;
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{
    chia_dialect, AllocEncoder, Amount, CoinCondition, CoinID, CoinSpend, CoinString, Error,
    GameID, GameType, GetCoinStringParts, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash,
    Sha256Input, Sha256tree, Spend, SpendBundle, Timeout,
};
use crate::utils::proper_list;

use crate::potato_handler::effects::Effect;
use crate::potato_handler::on_chain::OnChainPotatoHandler;
use crate::shutdown::{get_conditions_with_channel_handler, ShutdownConditions};

use crate::potato_handler::types::{
    BootstrapTowardGame, ConditionWaitKind, FromLocalUI, GameAction,
    GameFactory, PeerMessage, PotatoHandlerImpl, PotatoHandlerInit,
    PotatoState, ShutdownActionHolder, SpendWalletReceiver, GSI,
};

use crate::potato_handler::handshake::{
    HandshakeA, HandshakeB, HandshakeState, HandshakeStepInfo, HandshakeStepWithSpend,
};
use crate::potato_handler::start::{GameStart, GameStartQueueEntry, MyGameStartQueueEntry};

pub mod effects;
pub mod handshake;
pub mod on_chain;
pub mod start;
pub mod types;

pub type GameStartInfoPair = (
    Vec<Rc<dyn GameStartInfoInterface>>,
    Vec<Rc<dyn GameStartInfoInterface>>,
);

fn serialize_game_type_map<S: Serializer>(
    map: &BTreeMap<GameType, GameFactory>,
    s: S,
) -> Result<S::Ok, S::Error> {
    map.iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<(GameType, GameFactory)>>()
        .serialize(s)
}

fn deserialize_game_type_map<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<GameType, GameFactory>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Vec::<(GameType, GameFactory)>::deserialize(deserializer)?;
    let b: BTreeMap<GameType, GameFactory> = v.iter().cloned().collect();
    Ok(b)
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

    #[serde(
        serialize_with = "serialize_game_type_map",
        deserialize_with = "deserialize_game_type_map"
    )]
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

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.get_our_current_share())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.get_their_current_share())
    }

    pub fn is_on_chain(&self) -> bool {
        matches!(self.handshake_state, HandshakeState::OnChain(_))
    }

    pub fn enable_cheating_for_game(
        &mut self,
        game_id: &GameID,
        make_move: &[u8],
    ) -> Result<bool, Error> {
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            on_chain.enable_cheating_for_game(game_id, make_move)
        } else {
            Err(Error::StrErr(
                "enable_cheating: game is not on chain".to_string(),
            ))
        }
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

    pub fn get_reward_puzzle_hash<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<PuzzleHash, Error> {
        let player_ch = self.channel_handler()?;
        player_ch.get_reward_puzzle_hash(env)
    }

    pub fn start<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
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

        Ok(Some(Effect::SendMessage(PeerMessage::HandshakeA(my_hs_info))))
    }

    fn update_channel_coin_after_receive<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        spend: &ChannelCoinSpendInfo,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        self.have_potato = PotatoState::Present;

        let (started, start_effects) = self.have_potato_start_game(env)?;
        effects.extend(start_effects);
        if started {
            return Ok(effects);
        }

        let (moved, move_effects) = self.have_potato_move(env)?;
        effects.extend(move_effects);
        if moved {
            return Ok(effects);
        }

        let (channel_coin, channel_public_key) = {
            let ch = self.channel_handler()?;
            let cc = ch.state_channel_coin().clone();
            (cc, ch.get_aggregate_channel_public_key())
        };

        if let HandshakeState::Finished(hs) = &mut self.handshake_state {
            debug!("hs spend num_spends={}", hs.spend.spends.len());
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
            debug!("updated spend for channel coin");
        }

        Ok(effects)
    }

    fn pass_on_channel_handler_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let timeout = self.channel_timeout.clone();

        debug!("received peer message");
        match msg_envelope.borrow() {
            PeerMessage::Nil(n) => {
                debug!("about to receive empty potato");
                let spend_info = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_empty_potato(env, n)?
                };
                effects.extend(self.update_channel_coin_after_receive(env, &spend_info)?);
            }
            PeerMessage::Move(game_id, m) => {
                let move_result = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_potato_move(env, game_id, m)?
                };
                let opponent_readable =
                    ReadableMove::from_program(move_result.readable_their_move);
                effects.push(Effect::OpponentMoved {
                    id: game_id.clone(),
                    state_number: move_result.state_number,
                    readable: opponent_readable,
                    mover_share: move_result.mover_share,
                });
                if !move_result.message.is_empty() {
                    effects.push(Effect::SendMessage(
                        PeerMessage::Message(game_id.clone(), move_result.message),
                    ));
                }
                effects.extend(self.update_channel_coin_after_receive(env, &move_result.spend_info)?);
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_message(env, game_id, message)?
                };
                effects.push(Effect::RawGameMessage {
                    id: game_id.clone(),
                    readable: message.clone(),
                });
                effects.push(Effect::GameMessage {
                    id: game_id.clone(),
                    readable: decoded_message,
                });
            }
            PeerMessage::Accept(game_id, amount, sigs) => {
                let spend_info = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_potato_accept(env, sigs, game_id)?
                };
                effects.push(Effect::GameFinished {
                    id: game_id.clone(),
                    mover_share: amount.clone(),
                });
                effects.extend(self.update_channel_coin_after_receive(env, &spend_info)?);
            }
            PeerMessage::Shutdown(sig, conditions) => {
                let (coin, my_reward, full_spend, channel_puzzle_public_key) = {
                    let ch = self.channel_handler_mut()?;
                    let coin = ch.state_channel_coin().clone();
                    let clvm_conditions = conditions.to_nodeptr(env.allocator)?;
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

                    let my_reward = CoinString::from_parts(
                        &coin.to_coin_id(),
                        &want_puzzle_hash,
                        &want_amount,
                    );
                    let full_spend =
                        ch.received_potato_clean_shutdown(env, sig, clvm_conditions)?;
                    let channel_puzzle_public_key = ch.get_aggregate_channel_public_key();
                    (coin, my_reward, full_spend, channel_puzzle_public_key)
                };

                effects.push(Effect::RegisterCoin {
                    coin: my_reward,
                    timeout: timeout.clone(),
                    name: Some("reward"),
                });
                effects.push(Effect::RegisterCoin {
                    coin: coin.clone(),
                    timeout: timeout.clone(),
                    name: Some("parent"),
                });
                effects.push(Effect::ShutdownStarted);

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
                effects.push(Effect::SpendTransaction(SpendBundle {
                    name: Some("Create unroll".to_string()),
                    spends: vec![CoinSpend {
                        coin: coin.clone(),
                        bundle: spend,
                    }],
                }));

                self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(coin.clone());
            }
            _ => {
                return Err(Error::StrErr(format!(
                    "unhandled passthrough message {msg_envelope:?}"
                )));
            }
        }

        Ok(effects)
    }

    pub fn try_complete_step_body<F>(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        maybe_transaction: Option<SpendBundle>,
        ctor: F,
    ) -> Result<Option<Effect>, Error>
    where
        F: FnOnce(&SpendBundle) -> Result<PeerMessage, Error>,
    {
        if let Some(spend) = maybe_transaction {
            let effect = Effect::SendMessage(ctor(&spend)?);

            self.handshake_state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend,
            }));

            return Ok(Some(effect));
        }

        Ok(None)
    }

    pub fn try_complete_step_e(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<Option<Effect>, Error> {
        self.try_complete_step_body(
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

    pub fn try_complete_step_f(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<Option<Effect>, Error> {
        if self.waiting_to_start {
            debug!("waiting to start");
            return Ok(None);
        }

        debug!("starting");
        self.try_complete_step_body(
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
    fn have_potato_start_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        let mut effects = Vec::new();
        debug!(
            "have potato start game: my queue length {}",
            self.my_start_queue.len()
        );
        if let Some(desc) = self.my_start_queue.pop_front() {
            let mut dehydrated_games = Vec::with_capacity(desc.their_games.len());

            let sigs = {
                let ch = self.channel_handler_mut()?;
                for game in desc.their_games.iter() {
                    debug!("their game id={:?}", game.0.game_id());
                    dehydrated_games.push(game.clone());
                }
                for game in desc.my_games.iter() {
                    debug!("using game id={:?}", game.0.game_id());
                }

                let unwrapped_games: Vec<Rc<dyn GameStartInfoInterface>> =
                    desc.my_games.iter().map(|g| g.0.clone()).collect();

                let game_ids: Vec<GameID> = desc
                    .my_games
                    .iter()
                    .map(|d| d.0.game_id().clone())
                    .collect();

                match ch.send_potato_start_game(env, &unwrapped_games)? {
                    StartGameResult::Failure(reason) => {
                        effects.push(Effect::GameStart {
                            ids: game_ids,
                            failed: Some(reason),
                        });
                        return Ok((true, effects));
                    }
                    StartGameResult::Success(sigs) => {
                        effects.push(Effect::GameStart {
                            ids: game_ids,
                            failed: None,
                        });
                        sigs
                    }
                }
            };

            debug!("dehydrated_games count={}", dehydrated_games.len());
            self.have_potato = PotatoState::Absent;
            effects.push(Effect::SendMessage(
                PeerMessage::StartGames(*sigs, dehydrated_games),
            ));
            return Ok((true, effects));
        }

        debug!("have_potato_start_game: no games in queue");
        Ok((false, effects))
    }

    fn send_potato_request_if_needed(&mut self) -> Result<(bool, Option<Effect>), Error> {
        if matches!(self.have_potato, PotatoState::Present) {
            debug!(
                "don't send a potato request because have_potato is {:?}",
                self.have_potato
            );
            return Ok((true, None));
        }

        if matches!(self.have_potato, PotatoState::Absent) {
            self.have_potato = PotatoState::Requested;
            return Ok((false, Some(Effect::SendMessage(PeerMessage::RequestPotato(())))));
        }

        Ok((false, None))
    }

    fn have_potato_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        let mut effects = Vec::new();
        let action = self.game_action_queue.pop_front();
        debug!("have_potato_move, dequeue {action:?}");
        match action {
            Some(GameAction::LocalStartGame) => {
                let (_started, start_effects) = self.have_potato_start_game(env)?;
                effects.extend(start_effects);
                Ok((true, effects))
            }
            Some(GameAction::Move(game_id, readable_move, new_entropy)) => {
                assert!(matches!(self.have_potato, PotatoState::Present));
                let move_result = {
                    let ch = self.channel_handler_mut()?;
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
                        return Ok((false, effects));
                    }
                };

                debug!("have_potato_move: self move notify {move_result:?}");
                effects.push(Effect::SelfMove {
                    id: game_id.clone(),
                    state_number: move_result.state_number,
                    move_made: move_result.game_move.basic.move_made.clone(),
                });

                debug!("have_potato_move: send move message");
                effects.push(Effect::SendMessage(PeerMessage::Move(game_id, move_result)));
                self.have_potato = PotatoState::Absent;

                Ok((true, effects))
            }
            Some(GameAction::RedoMove(_coin, _new_ph, _transaction, _, _)) => {
                Err(Error::StrErr("redo move when not on chain".to_string()))
            }
            Some(GameAction::RedoAccept(_, _, _, _)) => {
                Err(Error::StrErr("redo accept when not on chain".to_string()))
            }
            Some(GameAction::Accept(game_id)) => {
                let (sigs, amount) = {
                    let ch = self.channel_handler_mut()?;
                    ch.send_potato_accept(env, &game_id)?
                };

                effects.push(Effect::SendMessage(
                    PeerMessage::Accept(game_id.clone(), amount.clone(), sigs),
                ));
                self.have_potato = PotatoState::Absent;
                effects.push(Effect::GameFinished {
                    id: game_id,
                    mover_share: amount,
                });

                Ok((true, effects))
            }
            Some(GameAction::Shutdown(conditions)) => {
                let timeout = self.channel_timeout.clone();
                let real_conditions = {
                    let ch = self.channel_handler_mut()?;
                    get_conditions_with_channel_handler(env, ch, conditions.0.borrow())?
                };
                let (state_channel_coin, spend, want_puzzle_hash, want_amount) = {
                    let ch = self.channel_handler_mut()?;
                    let spend = ch.send_potato_clean_shutdown(env, real_conditions)?;
                    let want_puzzle_hash = ch.get_reward_puzzle_hash(env)?;
                    let want_amount = ch.clean_shutdown_amount();
                    (
                        ch.state_channel_coin().clone(),
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

                effects.push(Effect::RegisterCoin {
                    coin: my_reward,
                    timeout,
                    name: Some("reward"),
                });

                let shutdown_condition_program =
                    Rc::new(Program::from_nodeptr(env.allocator, real_conditions)?);
                effects.push(Effect::SendMessage(
                    PeerMessage::Shutdown(
                        spend.signature.clone(),
                        shutdown_condition_program.into(),
                    ),
                ));

                self.handshake_state =
                    HandshakeState::OnChainWaitingForUnrollSpend(state_channel_coin.clone());

                Ok((true, effects))
            }
            Some(GameAction::SendPotato) => {
                let nil_msg = {
                    let ch = self.channel_handler_mut()?;
                    ch.send_empty_potato(env)?
                };
                effects.push(Effect::SendMessage(PeerMessage::Nil(nil_msg)));
                self.have_potato = PotatoState::Absent;
                Ok((false, effects))
            }
            None => Ok((false, effects)),
        }
    }

    fn start_version_0<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        i_initiated: bool,
        game_start: &GameStart,
        starter_clvm: NodePtr,
        params_clvm: NodePtr,
    ) -> Result<GameStartInfoPair, Error> {
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
            let mut result_start_info: Vec<Rc<dyn GameStartInfoInterface>> =
                Vec::with_capacity(my_info_list.len());
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

    fn start_version_1<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        i_initiated: bool,
        game_start: &GameStart,
        proposal_program: Rc<Program>,
        parser_program: Option<Rc<Program>>,
    ) -> Result<GameStartInfoPair, Error> {
        let their_contribution = game_start.amount.clone() - game_start.my_contribution.clone();

        if let Some(parser_prog) = parser_program {
            // New proposal/parser path
            let parser_puzzle: Puzzle = parser_prog.into();
            let alice_game = game::Game::new_from_proposal(
                env.allocator,
                i_initiated,
                &game_start.game_id,
                proposal_program.clone().into(),
                Some(parser_puzzle.clone()),
                &game_start.my_contribution,
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
            let bob_game = game::Game::new_from_proposal(
                env.allocator,
                !i_initiated,
                &game_start.game_id,
                proposal_program.into(),
                Some(parser_puzzle),
                &game_start.my_contribution,
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
        } else {
            // Old factory path (debug game)
            let program_run_args = (
                game_start.my_contribution.clone(),
                (their_contribution.clone(), (Rc::new(game_start.parameters.clone()), ())),
            )
                .to_clvm(env.allocator)
                .into_gen()?;
            let params_prog = Rc::new(Program::from_nodeptr(env.allocator, program_run_args)?);
            let alice_game = game::Game::new_program(
                env.allocator,
                i_initiated,
                &game_start.game_id,
                proposal_program.clone().into(),
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
            let bob_game = game::Game::new_program(
                env.allocator,
                !i_initiated,
                &game_start.game_id,
                proposal_program.into(),
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
    }

    fn get_games_by_start_type<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        i_initiated: bool,
        game_start: &GameStart,
    ) -> Result<GameStartInfoPair, Error> {
        debug!("Starting game with game type {:?}", game_start.game_type);
        debug!("Known game types: {:?}", self.game_types.keys().collect::<Vec<_>>());
        let starter = if let Some(starter) = self.game_types.get(&game_start.game_type) {
            starter
        } else {
            return Err(Error::StrErr(format!(
                "no such game {:?}",
                game_start.game_type
            )));
        };

        if starter.version == 0 {
            let starter_clvm = starter.program.to_clvm(env.allocator).into_gen()?;
            let params_clvm = game_start.parameters.to_clvm(env.allocator).into_gen()?;

            self.start_version_0(env, i_initiated, game_start, starter_clvm, params_clvm)
        } else {
            self.start_version_1(
                env,
                i_initiated,
                game_start,
                starter.program.clone(),
                starter.parser_program.clone(),
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

    fn received_game_start<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        sigs: &PotatoSignatures,
        games: &[GSI],
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
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

        let (game_ids, spend_info) = {
            let ch = self.channel_handler_mut()?;
            let mut rehydrated_games = Vec::with_capacity(games.len());
            for game in games.iter() {
                debug!("their game id={:?}", game.0.game_id());
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

            (game_ids, spend_info)
        };

        effects.push(Effect::GameStart {
            ids: game_ids,
            failed: None,
        });

        effects.extend(self.update_channel_coin_after_receive(env, &spend_info)?);

        Ok(effects)
    }

    pub fn received_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        self.incoming_messages.push_back(Rc::new(msg_envelope));
        let incoming_effects = self.process_incoming_message(env)?;
        effects.extend(incoming_effects);
        while let Some(action) = self.game_action_queue.pop_front() {
            let (continued, action_effects) = self.do_game_action(env, action)?;
            effects.extend(action_effects);
            if !continued {
                break;
            }
        }

        Ok(effects)
    }

    fn make_channel_handler<R: Rng>(
        &self,
        parent: CoinID,
        start_potato: bool,
        msg: &HandshakeB,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<(ChannelHandler, ChannelHandlerInitiationResult), Error> {
        ChannelHandler::new(
            env,
            self.private_keys.clone(),
            parent,
            start_potato,
            msg.channel_public_key.clone(),
            msg.unroll_public_key.clone(),
            msg.referee_puzzle_hash.clone(),
            msg.reward_puzzle_hash.clone(),
            self.my_contribution.clone(),
            self.their_contribution.clone(),
            self.channel_timeout.clone(),
            self.reward_puzzle_hash.clone(),
        )
    }

    pub fn process_incoming_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let msg_envelope = if let Some(msg) = self.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(effects);
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
                let (mut channel_handler, _init_result) =
                    self.make_channel_handler(parent_coin.to_coin_id(), false, msg, env)?;

                let channel_coin = channel_handler.state_channel_coin().clone();
                let (_, channel_puzzle_hash, _) = channel_coin.get_coin_string_parts()?;

                effects.push(Effect::ChannelPuzzleHash(channel_puzzle_hash));
                effects.push(Effect::RegisterCoin {
                    coin: channel_coin,
                    timeout: self.channel_timeout.clone(),
                    name: Some("channel"),
                });

                let channel_public_key =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let unroll_public_key =
                    private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash =
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?;

                let our_handshake_data = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                {
                    let nil_msg = channel_handler.send_empty_potato(env)?;
                    effects.push(Effect::SendMessage(PeerMessage::Nil(nil_msg)));
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

                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);

                let effect = self.try_complete_step_e(first_player_hs, second_player_hs)?;
                effects.extend(effect);
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

                let (channel_handler, _init_result) =
                    self.make_channel_handler(msg.parent.to_coin_id(), true, &msg.simple, env)?;

                let channel_public_key =
                    private_to_public_key(&channel_handler.channel_private_key());
                let unroll_public_key =
                    private_to_public_key(&channel_handler.unroll_private_key());
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash =
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?;

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

                effects.push(Effect::SendMessage(PeerMessage::HandshakeB(my_hs_info)));
            }

            HandshakeState::StepD(info) => {
                let parent_coin = info.first_player_hs_info.parent.clone();
                self.handshake_state = HandshakeState::StepF(info.clone());

                self.next_game_id = init_game_id(parent_coin.to_bytes());
                debug!("StepD next game id {:?}", self.next_game_id);
                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);

                let nil_msg = {
                    let ch = self.channel_handler_mut()?;
                    ch.send_empty_potato(env)?
                };
                effects.push(Effect::SendMessage(PeerMessage::Nil(nil_msg)));
            }

            HandshakeState::StepF(info) => {
                let bundle = if let PeerMessage::HandshakeE { bundle } = msg_envelope.borrow() {
                    bundle
                } else {
                    self.incoming_messages.push_front(msg_envelope.clone());
                    return Ok(effects);
                };

                let channel_coin = {
                    let ch = self.channel_handler()?;
                    ch.state_channel_coin()
                };

                debug!("PH: channel_coin {:?}", channel_coin);

                if bundle.spends.is_empty() {
                    return Err(Error::StrErr(
                        "No spends to draw the channel coin from".to_string(),
                    ));
                }

                effects.push(Effect::RegisterCoin {
                    coin: channel_coin.clone(),
                    timeout: self.channel_timeout.clone(),
                    name: Some("channel"),
                });
                effects.push(Effect::ReceivedChannelOffer(bundle.clone()));

                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepF(info.clone());

                self.have_potato = PotatoState::Absent;
                let effect = self.try_complete_step_f(first_player_hs, second_player_hs)?;
                effects.extend(effect);
            }

            HandshakeState::Finished(_) => {
                debug!("running: got message {:?}", msg_envelope);
                match msg_envelope.borrow() {
                    PeerMessage::HandshakeF { bundle } => {
                        self.channel_finished_transaction = Some(bundle.clone());
                        effects.push(Effect::ReceivedChannelOffer(bundle.clone()));
                    }
                    PeerMessage::RequestPotato(_) => {
                        if matches!(self.have_potato, PotatoState::Present) {
                            let (_continued, action_effects) =
                                self.do_game_action(env, GameAction::SendPotato)?;
                            effects.extend(action_effects);
                        } else {
                            self.push_action(GameAction::SendPotato);
                        }
                    }
                    PeerMessage::StartGames(sigs, g) => {
                        effects.extend(self.received_game_start(env, sigs, g)?);
                    }
                    _ => {
                        effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);
                    }
                }

                return Ok(effects);
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
                return Ok(effects);
            }
        }

        Ok(effects)
    }

    fn check_channel_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error> {
        if let Some(ch) = self.channel_handler.as_ref() {
            let channel_coin = ch.state_channel_coin();
            if coin_id == channel_coin {
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
                        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
                        return Ok((true, Some(Effect::RegisterCoin {
                            coin: unroll_coin,
                            timeout: self.unroll_timeout.clone(),
                            name: Some("unroll"),
                        })));
                    }
                    HandshakeState::Finished(hs) => {
                        debug!(
                            "{} notified of channel coin spend in run state",
                            ch.is_initial_potato()
                        );
                        self.handshake_state =
                            HandshakeState::OnChainWaitForConditions(channel_coin.clone(), hs);
                        assert!(!matches!(self.handshake_state, HandshakeState::StepA));
                        return Ok((true, Some(Effect::RequestPuzzleAndSolution(coin_id.clone()))));
                    }
                    HandshakeState::OnChainWaitingForUnrollSpend(_) => {
                        debug!(
                            "{} notified of channel coin spend in waiting for unroll state.  this is used to collect rewards in a clean shutdown.",
                            ch.is_initial_potato()
                        );
                        self.handshake_state = HandshakeState::Completed;
                        return Ok((false, Some(Effect::ShutdownComplete {
                            reward_coin: None,
                        })));
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
        Ok((false, None))
    }

    fn unroll_start_condition_check(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<Effect, Error> {
        self.handshake_state = HandshakeState::OnChainWaitingForUnrollConditions(coin_id.clone());
        Ok(Effect::RequestPuzzleAndSolution(coin_id.clone()))
    }

    // Tell whether the channel coin was spent in a way that requires us potentially to
    // fast forward games using interactions with their on-chain coin forms.
    fn check_unroll_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error> {
        // Channel coin was spent so we're going on chain.
        let is_unroll_coin = match &self.handshake_state {
            HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin) => coin_id == unroll_coin,
            HandshakeState::OnChainWaitingForUnrollTimeoutOrSpend(unroll_coin) => {
                coin_id == unroll_coin
            }
            _ => false,
        };

        if is_unroll_coin {
            let effect = self.unroll_start_condition_check(coin_id)?;
            return Ok((true, Some(effect)));
        }

        Ok((false, None))
    }

    pub fn do_channel_spend_to_unroll<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        spend: Box<HandshakeStepWithSpend>,
    ) -> Result<Vec<Effect>, Error> {
        {
            let player_ch = self.channel_handler_mut()?;
            player_ch.set_initiated_on_chain();
        }

        let mut effects = vec![Effect::SpendTransaction(spend.spend.clone())];

        let (channel_spend_bundle, unroll_coin) = {
            let player_ch = self.channel_handler()?;
            debug!("GO ON CHAIN: initiated {}", player_ch.is_initial_potato());

            let channel_spend_bundle =
                player_ch.get_channel_coin_spend_to_unroll_bundle(env)?;
            debug!(
                "submitting channel coin spend to unroll: {:?}",
                channel_spend_bundle.spends[0].coin
            );

            let unroll_coin = player_ch.compute_expected_unroll_coin(env)?;
            debug!("expected unroll coin: {unroll_coin:?}");
            (channel_spend_bundle, unroll_coin)
        };

        effects.push(Effect::SpendTransaction(channel_spend_bundle));

        self.handshake_state = HandshakeState::OnChainTransition(unroll_coin, spend);
        Ok(effects)
    }

    pub fn do_unroll_spend_to_games<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        unroll_coin: &CoinString,
    ) -> Result<Option<Effect>, Error> {
        debug!("spend from unroll coin {unroll_coin:?}");
        let spend_bundle = {
            let player_ch = self.channel_handler()?;
            let finished_unroll_coin = player_ch.get_finished_unroll_coin();
            let curried_unroll_puzzle = finished_unroll_coin
                .coin
                .make_curried_unroll_puzzle(env, &player_ch.get_aggregate_unroll_public_key())?;
            let curried_unroll_program =
                Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?;
            let unroll_solution = finished_unroll_coin
                .coin
                .make_unroll_puzzle_solution(env, &player_ch.get_aggregate_unroll_public_key())?;
            let unroll_solution_program = Program::from_nodeptr(env.allocator, unroll_solution)?;

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
            SpendBundle {
                name: Some("create unroll".to_string()),
                spends: vec![CoinSpend {
                    bundle: Spend {
                        puzzle: curried_unroll_program,
                        solution: unroll_solution_program.into(),
                        signature: aggregate_unroll_signature,
                    },
                    coin: unroll_coin.clone(),
                }],
            }
        };

        self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin.clone());

        Ok(Some(Effect::SpendTransaction(spend_bundle)))
    }

    /// Short circuit to go on chain.
    /// We'll use the current state as we know it to go on chain and launch a transaction
    /// to update to the current move.
    ///
    /// This should also be used if a timeout is encountered or if we receive an error back
    /// from any off chain activity while consuming the peer's message.
    pub fn go_on_chain<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        debug!("going on chain due to error {got_error}");
        let mut hs_state = HandshakeState::StepA;
        swap(&mut hs_state, &mut self.handshake_state);
        match hs_state {
            HandshakeState::Finished(t) => {
                let player_ch = self.channel_handler_mut()?;
                player_ch.set_on_chain_for_error();
                self.do_channel_spend_to_unroll(env, t)
            }
            x => {
                self.handshake_state = x;
                Err(Error::StrErr(
                    "go on chain before handshake finished".to_string(),
                ))
            }
        }
    }

    fn do_game_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        action: GameAction,
    ) -> Result<(bool, Vec<Effect>), Error> {
        let mut effects = Vec::new();
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            effects.extend(on_chain.do_on_chain_action(env, action)?);
            return Ok((true, effects));
        }

        if matches!(
            &self.handshake_state,
            HandshakeState::OnChainWaitingForUnrollConditions(_)
                | HandshakeState::OnChainWaitingForUnrollSpend(_)
        ) {
            self.push_action(action);
            return Ok((false, effects));
        }

        if matches!(self.handshake_state, HandshakeState::Finished(_)) {
            debug!("potato handler enqueue game action in finished state: {action:?}");
            self.push_action(action);

            let (has_potato, effect) = self.send_potato_request_if_needed()?;
            effects.extend(effect);
            if !has_potato {
                debug!("potato handler don't have potato");
                return Ok((false, effects));
            }

            let (moved, move_effects) = self.have_potato_move(env)?;
            effects.extend(move_effects);
            return Ok((moved, effects));
        }

        Err(Error::StrErr(format!(
            "move without finishing handshake (state {:?})",
            self.handshake_state
        )))
    }

    fn handle_channel_coin_spent<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Option<Effect>, Error> {
        let i_did_channel_spend = matches!(
            self.handshake_state,
            HandshakeState::OnChainTransition(_, _)
        );

        if i_did_channel_spend {
            return Ok(None);
        }

        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr(
                "Retrieve of puzzle and solution failed for channel coin".to_string(),
            ));
        };

        let unroll_coin = {
            let channel_conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

            if let Some(coin_id) = channel_conditions
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
            }
        };

        self.handshake_state = HandshakeState::OnChainWaitingForUnrollSpend(unroll_coin.clone());
        Ok(Some(Effect::RegisterCoin {
            coin: unroll_coin,
            timeout: self.unroll_timeout.clone(),
            name: Some("unroll"),
        }))
    }

    // All remaining work to finish the on chain transition.  We have the state number and
    // the actual coins used to go on chain with.  We must construct a view of the games that
    // matches the state system given so on chain play can proceed.
    fn finish_on_chain_transition<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        unroll_coin: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
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

        for coin in game_map.keys() {
            effects.push(Effect::RegisterCoin {
                coin: coin.clone(),
                timeout: self.channel_timeout.clone(),
                name: Some("game coin"),
            });
        }

        for coin in game_map.keys() {
            let player_ch = self.channel_handler_mut()?;
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
            effects.extend(on_chain.next_action(env)?);
            self.handshake_state = HandshakeState::OnChain(Box::new(on_chain));
        } else {
            return Err(Error::StrErr("no channel handler yet".to_string()));
        }

        Ok(effects)
    }

    fn check_game_coin_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error> {
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            debug!("game coin spent in on chain mode {coin_id:?}");
            let (result, effect) = on_chain.check_game_coin_spent(coin_id)?;
            return Ok((result, effect));
        }

        Ok((false, None))
    }

    pub fn get_game_state_id<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Option<Hash>, Error> {
        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            return on_chain.get_game_state_id(env);
        }
        let player_ch = self.channel_handler().ok();
        if let Some(player_ch) = player_ch {
            return player_ch.get_game_state_id(env).map(Some);
        }

        Ok(None)
    }
}

impl FromLocalUI for PotatoHandler
{
    fn start_games<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>
    {
        let mut effects = Vec::new();
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "start games without finishing handshake: {:?}",
                self.handshake_state
            )));
        }

        let (my_games, their_games) = self.get_games_by_start_type(env, i_initiated, game)?;

        let game_id_list: Vec<GameID> = my_games.iter().map(|g| g.game_id().clone()).collect();

        // This comes to both peers before any game start happens.
        // In the didn't initiate scenario, we hang onto the game start to ensure that
        // we know what we're receiving from the remote end.
        if i_initiated {
            self.my_start_queue.push_back(MyGameStartQueueEntry {
                my_games: my_games.into_iter().map(GSI).collect(),
                their_games: their_games.into_iter().map(GSI).collect(),
            });

            self.push_action(GameAction::LocalStartGame);

            let (has_potato, effect) = self.send_potato_request_if_needed()?;
            effects.extend(effect);
            if !has_potato {
                return Ok((game_id_list.clone(), effects));
            }

            let (_moved, move_effects) = self.have_potato_move(env)?;
            effects.extend(move_effects);
        } else {
            // All checking needed is done by channel handler.
            self.their_start_queue
                .push_back(GameStartQueueEntry(game_id_list.clone()));
        }

        Ok((game_id_list, effects))
    }

    fn make_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>
    {
        debug!("potato handler make move {id:?} {readable:?}");
        let (_continued, effects) = self.do_game_action(
            env,
            GameAction::Move(id.clone(), readable.clone(), new_entropy),
        )?;

        Ok(effects)
    }

    fn accept<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>
    {
        let (_continued, effects) = self.do_game_action(env, GameAction::Accept(id.clone()))?;

        Ok(effects)
    }

    fn shut_down<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();
        let mut hs_state = HandshakeState::Completed;
        swap(&mut hs_state, &mut self.handshake_state);
        match hs_state {
            HandshakeState::OnChain(mut on_chain) => {
                let (result, effect) = on_chain.shut_down(conditions.clone())?;
                effects.extend(effect);
                if result {
                    self.channel_handler = Some(on_chain.into_channel_handler());
                    self.handshake_state = HandshakeState::Completed;
                } else {
                    self.handshake_state = HandshakeState::OnChain(on_chain);
                }
                return Ok(effects);
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

        let (_continued, effects) =
            self.do_game_action(env, GameAction::Shutdown(ShutdownActionHolder(conditions)))?;
        Ok(effects)
    }
}

impl BootstrapTowardGame for PotatoHandler
{
    fn channel_offer<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error>
    {
        self.channel_initiation_transaction = Some(bundle);

        debug!("channel offer: {:?}", self.handshake_state);
        if let HandshakeState::PostStepE(info) = &self.handshake_state {
            let effect = self.try_complete_step_e(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            return Ok(effect);
        }

        Ok(None)
    }

    fn channel_transaction_completion<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error>
    {
        self.channel_finished_transaction = Some(bundle.clone());

        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            let effect = self.try_complete_step_f(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            return Ok(effect);
        }

        Ok(None)
    }
}

impl SpendWalletReceiver for PotatoHandler
{
    fn coin_created<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        coin: &CoinString,
    ) -> Result<Option<Effect>, Error>
    {
        debug!("coin created: {coin:?}");
        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            let channel_coin_created = self
                .channel_handler()
                .ok()
                .map(|ch| ch.state_channel_coin());

            debug!("checking created coin {coin:?} vs expected {channel_coin_created:?}");
            if channel_coin_created.is_some() {
                self.waiting_to_start = false;
                let effect = self.try_complete_step_f(
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?;
                return Ok(effect);
            }
        }

        Ok(None)
    }

    fn coin_spent<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();
        let (_matched, effect) = self.check_channel_spent(coin_id)?;
        effects.extend(effect);

        let (_matched, effect) = self.check_unroll_spent(coin_id)?;
        effects.extend(effect);

        let (_matched, effect) = self.check_game_coin_spent(coin_id)?;
        effects.extend(effect);

        Ok(effects)
    }

    fn coin_timeout_reached<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();
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

        if unroll_timed_out {
            let effect = self.do_unroll_spend_to_games(env, coin_id)?;
            effects.extend(effect);
            return Ok(effects);
        }

        if let HandshakeState::OnChain(on_chain) = &mut self.handshake_state {
            effects.extend(on_chain.coin_timeout_reached(env, coin_id)?);
            return Ok(effects);
        }

        Ok(effects)
    }

    fn coin_puzzle_and_solution<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();
        if let (HandshakeState::OnChain(on_chain), Some((p, s))) =
            (&mut self.handshake_state, puzzle_and_solution)
        {
            debug!("passing on game coin spend to on chain handler {coin_id:?}");
            effects.extend(on_chain.handle_game_coin_spent(env, coin_id, p, s)?);
            return Ok(effects);
        }

        if let Some((puzzle, solution)) = puzzle_and_solution {
            let spend_bundle = {
                let player_ch = self.channel_handler_mut()?;
                let conditions =
                    CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
                player_ch.handle_reward_spends(env, coin_id, &conditions)?
            };

            if let Some(spend_bundle) = spend_bundle {
                effects.extend(Some(Effect::SpendTransaction(spend_bundle)));
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
                    let effect = self.handle_channel_coin_spent(env, coin_id, puzzle_and_solution)?;
                    effects.extend(effect);
                    return Ok(effects);
                }
            }
            Some(ConditionWaitKind::Unroll(unroll_coin_id)) => {
                if *coin_id == unroll_coin_id {
                    let transition_effects =
                        self.finish_on_chain_transition(env, coin_id, puzzle_and_solution)?;
                    effects.extend(transition_effects);
                    return Ok(effects);
                }
            }
            _ => {}
        }

        Ok(effects)
    }
}
