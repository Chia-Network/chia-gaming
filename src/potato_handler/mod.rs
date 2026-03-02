use std::borrow::Borrow;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::mem::swap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

use rand::Rng;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::channel_handler::types::{
    AcceptTransactionState, ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationResult,
    ChannelHandlerPrivateKeys, GameStartInfoInterface, OnChainGameState, ReadableMove,
};
use crate::channel_handler::game;
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key,
    sign_reward_payout, verify_reward_payout_signature,
};
use crate::common::types::{
    chia_dialect, Aggsig, Amount, CoinCondition, CoinID, CoinSpend, CoinString, Error,
    GameID, GameType, GetCoinStringParts, Hash, IntoErr, Program, ProgramRef, Puzzle, PuzzleHash,
    Sha256Input, Spend, SpendBundle, Timeout,
};
use crate::potato_handler::effects::{Effect, GameNotification};
use crate::potato_handler::on_chain::OnChainPotatoHandler;
use crate::shutdown::{get_conditions_with_channel_handler, ShutdownConditions};

use crate::potato_handler::types::{
    BatchAction, BootstrapTowardGame, ConditionWaitKind, FromLocalUI, GameAction,
    GameFactory, PeerMessage, PotatoHandlerImpl, PotatoHandlerInit,
    PotatoState, ShutdownActionHolder, SpendWalletReceiver, GSI,
};

use crate::potato_handler::handshake::{
    HandshakeA, HandshakeB, ChannelState, HandshakeStepInfo, HandshakeStepWithSpend,
};
use crate::potato_handler::start::GameStart;

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
#[derive(Serialize, Deserialize)]
pub struct PotatoHandler {
    initiator: bool,
    have_potato: PotatoState,

    channel_state: ChannelState,

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

    peer_wants_potato: bool,

    // Cached from the most recent potato exchange so go_on_chain can fix
    // hs.spend even if the exchange happened before Finished was set.
    #[serde(skip)]
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
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
            channel_state: if phi.have_potato {
                ChannelState::StepA
            } else {
                ChannelState::StepB
            },

            game_types: phi.game_types,

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
            peer_wants_potato: false,
            last_channel_coin_spend_info: None,
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
        matches!(self.channel_state, ChannelState::OnChain(_))
    }

    pub fn is_failed(&self) -> bool {
        matches!(self.channel_state, ChannelState::Failed)
    }

    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        if let ChannelState::OnChain(on_chain) = &self.channel_state {
            on_chain.get_game_coin(game_id)
        } else {
            None
        }
    }

    pub(crate) fn cheat_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error>
    {
        let (_continued, effects) = self.do_game_action(
            env,
            GameAction::Cheat(game_id.clone(), mover_share, entropy),
        )?;

        Ok(effects)
    }

    pub fn handshake_done(&self) -> bool {
        !matches!(
            self.channel_state,
            ChannelState::StepA
                | ChannelState::StepB
                | ChannelState::StepC(_, _)
                | ChannelState::StepD(_)
                | ChannelState::StepE(_)
                | ChannelState::PostStepE(_)
                | ChannelState::StepF(_)
                | ChannelState::PostStepF(_)
        )
    }

    pub fn push_action(&mut self, action: GameAction) {
        self.game_action_queue.push_back(action);
    }

    pub fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        if let ChannelState::OnChain(ocs) = &self.channel_state {
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

        if let ChannelState::OnChain(on_chain) = &self.channel_state {
            return Ok(on_chain.channel_handler());
        }

        Err(Error::StrErr("no channel handler".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        if let Some(ch) = &mut self.channel_handler {
            return Ok(ch);
        }

        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
            return Ok(on_chain.channel_handler_mut());
        }

        Err(Error::StrErr("no channel handler".to_string()))
    }

    pub fn handshake_finished(&self) -> bool {
        matches!(
            self.channel_state,
            ChannelState::Finished(_) | ChannelState::OnChain(_)
        )
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        let ch = self.channel_handler_mut()?;
        ch.corrupt_state_for_testing(new_sn);
        Ok(())
    }

    #[cfg(test)]
    pub fn get_last_channel_coin_spend_info(&self) -> Option<&ChannelCoinSpendInfo> {
        self.last_channel_coin_spend_info.as_ref()
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
        _env: &mut ChannelHandlerEnv<'_, R>,
        parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
        let channel_public_key =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let reward_payout_sig = sign_reward_payout(
            &self.private_keys.my_referee_private_key,
            &self.reward_puzzle_hash,
        );

        assert!(matches!(self.channel_state, ChannelState::StepA));
        let my_hs_info = HandshakeA {
            parent: parent_coin.clone(),
            simple: HandshakeB {
                channel_public_key,
                unroll_public_key,
                referee_pubkey: referee_public_key,
                reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                reward_payout_signature: reward_payout_sig,
            },
        };
        self.channel_state =
            ChannelState::StepC(parent_coin.clone(), Box::new(my_hs_info.clone()));

        Ok(Some(Effect::SendMessage(PeerMessage::HandshakeA(my_hs_info))))
    }

    fn update_channel_coin_after_receive<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        spend: &ChannelCoinSpendInfo,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        self.have_potato = PotatoState::Present;

        self.last_channel_coin_spend_info = Some(spend.clone());

        // Always update hs.spend with the latest channel coin spend info so
        // that go_on_chain can use it at any time.  This must happen before
        // the early returns below.
        {
            let (channel_coin, channel_public_key) = {
                let ch = self.channel_handler()?;
                let cc = ch.state_channel_coin().clone();
                (cc, ch.get_aggregate_channel_public_key())
            };

            if let ChannelState::Finished(hs) = &mut self.channel_state {
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
            }
        }

        {
            let ch = self.channel_handler_mut()?;
            for (id, amount) in ch.drain_cached_accepts() {
                effects.push(Effect::Notification(GameNotification::WeTimedOut { id, our_reward: amount, reward_coin: None }));
            }
        }

        let (sent, batch_effects) = self.drain_queue_into_batch(env)?;
        effects.extend(batch_effects);
        if sent {
            return Ok(effects);
        }

        if self.peer_wants_potato {
            self.peer_wants_potato = false;
            let sigs = {
                let ch = self.channel_handler_mut()?;
                ch.send_empty_potato(env)?
            };
            effects.push(Effect::SendMessage(PeerMessage::Batch {
                actions: vec![],
                signatures: sigs,
                clean_shutdown: None,
            }));
            self.have_potato = PotatoState::Absent;
            return Ok(effects);
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

        match msg_envelope.borrow() {
            PeerMessage::Batch { actions, signatures, clean_shutdown } => {
                // Apply all actions sequentially
                for action in actions.iter() {
                    match action {
                        BatchAction::ProposeGame(gsi) => {
                            let ch = self.channel_handler_mut()?;
                            ch.apply_received_proposal(env, &gsi.0)?;
                            let game_id = gsi.0.game_id().clone();
                            let my_contribution = gsi.0.my_contribution_this_game().clone();
                            let their_contribution = gsi.0.their_contribution_this_game().clone();
                            effects.push(Effect::Notification(GameNotification::GameProposed {
                                id: game_id,
                                proposed_by_us: false,
                                my_contribution,
                                their_contribution,
                            }));
                        }
                        BatchAction::AcceptProposal(game_id) => {
                            let ch = self.channel_handler_mut()?;
                            ch.apply_received_accept_proposal(game_id)?;
                            effects.push(Effect::Notification(GameNotification::GameProposalAccepted {
                                id: game_id.clone(),
                            }));
                        }
                        BatchAction::CancelProposal(game_id) => {
                            let ch = self.channel_handler_mut()?;
                            ch.received_cancel_proposal(game_id)?;
                            effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                                id: game_id.clone(),
                                reason: "cancelled by peer".to_string(),
                            }));
                        }
                        BatchAction::Move(game_id, game_move) => {
                            let move_result = {
                                let ch = self.channel_handler_mut()?;
                                ch.apply_received_move(env, game_id, game_move)?
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
                        }
                        BatchAction::Accept(game_id, amount) => {
                            let ch = self.channel_handler_mut()?;
                            ch.apply_received_accept(game_id)?;
                            effects.push(Effect::Notification(GameNotification::OpponentTimedOut {
                                id: game_id.clone(),
                                our_reward: amount.clone(),
                                reward_coin: None,
                            }));
                        }
                    }
                }

                // Handle clean shutdown if present
                if let Some((sig, conditions)) = clean_shutdown {
                    let has_active = {
                        let ch = self.channel_handler_mut()?;
                        ch.has_active_games()
                    };
                    if has_active {
                        effects.push(Effect::GoingOnChain { reason: "opponent requested clean shutdown while games are active".to_string() });
                        effects.extend(self.go_on_chain(env, true)?);
                        return Ok(effects);
                    }
                    {
                        let ch = self.channel_handler_mut()?;
                        let cancelled_ids = ch.cancel_all_proposals();
                        for id in cancelled_ids {
                            effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                                id,
                                reason: "clean shutdown".to_string(),
                            }));
                        }
                    }

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

                    let reward_coin_for_state = if my_reward.to_parts().map(|(_, _, amt)| amt > Amount::default()).unwrap_or(false) {
                        Some(my_reward.clone())
                    } else {
                        None
                    };

                    {
                        let ch = self.channel_handler_mut()?;
                        for (id, amount) in ch.drain_cached_accepts() {
                            effects.push(Effect::Notification(GameNotification::WeTimedOut { id, our_reward: amount, reward_coin: None }));
                        }
                    }

                    effects.push(Effect::RegisterCoin {
                        coin: my_reward,
                        timeout: timeout.clone(),
                        name: Some("reward"),
                    });
                    effects.push(Effect::CleanShutdownStarted);

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
                    let coin_spend = CoinSpend {
                        coin: coin.clone(),
                        bundle: spend,
                    };
                    effects.push(Effect::SpendTransaction(SpendBundle {
                        name: Some("Create unroll".to_string()),
                        spends: vec![coin_spend.clone()],
                    }));

                    effects.push(Effect::SendMessage(
                        PeerMessage::CleanShutdownComplete(coin_spend),
                    ));

                    self.have_potato = PotatoState::Present;
                    self.channel_state = ChannelState::OnChainWaitingForUnrollSpend(coin.clone(), 0, reward_coin_for_state);
                    return Ok(effects);
                }

                // Verify signatures against the final state (once for all actions)
                let spend_info = {
                    let ch = self.channel_handler_mut()?;
                    ch.verify_received_batch_signatures(env, signatures)?
                };
                effects.extend(self.update_channel_coin_after_receive(env, &spend_info)?);
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_message(env, game_id, message)?
                };
                effects.push(Effect::GameMessage {
                    id: game_id.clone(),
                    readable: decoded_message,
                });
            }
            PeerMessage::CleanShutdownComplete(coin_spend) => {
                effects.push(Effect::SpendTransaction(SpendBundle {
                    name: Some("Create unroll".to_string()),
                    spends: vec![coin_spend.clone()],
                }));
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
    ) -> Result<Vec<Effect>, Error>
    where
        F: FnOnce(&SpendBundle) -> Result<PeerMessage, Error>,
    {
        if let Some(spend) = maybe_transaction {
            let send_effect = Effect::SendMessage(ctor(&spend)?);

            self.channel_state = ChannelState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend,
            }));

            return Ok(vec![send_effect, Effect::HandshakeComplete]);
        }

        Ok(vec![])
    }

    pub fn try_complete_step_e(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<Vec<Effect>, Error> {
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
    ) -> Result<Vec<Effect>, Error> {
        if self.waiting_to_start {
            return Ok(vec![]);
        }

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
    

    fn send_potato_request_if_needed(&mut self) -> Result<(bool, Option<Effect>), Error> {
        if matches!(self.have_potato, PotatoState::Present) {
            return Ok((true, None));
        }

        if matches!(self.have_potato, PotatoState::Absent) {
            self.have_potato = PotatoState::Requested;
            return Ok((false, Some(Effect::SendMessage(PeerMessage::RequestPotato(())))));
        }

        Ok((false, None))
    }

    fn drain_queue_into_batch<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        assert!(matches!(self.have_potato, PotatoState::Present));
        let mut effects = Vec::new();
        let mut batch_actions: Vec<BatchAction> = Vec::new();
        let mut clean_shutdown_data: Option<(Aggsig, ProgramRef)> = None;
        let mut deferred = VecDeque::new();
        let mut insufficient_balance_games: HashSet<GameID> = HashSet::new();

        while let Some(action) = self.game_action_queue.pop_front() {
            match action {
                GameAction::Move(game_id, readable_move, new_entropy) => {
                    if insufficient_balance_games.contains(&game_id) {
                        continue;
                    }
                    let ch = self.channel_handler_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        let move_result = ch.send_move_no_finalize(env, &game_id, &readable_move, new_entropy)?;
                        batch_actions.push(BatchAction::Move(game_id, move_result.game_move));
                    } else {
                        deferred.push_back(GameAction::Move(game_id, readable_move, new_entropy));
                    }
                }
                GameAction::Cheat(game_id, mover_share, entropy) => {
                    if insufficient_balance_games.contains(&game_id) {
                        continue;
                    }
                    let ch = self.channel_handler_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        ch.enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move = ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
                        let move_result = ch.send_move_no_finalize(env, &game_id, &readable_move, entropy)?;
                        batch_actions.push(BatchAction::Move(game_id, move_result.game_move));
                    } else {
                        deferred.push_back(GameAction::Cheat(game_id, mover_share, entropy));
                    }
                }
                GameAction::Accept(game_id) => {
                    let amount = {
                        let ch = self.channel_handler_mut()?;
                        ch.send_accept_no_finalize(&game_id)?
                    };
                    batch_actions.push(BatchAction::Accept(game_id, amount));
                }
                GameAction::QueuedProposal(my_gsi, their_gsi) => {
                    let game_id = my_gsi.0.game_id().clone();
                    let my_contribution = my_gsi.0.my_contribution_this_game().clone();
                    let their_contribution = my_gsi.0.their_contribution_this_game().clone();
                    {
                        let ch = self.channel_handler_mut()?;
                        ch.send_propose_game(env, &my_gsi.0)?;
                    }
                    effects.push(Effect::Notification(GameNotification::GameProposed {
                        id: game_id,
                        proposed_by_us: true,
                        my_contribution,
                        their_contribution,
                    }));
                    batch_actions.push(BatchAction::ProposeGame(their_gsi));
                }
                GameAction::QueuedAcceptProposal(game_id) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        let proposal = ch.find_proposal(&game_id);
                        if proposal.is_none() {
                            effects.push(Effect::Notification(GameNotification::GameCancelled {
                                id: game_id.clone(),
                            }));
                            continue;
                        }
                        let proposal = proposal.unwrap();
                        if proposal.proposed_by_us {
                            return Err(Error::StrErr("cannot accept own proposal".to_string()));
                        }
                        let our_short = proposal.my_contribution > ch.my_out_of_game_balance();
                        let their_short = proposal.their_contribution > ch.their_out_of_game_balance();
                        if our_short || their_short {
                            effects.push(Effect::Notification(GameNotification::InsufficientBalance {
                                id: game_id.clone(),
                                our_balance_short: our_short,
                                their_balance_short: their_short,
                            }));
                            insufficient_balance_games.insert(game_id);
                            continue;
                        }
                        ch.send_accept_proposal(&game_id)?;
                    }
                    effects.push(Effect::Notification(GameNotification::GameProposalAccepted {
                        id: game_id.clone(),
                    }));
                    batch_actions.push(BatchAction::AcceptProposal(game_id));
                }
                GameAction::QueuedCancelProposal(game_id) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        if !ch.is_game_proposed(&game_id) {
                            continue;
                        }
                        ch.send_cancel_proposal(&game_id)?;
                    }
                    effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                        id: game_id.clone(),
                        reason: "cancelled by us".to_string(),
                    }));
                    batch_actions.push(BatchAction::CancelProposal(game_id));
                }
                GameAction::CleanShutdown(conditions) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        if ch.has_active_games() {
                            return Err(Error::StrErr(
                                "cannot clean-shutdown with active games".to_string(),
                            ));
                        }
                        let cancelled_ids = ch.cancel_all_proposals();
                        for id in cancelled_ids {
                            effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                                id,
                                reason: "clean shutdown".to_string(),
                            }));
                        }
                    }

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

                    let reward_coin_for_state = if want_amount > Amount::default() {
                        Some(my_reward.clone())
                    } else {
                        None
                    };

                    effects.push(Effect::RegisterCoin {
                        coin: my_reward,
                        timeout,
                        name: Some("reward"),
                    });

                    let shutdown_condition_program =
                        Rc::new(Program::from_nodeptr(env.allocator, real_conditions)?);
                    clean_shutdown_data = Some((
                        spend.signature.clone(),
                        shutdown_condition_program.into(),
                    ));

                    self.channel_state =
                        ChannelState::OnChainWaitingForUnrollSpend(state_channel_coin.clone(), 0, reward_coin_for_state);
                }
                GameAction::SendPotato => {
                    unreachable!("SendPotato should not be queued");
                }
                GameAction::RedoMove(..) => {
                    return Err(Error::StrErr("redo move when not on chain".to_string()));
                }
                GameAction::RedoAccept(..) => {
                    return Err(Error::StrErr("redo accept when not on chain".to_string()));
                }
            }
        }

        self.game_action_queue = deferred;

        if batch_actions.is_empty() && clean_shutdown_data.is_none() {
            return Ok((false, effects));
        }

        let sigs = {
            let ch = self.channel_handler_mut()?;
            ch.update_cached_unroll_state(env)?
        };

        self.have_potato = PotatoState::Absent;
        effects.push(Effect::SendMessage(PeerMessage::Batch {
            actions: batch_actions,
            signatures: sigs,
            clean_shutdown: clean_shutdown_data,
        }));

        Ok((true, effects))
    }

    fn get_games_by_start_type<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        i_initiated: bool,
        game_start: &GameStart,
    ) -> Result<GameStartInfoPair, Error> {
        let starter = if let Some(starter) = self.game_types.get(&game_start.game_type) {
            starter
        } else {
            return Err(Error::StrErr(format!(
                "no such game {:?}",
                game_start.game_type
            )));
        };

        let their_contribution = game_start.amount.clone() - game_start.my_contribution.clone();

        if let Some(parser_prog) = &starter.parser_program {
            let alice_game = game::Game::new_from_proposal(
                env.allocator,
                i_initiated,
                &game_start.game_id,
                starter.program.clone().into(),
                Some(parser_prog.clone().into()),
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
                starter.program.clone().into(),
                Some(parser_prog.clone().into()),
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
                starter.program.clone().into(),
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
                starter.program.clone().into(),
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

    pub fn received_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        if matches!(self.channel_state, ChannelState::Failed) {
            return Err(Error::StrErr("channel has failed".to_string()));
        }
        let mut effects = Vec::new();
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        self.incoming_messages.push_back(Rc::new(msg_envelope));
        let incoming_result = self.process_incoming_message(env);
        match incoming_result {
            Ok(incoming_effects) => {
                effects.extend(incoming_effects);
            }
            Err(e) => {
                if matches!(self.channel_state, ChannelState::Finished(_)) {
                    effects.push(Effect::GoingOnChain { reason: format!("error processing peer message: {e:?}") });
                    effects.extend(self.go_on_chain(env, true)?);
                    return Ok(effects);
                } else {
                    return Err(e);
                }
            }
        }
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
        if !verify_reward_payout_signature(
            &msg.referee_pubkey,
            &msg.reward_puzzle_hash,
            &msg.reward_payout_signature,
        ) {
            return Err(Error::Channel(
                "Invalid reward payout signature in handshake".to_string(),
            ));
        }
        ChannelHandler::new(
            env,
            self.private_keys.clone(),
            parent,
            start_potato,
            msg.channel_public_key.clone(),
            msg.unroll_public_key.clone(),
            msg.referee_pubkey.clone(),
            msg.reward_puzzle_hash.clone(),
            msg.reward_payout_signature.clone(),
            self.my_contribution.clone(),
            self.their_contribution.clone(),
            self.unroll_timeout.clone(),
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

        match &self.channel_state {
            // non potato progression
            ChannelState::StepA => {
                let _msg = if let PeerMessage::HandshakeA(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };
            }

            ChannelState::StepC(parent_coin, handshake_a) => {
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
                let reward_payout_sig = sign_reward_payout(
                    &self.private_keys.my_referee_private_key,
                    &self.reward_puzzle_hash,
                );

                let our_handshake_data = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_pubkey: referee_public_key,
                    reward_payout_signature: reward_payout_sig,
                };

                {
                    let sigs = channel_handler.send_empty_potato(env)?;
                    effects.push(Effect::SendMessage(PeerMessage::Batch {
                        actions: vec![],
                        signatures: sigs,
                        clean_shutdown: None,
                    }));
                }

                self.next_game_id = init_game_id(parent_coin.to_bytes());
                self.channel_handler = Some(channel_handler);

                self.channel_state = ChannelState::StepE(Box::new(HandshakeStepInfo {
                    first_player_hs_info: *handshake_a.clone(),
                    second_player_hs_info: our_handshake_data.clone(),
                }));
            }

            ChannelState::StepE(info) => {
                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.channel_state = ChannelState::PostStepE(info.clone());

                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);

                effects.extend(self.try_complete_step_e(first_player_hs, second_player_hs)?);
            }

            // potato progression
            ChannelState::StepB => {
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
                let reward_payout_sig = sign_reward_payout(
                    &self.private_keys.my_referee_private_key,
                    &self.reward_puzzle_hash,
                );

                let my_hs_info = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_pubkey: referee_public_key,
                    reward_payout_signature: reward_payout_sig,
                };

                self.channel_handler = Some(channel_handler);
                self.channel_state = ChannelState::StepD(Box::new(HandshakeStepInfo {
                    first_player_hs_info: msg.clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));

                effects.push(Effect::SendMessage(PeerMessage::HandshakeB(my_hs_info)));
            }

            ChannelState::StepD(info) => {
                let parent_coin = info.first_player_hs_info.parent.clone();
                self.channel_state = ChannelState::StepF(info.clone());

                self.next_game_id = init_game_id(parent_coin.to_bytes());
                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);

                let sigs = {
                    let ch = self.channel_handler_mut()?;
                    ch.send_empty_potato(env)?
                };
                effects.push(Effect::SendMessage(PeerMessage::Batch {
                    actions: vec![],
                    signatures: sigs,
                    clean_shutdown: None,
                }));
            }

            ChannelState::StepF(info) => {
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

                self.channel_state = ChannelState::PostStepF(info.clone());

                self.have_potato = PotatoState::Absent;
                effects.extend(self.try_complete_step_f(first_player_hs, second_player_hs)?);
            }

            ChannelState::Finished(_) => {
                let going_on_chain = self
                    .channel_handler
                    .as_ref()
                    .map_or(false, |ch| ch.initiated_on_chain());

                if going_on_chain {
                    return Ok(effects);
                }

                match msg_envelope.borrow() {
                    PeerMessage::HandshakeF { bundle } => {
                        self.channel_finished_transaction = Some(bundle.clone());
                        effects.push(Effect::ReceivedChannelOffer(bundle.clone()));
                    }
                    PeerMessage::RequestPotato(_) => {
                        self.peer_wants_potato = true;
                        if matches!(self.have_potato, PotatoState::Present) {
                            let sigs = {
                                let ch = self.channel_handler_mut()?;
                                ch.send_empty_potato(env)?
                            };
                            effects.push(Effect::SendMessage(PeerMessage::Batch {
                                actions: vec![],
                                signatures: sigs,
                                clean_shutdown: None,
                            }));
                            self.have_potato = PotatoState::Absent;
                            self.peer_wants_potato = false;
                        }
                    }
                    _ => {
                        effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);
                    }
                }

                return Ok(effects);
            }

            ChannelState::OnChainWaitingForUnrollSpend(..) => {
                if matches!(msg_envelope.borrow(), PeerMessage::CleanShutdownComplete(_)) {
                    effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);
                    return Ok(effects);
                }
                self.incoming_messages.push_back(msg_envelope);
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
    ) -> Result<(bool, Vec<Effect>), Error> {
        if let Some(ch) = self.channel_handler.as_ref() {
            let channel_coin = ch.state_channel_coin();
            if coin_id == channel_coin {
                let mut hs = ChannelState::StepA;
                swap(&mut hs, &mut self.channel_state);
                match hs {
                    ChannelState::Finished(hs) => {
                        self.channel_state =
                            ChannelState::OnChainWaitForConditions(channel_coin.clone(), hs);
                        assert!(!matches!(self.channel_state, ChannelState::StepA));
                        return Ok((true, vec![Effect::RequestPuzzleAndSolution(coin_id.clone())]));
                    }
                    ChannelState::OnChainWaitingForUnrollSpend(channel_coin, _, reward_coin) => {
                        self.channel_state = ChannelState::CleanShutdownWaitForConditions(
                            channel_coin, reward_coin,
                        );
                        assert!(!matches!(self.channel_state, ChannelState::StepA));
                        return Ok((true, vec![Effect::RequestPuzzleAndSolution(coin_id.clone())]));
                    }
                    ChannelState::Failed => {
                        self.channel_state = ChannelState::Failed;
                        return Ok((false, vec![]));
                    }
                    x => {
                        self.channel_state = x;
                        assert!(!matches!(self.channel_state, ChannelState::StepA));
                        return Err(Error::StrErr(
                            "channel coin spend in non-handshake state".to_string(),
                        ));
                    }
                }
            }
        }

        assert!(!matches!(self.channel_state, ChannelState::StepA));
        Ok((false, vec![]))
    }

    fn unroll_start_condition_check(
        &mut self,
        coin_id: &CoinString,
        on_chain_state: usize,
    ) -> Result<Effect, Error> {
        self.channel_state = ChannelState::OnChainWaitingForUnrollConditions(coin_id.clone(), on_chain_state);
        Ok(Effect::RequestPuzzleAndSolution(coin_id.clone()))
    }

    // Tell whether the channel coin was spent in a way that requires us potentially to
    // fast forward games using interactions with their on-chain coin forms.
    fn check_unroll_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error> {
        let unroll_info = match &self.channel_state {
            ChannelState::OnChainWaitingForUnrollSpend(unroll_coin, sn, ..) if coin_id == unroll_coin => {
                Some(*sn)
            }
            ChannelState::OnChainWaitingForUnrollTimeoutOrSpend(unroll_coin, sn) if coin_id == unroll_coin => {
                Some(*sn)
            }
            _ => None,
        };

        if let Some(on_chain_state) = unroll_info {
            let effect = self.unroll_start_condition_check(coin_id, on_chain_state)?;
            return Ok((true, Some(effect)));
        }

        Ok((false, None))
    }

    /// Spend the unroll coin via the default/timeout path.  The timeout
    /// conditions include ASSERT_HEIGHT_RELATIVE so this path only succeeds
    /// after the timelock elapses.  No aggregate signature is needed — the
    /// CLSP simply verifies the hash of the revealed conditions.
    ///
    /// `on_chain_state` is the state_number the on-chain unroll coin was
    /// created at.  We look up the matching stored UnrollCoin (either
    /// `self.unroll` or `self.timeout`) so the puzzle hash matches.
    pub fn do_unroll_spend_to_games<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        unroll_coin: &CoinString,
        on_chain_state: usize,
    ) -> Result<Option<Effect>, Error> {
        let spend_bundle = {
            let player_ch = self.channel_handler()?;
            let matching_unroll = player_ch.get_unroll_for_state(on_chain_state)?;
            let curried_unroll_puzzle = matching_unroll
                .coin
                .make_curried_unroll_puzzle(env, &player_ch.get_aggregate_unroll_public_key())?;
            let curried_unroll_program =
                Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?;
            let timeout_solution = matching_unroll
                .coin
                .make_timeout_unroll_solution(env)?;
            let timeout_solution_program = Program::from_nodeptr(env.allocator, timeout_solution)?;

            SpendBundle {
                name: Some("create unroll (timeout)".to_string()),
                spends: vec![CoinSpend {
                    bundle: Spend {
                        puzzle: curried_unroll_program,
                        solution: timeout_solution_program.into(),
                        signature: Aggsig::default(),
                    },
                    coin: unroll_coin.clone(),
                }],
            }
        };

        self.channel_state = ChannelState::OnChainWaitingForUnrollSpend(unroll_coin.clone(), on_chain_state, None);

        Ok(Some(Effect::SpendTransaction(spend_bundle)))
    }

    /// Submit transactions to move the channel on-chain.  The handshake state
    /// stays `Finished` — normal blockchain monitoring will detect the channel
    /// coin spend and route through `handle_channel_coin_spent`, the same path
    /// used when the opponent initiates the unroll.
    pub fn go_on_chain<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        if matches!(self.channel_state, ChannelState::Failed) {
            return Err(Error::StrErr("channel has failed".to_string()));
        }
        if !matches!(self.channel_state, ChannelState::Finished(_)) {
            return Err(Error::StrErr(
                "go on chain before handshake finished".to_string(),
            ));
        }

        let mut effects = Vec::new();

        {
            let player_ch = self.channel_handler_mut()?;
            player_ch.set_initiated_on_chain();
            if got_error {
                player_ch.set_on_chain_for_error();
            }
            let cancelled_ids = player_ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                    id,
                    reason: "going on chain".to_string(),
                }));
            }
        }

        // If the last potato exchange happened before Finished was set,
        // hs.spend still contains the channel creation bundle.  Patch it
        // now using the cached spend info from the last exchange.
        if let Some(saved) = self.last_channel_coin_spend_info.clone() {
            let (channel_coin, channel_public_key) = {
                let ch = self.channel_handler()?;
                (
                    ch.state_channel_coin().clone(),
                    ch.get_aggregate_channel_public_key(),
                )
            };
            let channel_coin_puzzle = puzzle_for_synthetic_public_key(
                env.allocator,
                &env.standard_puzzle,
                &channel_public_key,
            )?;
            if let ChannelState::Finished(hs) = &mut self.channel_state {
                hs.spend.spends = vec![CoinSpend {
                    coin: channel_coin,
                    bundle: Spend {
                        solution: saved.solution.clone().into(),
                        signature: saved.aggsig.clone(),
                        puzzle: channel_coin_puzzle,
                    },
                }];
            }
        }

        // hs.spend is maintained by update_channel_coin_after_receive on each
        // potato exchange.  It already contains the correct puzzle, solution
        // and aggregate signature to spend the channel coin into the unroll
        // coin at the current state.
        if let ChannelState::Finished(hs) = &self.channel_state {
            effects.push(Effect::SpendTransaction(hs.spend.clone()));
        }

        Ok(effects)
    }

    /// Build a channel-coin-to-unroll spend bundle regardless of current
    /// handshake state.  Used by test infrastructure to simulate a malicious
    /// peer that submits an unroll after agreeing to clean shutdown.
    pub fn force_unroll_spend<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<SpendBundle, Error> {
        let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
            Error::StrErr("force_unroll_spend: no channel coin spend info cached".to_string())
        })?;

        let (channel_coin, channel_public_key) = {
            let ch = self.channel_handler()?;
            (
                ch.state_channel_coin().clone(),
                ch.get_aggregate_channel_public_key(),
            )
        };
        let channel_coin_puzzle = puzzle_for_synthetic_public_key(
            env.allocator,
            &env.standard_puzzle,
            &channel_public_key,
        )?;

        Ok(SpendBundle {
            name: Some("force unroll".to_string()),
            spends: vec![CoinSpend {
                coin: channel_coin,
                bundle: Spend {
                    solution: saved.solution.clone().into(),
                    signature: saved.aggsig.clone(),
                    puzzle: channel_coin_puzzle,
                },
            }],
        })
    }

    #[cfg(test)]
    pub fn force_stale_unroll_spend<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
        saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error> {
        let (channel_coin, channel_public_key) = {
            let ch = self.channel_handler()?;
            (
                ch.state_channel_coin().clone(),
                ch.get_aggregate_channel_public_key(),
            )
        };
        let channel_coin_puzzle = puzzle_for_synthetic_public_key(
            env.allocator,
            &env.standard_puzzle,
            &channel_public_key,
        )?;

        Ok(SpendBundle {
            name: Some("force stale unroll".to_string()),
            spends: vec![CoinSpend {
                coin: channel_coin,
                bundle: Spend {
                    solution: saved.solution.clone().into(),
                    signature: saved.aggsig.clone(),
                    puzzle: channel_coin_puzzle,
                },
            }],
        })
    }

    /// If we have the potato and aren't going on-chain, flush the action queue
    /// into a batch. Otherwise request the potato from the peer.
    fn flush_or_request_potato<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        let going_on_chain = self
            .channel_handler
            .as_ref()
            .map_or(false, |ch| ch.initiated_on_chain());

        if going_on_chain {
            return Ok((false, vec![]));
        }

        let (has_potato, effect) = self.send_potato_request_if_needed()?;
        let mut effects: Vec<Effect> = effect.into_iter().collect();
        if has_potato {
            let (sent, batch_effects) = self.drain_queue_into_batch(env)?;
            effects.extend(batch_effects);
            return Ok((sent, effects));
        }

        Ok((false, effects))
    }

    fn do_game_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        action: GameAction,
    ) -> Result<(bool, Vec<Effect>), Error> {
        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
            let effects = on_chain.do_on_chain_action(env, action)?;
            return Ok((true, effects));
        }

        if matches!(
            &self.channel_state,
            ChannelState::OnChainWaitForConditions(_, _)
                | ChannelState::OnChainWaitingForUnrollTimeoutOrSpend(..)
                | ChannelState::OnChainWaitingForUnrollConditions(..)
                | ChannelState::OnChainWaitingForUnrollSpend(..)
                | ChannelState::CleanShutdownWaitForConditions(..)
        ) {
            self.push_action(action);
            return Ok((false, vec![]));
        }

        if matches!(self.channel_state, ChannelState::Finished(_)) {
            self.push_action(action);
            return self.flush_or_request_potato(env);
        }

        Err(Error::StrErr(format!(
            "move without finishing handshake (state {:?})",
            self.channel_state
        )))
    }

    fn handle_channel_coin_spent<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr(
                "Retrieve of puzzle and solution failed for channel coin".to_string(),
            ));
        };

        let mut effects = Vec::new();

        let run_puzzle = puzzle.to_nodeptr(env.allocator)?;
        let run_args = solution.to_nodeptr(env.allocator)?;
        let conditions_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        let conditions_nodeptr = conditions_result.1;

        let channel_conditions =
            CoinCondition::from_nodeptr(env.allocator, conditions_nodeptr);

        let unroll_coin = channel_conditions
            .iter()
            .find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    let created = CoinString::from_parts(&coin_id.to_coin_id(), ph, amt);
                    return Some(created);
                }
                None
            })
            .ok_or_else(|| {
                Error::StrErr("channel conditions didn't include a coin creation".to_string())
            })?;

        // Cancel all proposals when the channel goes on-chain
        {
            let ch = self.channel_handler_mut()?;
            let cancelled_ids = ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notification(GameNotification::GameProposalCancelled {
                    id,
                    reason: "channel went on-chain".to_string(),
                }));
            }
        }

        effects.push(Effect::Notification(GameNotification::ChannelCoinSpent));

        effects.extend(self.handle_unroll_from_channel_conditions(
            env, conditions_nodeptr, &unroll_coin,
        )?);

        Ok(effects)
    }

    /// Shared logic for handling a channel coin spend that produced an unroll
    /// coin.  Determines whether to preempt or wait for timeout, registers the
    /// unroll coin, and transitions `channel_state` accordingly.
    ///
    /// Called from both `handle_channel_coin_spent` (normal unroll path) and
    /// the clean-shutdown-fallback path when an unroll lands instead of the
    /// clean shutdown transaction.
    fn handle_unroll_from_channel_conditions<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        conditions_nodeptr: NodePtr,
        unroll_coin: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        let on_chain_state = {
            let player_ch = self.channel_handler()?;
            player_ch.unrolling_state_from_conditions(env, conditions_nodeptr)?
        };

        // Determine preempt vs timeout.  Four outcomes:
        //  - Ok(timeout: false)      → preemption succeeded, submit it
        //  - Ok(timeout: true)       → timeout path (state numbers equal)
        //  - Err + timeout possible  → fall back to timeout
        //  - Err + timeout impossible→ unrecoverable: emit notification
        let spend_result = {
            let player_ch = self.channel_handler()?;
            player_ch.channel_coin_spent(env, false, conditions_nodeptr)
        };

        enum Outcome { Preempted, WaitForTimeout, Unrecoverable(String) }

        let outcome = match spend_result {
            Ok(result) if !result.timeout => {
                effects.push(Effect::SpendTransaction(SpendBundle {
                    name: Some("preempt unroll".to_string()),
                    spends: vec![CoinSpend {
                        bundle: result.transaction,
                        coin: unroll_coin.clone(),
                    }],
                }));
                Outcome::Preempted
            }
            Ok(_) => Outcome::WaitForTimeout,
            Err(e) => {
                let can_timeout = {
                    let player_ch = self.channel_handler()?;
                    player_ch.get_unroll_for_state(on_chain_state).is_ok()
                };
                if can_timeout {
                    Outcome::WaitForTimeout
                } else {
                    let reason = format!(
                        "cannot preempt ({e:?}) and no stored state for timeout at {on_chain_state}"
                    );
                    Outcome::Unrecoverable(reason)
                }
            }
        };

        match outcome {
            Outcome::Preempted => {
                self.channel_state = ChannelState::OnChainWaitingForUnrollSpend(
                    unroll_coin.clone(), on_chain_state, None,
                );
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin.clone(),
                    timeout: self.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            Outcome::WaitForTimeout => {
                self.channel_state = ChannelState::OnChainWaitingForUnrollTimeoutOrSpend(
                    unroll_coin.clone(), on_chain_state,
                );
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin.clone(),
                    timeout: self.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            Outcome::Unrecoverable(ref reason) => {
                effects.push(Effect::Notification(GameNotification::ChannelError {
                    reason: reason.clone(),
                }));
                self.channel_state = ChannelState::Failed;
            }
        }

        Ok(effects)
    }

    /// Handle the puzzle-and-solution callback for a channel coin that was
    /// spent while we were in clean-shutdown mode.  Inspects the actual
    /// conditions to decide whether the clean shutdown transaction landed
    /// (our expected reward coin is present) or an unroll landed instead.
    fn handle_clean_shutdown_conditions<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let (puzzle, solution) = puzzle_and_solution.ok_or_else(|| {
            Error::StrErr("Retrieve of puzzle and solution failed for channel coin".to_string())
        })?;

        let reward_coin = if let ChannelState::CleanShutdownWaitForConditions(_, ref rc) = self.channel_state {
            rc.clone()
        } else {
            return Err(Error::StrErr("handle_clean_shutdown_conditions called in wrong state".to_string()));
        };

        let run_puzzle = puzzle.to_nodeptr(env.allocator)?;
        let run_args = solution.to_nodeptr(env.allocator)?;
        let conditions_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        let conditions_nodeptr = conditions_result.1;

        let channel_conditions =
            CoinCondition::from_nodeptr(env.allocator, conditions_nodeptr);

        let is_clean_shutdown = if let Some(expected) = &reward_coin {
            if let Some((_, expected_ph, expected_amt)) = expected.to_parts() {
                channel_conditions.iter().any(|c| {
                    matches!(c, CoinCondition::CreateCoin(ph, amt) if *ph == expected_ph && *amt == expected_amt)
                })
            } else {
                false
            }
        } else {
            // Our share is zero — we have no reward coin to look for.
            // Fall back to checking for REM conditions: clean shutdown
            // conditions never include REM, unroll conditions always do.
            !channel_conditions.iter().any(|c| matches!(c, CoinCondition::Rem(_)))
        };

        if is_clean_shutdown {
            self.channel_state = ChannelState::Completed;
            let mut effects = Vec::new();
            {
                let ch = self.channel_handler_mut()?;
                for (id, amount) in ch.drain_cached_accepts() {
                    effects.push(Effect::Notification(GameNotification::WeTimedOut { id, our_reward: amount, reward_coin: None }));
                }
            }
            effects.push(Effect::CleanShutdownComplete { reward_coin });
            return Ok(effects);
        }

        // An unroll landed instead of the clean shutdown transaction.
        let mut effects = Vec::new();

        let unroll_coin = channel_conditions
            .iter()
            .find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    Some(CoinString::from_parts(&coin_id.to_coin_id(), ph, amt))
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                Error::StrErr("channel conditions didn't include a coin creation".to_string())
            })?;

        effects.push(Effect::Notification(GameNotification::ChannelCoinSpent));

        effects.extend(self.handle_unroll_from_channel_conditions(
            env, conditions_nodeptr, &unroll_coin,
        )?);

        Ok(effects)
    }

    // All remaining work to finish the on chain transition.  We have the state number and
    // the actual coins used to go on chain with.  We must construct a view of the games that
    // matches the state system given so on chain play can proceed.
    fn finish_on_chain_transition<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        unroll_coin: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
        on_chain_state: usize,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let (puzzle, solution) = if let Some((puzzle, solution)) = puzzle_and_solution {
            (puzzle, solution)
        } else {
            return Err(Error::StrErr("no conditions for unroll coin".to_string()));
        };

        let (game_map, on_chain_reward_coin) = {
            let player_ch = self.channel_handler_mut()?;

            let pre_game_ids: HashSet<GameID> =
                player_ch.live_game_ids().into_iter().collect();

            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

            let reward_puzzle_hash = player_ch.get_reward_puzzle_hash(env)?;
            let their_reward_puzzle_hash = player_ch.get_opponent_reward_puzzle_hash();
            let unroll_coin_id = unroll_coin.to_coin_id();
            let reward_coin = conditions.iter().find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if *ph == reward_puzzle_hash && *amt > Amount::default() {
                        return Some(CoinString::from_parts(&unroll_coin_id, ph, amt));
                    }
                }
                None
            });
            let reward_amount = conditions.iter().find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if *ph == reward_puzzle_hash {
                        return Some(amt.clone());
                    }
                }
                None
            }).unwrap_or_default();
            effects.push(Effect::Notification(GameNotification::UnrollCoinSpent {
                reward_coin: reward_coin.clone(),
            }));

            let last_received = player_ch.get_last_received_state();
            let is_stale = on_chain_state < last_received;

            log::debug!(
                "finish_on_chain_transition: on_chain_state={}, last_received_state={}, current_state_number={}, have_potato={}, is_stale={}",
                on_chain_state,
                last_received,
                player_ch.get_state_number(),
                player_ch.have_potato(),
                is_stale,
            );

            let created_coins: Vec<(PuzzleHash, Amount)> = conditions
                .iter()
                .filter_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *amt > Amount::default()
                            && *ph != reward_puzzle_hash
                            && *ph != their_reward_puzzle_hash
                        {
                            return Some((ph.clone(), amt.clone()));
                        }
                    }

                    None
                })
                .collect();

            if is_stale {
                effects.push(Effect::Notification(GameNotification::OpponentStaleUnroll {
                    our_reward: reward_amount,
                    reward_coin: reward_coin.clone(),
                }));

                // Stale unroll: per-game matching.  For each on-chain game
                // coin, check current PH+amount first, then cached prior
                // PH+amount for redo, else the game is errored.
                let (game_map_inner, errored_games) = player_ch.set_state_for_coins(env, unroll_coin, &created_coins)?;

                let surviving_ids: HashSet<GameID> = game_map_inner
                    .values()
                    .map(|def| def.game_id.clone())
                    .chain(errored_games.iter().map(|(gid, _)| gid.clone()))
                    .collect();
                for cancelled_id in pre_game_ids.difference(&surviving_ids) {
                    effects.push(Effect::Notification(GameNotification::GameCancelled {
                        id: cancelled_id.clone(),
                    }));
                }

                for (game_id, _coin) in &errored_games {
                    effects.push(Effect::Notification(GameNotification::GameError {
                        id: game_id.clone(),
                        reason: "game coin at unrecognized state after stale unroll".to_string(),
                    }));
                }

                (game_map_inner, reward_coin)
            } else {
                // Current or redo case.  Games matched by amount but not
                // by PH are still live (e.g. the other player's view of
                // a redo state); keep them in the game_map with our_turn
                // based on the live game's perspective.
                let (mut game_map_inner, errored_games) = player_ch.set_state_for_coins(env, unroll_coin, &created_coins)?;

                for (game_id, coin_id) in errored_games {
                    if let Some(lg) = player_ch.find_live_game(&game_id) {
                        let game_timeout = lg.get_game_timeout();
                        game_map_inner.insert(
                            coin_id,
                            OnChainGameState {
                                game_id,
                                puzzle_hash: PuzzleHash::default(),
                                our_turn: false,
                                state_number: player_ch.get_state_number(),
                                accept: AcceptTransactionState::Waiting,
                                pending_slash_amount: None,
                                cheating_move_mover_share: None,
                                accepted: false,
                                notification_sent: false,
                                game_timeout,
                            },
                        );
                    }
                }

                let surviving_ids: HashSet<GameID> = game_map_inner
                    .values()
                    .map(|def| def.game_id.clone())
                    .collect();
                for cancelled_id in pre_game_ids.difference(&surviving_ids) {
                    effects.push(Effect::Notification(GameNotification::GameCancelled {
                        id: cancelled_id.clone(),
                    }));
                }

                (game_map_inner, reward_coin)
            }
        };

        if game_map.is_empty() {
            self.channel_state = ChannelState::Completed;
            effects.push(Effect::CleanShutdownComplete { reward_coin: on_chain_reward_coin });
            return Ok(effects);
        }

        for (coin, state) in game_map.iter() {
            effects.push(Effect::RegisterCoin {
                coin: coin.clone(),
                timeout: state.game_timeout.clone(),
                name: Some("game coin"),
            });
        }

        for coin in game_map.keys() {
            let player_ch = self.channel_handler_mut()?;
            if let Some(redo_move) = player_ch.get_redo_action(env, coin)? {
                self.game_action_queue.push_front(redo_move);
            }
        }

        let mut on_chain_queue = VecDeque::new();
        while let Some(action) = self.game_action_queue.pop_front() {
            match &action {
                GameAction::CleanShutdown(_) => {}
                _ => on_chain_queue.push_back(action),
            }
        }

        let mut swap_player_ch: Option<ChannelHandler> = None;
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
            self.channel_state = ChannelState::OnChain(Box::new(on_chain));
        } else {
            return Err(Error::StrErr("no channel handler yet".to_string()));
        }

        Ok(effects)
    }

    fn check_game_coin_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error> {
        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
            let (result, effect) = on_chain.check_game_coin_spent(coin_id)?;
            return Ok((result, effect));
        }

        Ok((false, None))
    }

    pub fn get_game_state_id<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Option<Hash>, Error> {
        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
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
    fn propose_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>
    {
        if !matches!(self.channel_state, ChannelState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "propose_game without finishing handshake: {:?}",
                self.channel_state
            )));
        }

        self.game_action_queue
            .retain(|a| !matches!(a, GameAction::CleanShutdown(_)));

        let (my_games, their_games) = self.get_games_by_start_type(env, true, game)?;

        let (my_games, their_games) = if game.my_turn {
            (my_games, their_games)
        } else {
            (their_games, my_games)
        };

        let game_id_list: Vec<GameID> = my_games.iter().map(|g| g.game_id().clone()).collect();

        for (mine, theirs) in my_games.into_iter().zip(their_games.into_iter()) {
            self.push_action(GameAction::QueuedProposal(GSI(mine), GSI(theirs)));
        }

        let (_sent, effects) = self.flush_or_request_potato(env)?;
        Ok((game_id_list, effects))
    }

    fn accept_proposal<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>
    {
        let (_continued, effects) = self.do_game_action(
            env,
            GameAction::QueuedAcceptProposal(game_id.clone()),
        )?;
        Ok(effects)
    }

    fn cancel_proposal<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>
    {
        let (_continued, effects) = self.do_game_action(
            env,
            GameAction::QueuedCancelProposal(game_id.clone()),
        )?;
        Ok(effects)
    }

    fn make_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>
    {
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
        if matches!(self.channel_state, ChannelState::OnChain(_)) {
            return Err(Error::StrErr(
                "shut_down called while on-chain; on-chain completion is automatic".to_string(),
            ));
        }

        if !matches!(self.channel_state, ChannelState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "shut_down without finishing handshake {:?}",
                self.channel_state
            )));
        }

        let (_continued, effects) =
            self.do_game_action(env, GameAction::CleanShutdown(ShutdownActionHolder(conditions)))?;
        Ok(effects)
    }
}

impl BootstrapTowardGame for PotatoHandler
{
    fn channel_offer<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        bundle: SpendBundle,
    ) -> Result<Option<Vec<Effect>>, Error>
    {
        self.channel_initiation_transaction = Some(bundle);

        if let ChannelState::PostStepE(info) = &self.channel_state {
            let effects = self.try_complete_step_e(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            if !effects.is_empty() {
                return Ok(Some(effects));
            }
        }

        Ok(None)
    }

    fn channel_transaction_completion<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        bundle: &SpendBundle,
    ) -> Result<Option<Vec<Effect>>, Error>
    {
        self.channel_finished_transaction = Some(bundle.clone());

        if let ChannelState::PostStepF(info) = &self.channel_state {
            let effects = self.try_complete_step_f(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            if !effects.is_empty() {
                return Ok(Some(effects));
            }
        }

        Ok(None)
    }
}

impl SpendWalletReceiver for PotatoHandler
{
    fn coin_created<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_, R>,
        _coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error>
    {
        if let ChannelState::PostStepF(info) = &self.channel_state {
            let channel_coin_created = self
                .channel_handler()
                .ok()
                .map(|ch| ch.state_channel_coin());

            if channel_coin_created.is_some() {
                self.waiting_to_start = false;
                let effects = self.try_complete_step_f(
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?;
                if !effects.is_empty() {
                    return Ok(Some(effects));
                }
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
        let hs_desc = match &self.channel_state {
            ChannelState::OnChainWaitingForUnrollSpend(uc, sn, _) =>
                format!("OnChainWaitingForUnrollSpend(coin={uc:?}, sn={sn})"),
            ChannelState::OnChainWaitingForUnrollTimeoutOrSpend(uc, sn) =>
                format!("OnChainWaitingForUnrollTimeoutOrSpend(coin={uc:?}, sn={sn})"),
            ChannelState::OnChainWaitingForUnrollConditions(uc, sn) =>
                format!("OnChainWaitingForUnrollConditions(coin={uc:?}, sn={sn})"),
            ChannelState::OnChain(_) => "OnChain".to_string(),
            ChannelState::Failed => "Failed".to_string(),
            other => format!("{:?}", std::mem::discriminant(other)),
        };
        log::debug!("coin_spent called: coin_id={coin_id:?} channel_state={hs_desc}");
        if matches!(self.channel_state, ChannelState::Failed) {
            return Ok(vec![]);
        }
        let mut effects = Vec::new();
        let (_matched_ch, effect) = self.check_channel_spent(coin_id)?;
        effects.extend(effect);

        let (matched_unroll, effect) = self.check_unroll_spent(coin_id)?;
        log::debug!("check_unroll_spent: matched={matched_unroll} for coin_id={coin_id:?}");
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
        if matches!(self.channel_state, ChannelState::Failed) {
            return Ok(vec![]);
        }
        let mut effects = Vec::new();
        // We should be in state OnChainWaitingForUnrollTimeoutOrSpend
        // We'll spend the unroll coin via do_unroll_spend_to_games with the default
        // reveal and go to OnChainWaitingForUnrollSpend, transitioning to OnChain when
        // we receive the unroll coin spend.
        let unroll_timed_out = match &self.channel_state {
            ChannelState::OnChainWaitingForUnrollTimeoutOrSpend(unroll, sn)
                if coin_id == unroll => Some(*sn),
            ChannelState::OnChainWaitingForUnrollSpend(unroll, sn, _)
                if coin_id == unroll => Some(*sn),
            _ => None,
        };

        if let Some(on_chain_state) = unroll_timed_out {
            match self.do_unroll_spend_to_games(env, coin_id, on_chain_state) {
                Ok(effect) => {
                    effects.extend(effect);
                }
                Err(e) => {
                    let reason = format!(
                        "timeout unroll failed for state {on_chain_state}: {e:?}"
                    );
                    effects.push(Effect::Notification(GameNotification::ChannelError {
                        reason,
                    }));
                    self.channel_state = ChannelState::Failed;
                }
            }
            return Ok(effects);
        }

        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
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
        if matches!(self.channel_state, ChannelState::Failed) {
            return Ok(vec![]);
        }
        let mut effects = Vec::new();
        if let ChannelState::OnChain(on_chain) = &mut self.channel_state {
            if let Some((p, s)) = puzzle_and_solution {
                effects.extend(on_chain.handle_game_coin_spent(env, coin_id, p, s)?);
                return Ok(effects);
            } else if let Some((game_id, our_turn)) = on_chain.remove_game_coin_info(coin_id) {
                let reason = if our_turn {
                    "our turn coin spent unexpectedly".to_string()
                } else {
                    "opponent made impossible spend".to_string()
                };
                let notification = GameNotification::GameError { id: game_id.clone(), reason };
                effects.push(Effect::Notification(notification));
                effects.extend(on_chain.next_action(env)?);
                return Ok(effects);
            }
        }

        if let ChannelState::CleanShutdownWaitForConditions(ref channel_coin_id, _) = self.channel_state {
            if *coin_id == *channel_coin_id {
                match self.handle_clean_shutdown_conditions(env, coin_id, puzzle_and_solution) {
                    Ok(effect) => {
                        effects.extend(effect);
                    }
                    Err(e) => {
                        let reason = format!("clean shutdown condition check failed: {e:?}");
                        effects.push(Effect::Notification(
                            GameNotification::ChannelError { reason },
                        ));
                        self.channel_state = ChannelState::Failed;
                    }
                }
                return Ok(effects);
            }
        }

        let state_coin_id = match &self.channel_state {
            ChannelState::OnChainWaitForConditions(state_coin_id, _data) => {
                Some(ConditionWaitKind::Channel(state_coin_id.clone()))
            }
            // During clean shutdown the first field is the channel coin, not
            // an unroll coin.  Ignore it here — the channel coin will be
            // handled via CleanShutdownWaitForConditions after new_block.
            ChannelState::OnChainWaitingForUnrollSpend(unroll_id, sn, None) => {
                Some(ConditionWaitKind::Unroll(unroll_id.clone(), *sn))
            }
            ChannelState::OnChainWaitingForUnrollConditions(unroll_id, sn) => {
                Some(ConditionWaitKind::Unroll(unroll_id.clone(), *sn))
            }
            _ => None,
        };

        match state_coin_id {
            Some(ConditionWaitKind::Channel(state_coin_id)) => {
                if *coin_id == state_coin_id {
                    match self.handle_channel_coin_spent(env, coin_id, puzzle_and_solution) {
                        Ok(effect) => {
                            effects.extend(effect);
                        }
                        Err(e) => {
                            let reason = format!("channel coin spent to non-unroll: {e:?}");
                            effects.push(Effect::Notification(
                                GameNotification::ChannelError { reason },
                            ));
                            self.channel_state = ChannelState::Failed;
                        }
                    }
                    return Ok(effects);
                }
            }
            Some(ConditionWaitKind::Unroll(unroll_coin_id, on_chain_state)) => {
                if *coin_id == unroll_coin_id {
                    match self.finish_on_chain_transition(env, coin_id, puzzle_and_solution, on_chain_state) {
                        Ok(transition_effects) => {
                            effects.extend(transition_effects);
                        }
                        Err(e) => {
                            let reason = format!("unroll coin spent with unexpected state: {e:?}");
                            effects.push(Effect::Notification(
                                GameNotification::ChannelError { reason },
                            ));
                            self.channel_state = ChannelState::Failed;
                        }
                    }
                    return Ok(effects);
                }
            }
            _ => {}
        }

        Ok(effects)
    }
}
