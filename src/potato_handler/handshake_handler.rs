use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationResult,
    ChannelHandlerPrivateKeys, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, sign_reward_payout, verify_reward_payout_signature,
};
use crate::common::types::{
    Amount, CoinID, CoinString, Error, GameID, GameType, GetCoinStringParts, Hash, IntoErr,
    Program, PuzzleHash, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{format_coin, Effect, GameNotification, ResyncInfo};
use crate::potato_handler::handshake::{
    HandshakeA, HandshakeB, HandshakeStepInfo, HandshakeStepWithSpend,
};
use crate::potato_handler::types::{
    GameFactory, PeerMessage, PotatoHandlerInit, PotatoState, SpendWalletReceiver,
};
use crate::potato_handler::{make_send_debug_log, PotatoHandler};

#[derive(Debug, Serialize, Deserialize)]
enum HandshakeState {
    StepA,
    StepB,
    StepC(CoinString, Box<HandshakeA>),
    StepD(Box<HandshakeStepInfo>),
    StepE(Box<HandshakeStepInfo>),
    PostStepE(Box<HandshakeStepInfo>),
    StepF(Box<HandshakeStepInfo>),
    PostStepF(Box<HandshakeStepInfo>),
    Finished(Box<HandshakeStepWithSpend>),
    Done,
}

fn serialize_game_type_map<S: serde::Serializer>(
    map: &BTreeMap<GameType, GameFactory>,
    s: S,
) -> Result<S::Ok, S::Error> {
    use serde::Serialize;
    map.iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<(GameType, GameFactory)>>()
        .serialize(s)
}

fn deserialize_game_type_map<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<GameType, GameFactory>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = Vec::<(GameType, GameFactory)>::deserialize(deserializer)?;
    Ok(v.into_iter().collect())
}

#[derive(Serialize, Deserialize)]
pub struct HandshakeHandler {
    state: HandshakeState,
    initiator: bool,
    have_potato: PotatoState,

    channel_handler: Option<ChannelHandler>,
    channel_initiation_transaction: Option<SpendBundle>,
    channel_finished_transaction: Option<SpendBundle>,

    private_keys: ChannelHandlerPrivateKeys,
    #[serde(
        serialize_with = "serialize_game_type_map",
        deserialize_with = "deserialize_game_type_map"
    )]
    game_types: BTreeMap<GameType, GameFactory>,
    my_contribution: Amount,
    their_contribution: Amount,
    channel_timeout: Timeout,
    unroll_timeout: Timeout,
    reward_puzzle_hash: PuzzleHash,

    waiting_to_start: bool,
    incoming_messages: VecDeque<Rc<PeerMessage>>,

    #[serde(skip)]
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    replacement: Option<Box<PotatoHandler>>,
}

const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

impl HandshakeHandler {
    pub fn new(phi: PotatoHandlerInit) -> Self {
        let state = if phi.have_potato {
            HandshakeState::StepA
        } else {
            HandshakeState::StepB
        };
        HandshakeHandler {
            state,
            initiator: phi.have_potato,
            have_potato: if phi.have_potato {
                PotatoState::Present
            } else {
                PotatoState::Absent
            },
            channel_handler: None,
            channel_initiation_transaction: None,
            channel_finished_transaction: None,
            private_keys: phi.private_keys,
            game_types: phi.game_types,
            my_contribution: phi.my_contribution,
            their_contribution: phi.their_contribution,
            channel_timeout: phi.channel_timeout,
            unroll_timeout: phi.unroll_timeout,
            reward_puzzle_hash: phi.reward_puzzle_hash,
            waiting_to_start: true,
            incoming_messages: VecDeque::new(),
            last_channel_coin_spend_info: None,
            replacement: None,
        }
    }

    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.channel_handler
            .as_ref()
            .ok_or_else(|| Error::StrErr("handshake: no channel handler yet".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        self.channel_handler
            .as_mut()
            .ok_or_else(|| Error::StrErr("handshake: no channel handler yet".to_string()))
    }

    pub fn start(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
        game_assert!(
            matches!(self.state, HandshakeState::StepA),
            "start: expected StepA state"
        );

        let my_hs_info = HandshakeA {
            parent: parent_coin.clone(),
            simple: self.my_handshake_b(),
        };
        self.state =
            HandshakeState::StepC(parent_coin.clone(), Box::new(my_hs_info.clone()));

        Ok(Some(Effect::PeerHandshakeA(my_hs_info)))
    }

    fn make_channel_handler(
        &self,
        parent: CoinID,
        start_potato: bool,
        msg: &HandshakeB,
        env: &mut ChannelHandlerEnv<'_>,
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

    fn my_handshake_b(&self) -> HandshakeB {
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
        HandshakeB {
            channel_public_key,
            unroll_public_key,
            reward_puzzle_hash: self.reward_puzzle_hash.clone(),
            referee_pubkey: referee_public_key,
            reward_payout_signature: reward_payout_sig,
        }
    }

    fn receive_empty_potato(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg_envelope: &PeerMessage,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let (signatures,) = match msg_envelope {
            PeerMessage::Batch {
                actions,
                signatures,
                clean_shutdown,
            } => {
                if !actions.is_empty() || clean_shutdown.is_some() {
                    return Err(Error::StrErr(
                        "handshake: expected empty potato batch".to_string(),
                    ));
                }
                (signatures,)
            }
            _ => {
                return Err(Error::StrErr(format!(
                    "handshake: expected batch message, got {msg_envelope:?}"
                )));
            }
        };

        let spend_info = {
            let ch = self.channel_handler_mut()?;
            ch.verify_received_batch_signatures(env, signatures)?
        };
        self.last_channel_coin_spend_info = Some(spend_info);

        {
            let ch = self.channel_handler()?;
            let state_num = ch.state_number();
            let mut parts = vec![format!("[recv] state={state_num}")];
            if let Some(s) = super::format_reward_coin(
                "my_reward",
                ch.my_reward_puzzle_hash(),
                &ch.my_out_of_game_balance(),
            ) {
                parts.push(format!("  {s}"));
            }
            if let Some(s) = super::format_reward_coin(
                "their_reward",
                ch.their_reward_puzzle_hash(),
                &ch.their_out_of_game_balance(),
            ) {
                parts.push(format!("  {s}"));
            }
            effects.push(Effect::DebugLog(parts.join("\n")));
        }

        self.have_potato = PotatoState::Present;
        Ok(effects)
    }

    fn send_empty_potato(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let sigs = self.channel_handler_mut()?.send_empty_potato(env)?;
        {
            let ch = self.channel_handler()?;
            effects.push(Effect::DebugLog(make_send_debug_log(ch, &[], false)));
        }
        effects.push(Effect::PeerBatch {
            actions: vec![],
            signatures: sigs,
            clean_shutdown: None,
        });
        self.have_potato = PotatoState::Absent;
        Ok(effects)
    }

    fn try_complete_step_body<F>(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
        maybe_transaction: Option<SpendBundle>,
        ctor: F,
    ) -> Result<Option<Effect>, Error>
    where
        F: FnOnce(&SpendBundle) -> Result<Effect, Error>,
    {
        if let Some(spend) = maybe_transaction {
            let send_effect = ctor(&spend)?;

            self.state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend,
            }));

            return Ok(Some(send_effect));
        }

        Ok(None)
    }

    fn try_complete_step_e(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<Option<Effect>, Error> {
        self.try_complete_step_body(
            first_player_hs_info,
            second_player_hs_info,
            self.channel_initiation_transaction.clone(),
            |spend| {
                Ok(Effect::PeerHandshakeE {
                    bundle: spend.clone(),
                })
            },
        )
    }

    fn try_complete_step_f(
        &mut self,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<Option<Effect>, Error> {
        if self.waiting_to_start {
            return Ok(None);
        }

        self.try_complete_step_body(
            first_player_hs_info,
            second_player_hs_info,
            self.channel_finished_transaction.clone(),
            |spend| {
                Ok(Effect::PeerHandshakeF {
                    bundle: spend.clone(),
                })
            },
        )
    }

    pub fn take_potato_handler(&mut self) -> Option<PotatoHandler> {
        self.replacement.take().map(|ph| *ph)
    }

    fn try_transition_to_potato(&mut self) {
        if self.replacement.is_some() {
            return;
        }
        if self.waiting_to_start {
            return;
        }
        if let HandshakeState::Finished(_) = &self.state {
            let ch = self.channel_handler.take().expect("channel handler must exist at Finished");
            let queued_messages = std::mem::take(&mut self.incoming_messages);

            let ph = PotatoHandler::from_completed_handshake(
                self.initiator,
                ch,
                std::mem::replace(&mut self.have_potato, PotatoState::Absent),
                self.game_types.clone(),
                self.private_keys.clone(),
                self.my_contribution.clone(),
                self.their_contribution.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.reward_puzzle_hash.clone(),
                queued_messages,
                self.last_channel_coin_spend_info.take(),
            );
            self.replacement = Some(Box::new(ph));
            self.state = HandshakeState::Done;
        }
    }

    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let msg_envelope = if let Some(msg) = self.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(effects);
        };

        match &self.state {
            HandshakeState::StepA => {
                return Err(Error::StrErr(format!(
                    "handshake StepA: unexpected message before start: {msg_envelope:?}"
                )));
            }

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

                let my_hs_info = {
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
                    HandshakeB {
                        channel_public_key,
                        unroll_public_key,
                        reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                        referee_pubkey: referee_public_key,
                        reward_payout_signature: reward_payout_sig,
                    }
                };

                self.channel_handler = Some(channel_handler);
                self.state = HandshakeState::StepD(Box::new(HandshakeStepInfo {
                    first_player_hs_info: msg.clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));

                effects.push(Effect::PeerHandshakeB(my_hs_info));
            }

            HandshakeState::StepC(parent_coin, handshake_a) => {
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake b message, got {msg_envelope:?}"
                    )));
                };

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

                let our_handshake_data = self.my_handshake_b();

                {
                    let sigs = channel_handler.send_empty_potato(env)?;
                    effects.push(Effect::DebugLog(make_send_debug_log(
                        &channel_handler,
                        &[],
                        false,
                    )));
                    effects.push(Effect::PeerBatch {
                        actions: vec![],
                        signatures: sigs,
                        clean_shutdown: None,
                    });
                }

                let first_player_hs_info = *handshake_a.clone();
                self.channel_handler = Some(channel_handler);
                self.state = HandshakeState::StepE(Box::new(HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info: our_handshake_data,
                }));
            }

            HandshakeState::StepD(_info) => {
                effects.extend(self.receive_empty_potato(env, msg_envelope.borrow())?);

                let info = match std::mem::replace(&mut self.state, HandshakeState::StepA) {
                    HandshakeState::StepD(info) => info,
                    _ => unreachable!(),
                };
                self.state = HandshakeState::StepF(info);

                effects.extend(self.send_empty_potato(env)?);
            }

            HandshakeState::StepE(_info) => {
                effects.extend(self.receive_empty_potato(env, msg_envelope.borrow())?);

                let info = match std::mem::replace(&mut self.state, HandshakeState::StepA) {
                    HandshakeState::StepE(info) => info,
                    _ => unreachable!(),
                };
                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();
                self.state = HandshakeState::PostStepE(info);

                effects.extend(self.try_complete_step_e(first_player_hs, second_player_hs)?);
            }

            HandshakeState::StepF(info) => {
                let bundle = if let PeerMessage::HandshakeE { bundle } = msg_envelope.borrow() {
                    bundle
                } else {
                    self.incoming_messages.push_front(msg_envelope.clone());
                    return Ok(effects);
                };

                let channel_coin = self.channel_handler()?.state_channel_coin();
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

                self.state = HandshakeState::PostStepF(Box::new(HandshakeStepInfo {
                    first_player_hs_info: first_player_hs.clone(),
                    second_player_hs_info: second_player_hs.clone(),
                }));

                self.have_potato = PotatoState::Absent;
                effects.extend(self.try_complete_step_f(first_player_hs, second_player_hs)?);
            }

            HandshakeState::PostStepE(_) | HandshakeState::PostStepF(_) => {
                // Waiting for wallet callback; re-queue the message.
                self.incoming_messages.push_front(msg_envelope);
            }

            HandshakeState::Finished(_) => {
                match msg_envelope.borrow() {
                    PeerMessage::HandshakeF { bundle } => {
                        effects.push(Effect::ReceivedChannelOffer(bundle.clone()));
                    }
                    _ => {
                        // Non-handshake message arrived after handshake finished
                        // but before transition. Queue for PotatoHandler.
                        self.incoming_messages.push_front(msg_envelope);
                    }
                }
            }

            HandshakeState::Done => {
                self.incoming_messages.push_front(msg_envelope);
            }
        }

        self.try_transition_to_potato();
        Ok(effects)
    }

    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        if msg.len() > MAX_MESSAGE_SIZE {
            return Err(Error::StrErr(format!(
                "message too large: {} bytes (max {MAX_MESSAGE_SIZE})",
                msg.len(),
            )));
        }
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        self.incoming_messages.push_back(Rc::new(msg_envelope));
        self.process_incoming_message(env)
    }
}

impl SpendWalletReceiver for HandshakeHandler {
    fn coin_created(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        if !self.waiting_to_start {
            return Ok(None);
        }

        let has_channel_coin = self
            .channel_handler()
            .ok()
            .map(|ch| ch.state_channel_coin())
            .is_some();

        if !has_channel_coin {
            return Ok(None);
        }

        self.waiting_to_start = false;

        let channel_coin = self
            .channel_handler()
            .ok()
            .map(|ch| ch.state_channel_coin().clone())
            .expect("has_channel_coin was true");

        let mut effects = Vec::new();

        if let HandshakeState::PostStepF(info) = &self.state {
            let step_f_effects: Vec<Effect> = self
                .try_complete_step_f(
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?
                .into_iter()
                .collect();
            effects.extend(step_f_effects);
        }

        {
            let ch = self.channel_handler()?;
            effects.push(Effect::DebugLog(format!(
                "[channel-created] {} state={} have_potato={}",
                format_coin(&channel_coin),
                ch.state_number(),
                ch.have_potato(),
            )));
        }
        effects.push(Effect::Notify(GameNotification::ChannelCreated {
            channel_coin,
        }));

        self.try_transition_to_potato();
        Ok(Some(effects))
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::DebugLog(format!(
            "[handshake:coin-spent] {}",
            format_coin(coin_id),
        ))])
    }

    fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::DebugLog(format!(
            "[handshake:coin-timeout] {}",
            format_coin(coin_id),
        ))])
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        Ok((
            vec![Effect::DebugLog(format!(
                "[handshake:coin-puzzle] {}",
                format_coin(coin_id),
            ))],
            None,
        ))
    }
}

#[typetag::serde]
impl PeerHandler for HandshakeHandler {
    fn has_pending_incoming(&self) -> bool {
        !self.incoming_messages.is_empty()
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeHandler::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        <Self as SpendWalletReceiver>::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        <Self as SpendWalletReceiver>::coin_puzzle_and_solution(
            self,
            env,
            coin_id,
            puzzle_and_solution,
        )
    }
    fn make_move(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
        _readable: &ReadableMove,
        _new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "make_move not available during handshake".to_string(),
        ))
    }
    fn accept_timeout(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_timeout not available during handshake".to_string(),
        ))
    }
    fn cheat_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game_id: &GameID,
        _mover_share: Amount,
        _entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cheat_game not available during handshake".to_string(),
        ))
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        self.replacement.take().map(|ph| ph as Box<dyn PeerHandler>)
    }
    fn handshake_finished(&self) -> bool {
        false
    }
    fn channel_offer(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        self.channel_initiation_transaction = Some(bundle);

        if let HandshakeState::PostStepE(info) = &self.state {
            let result = self.try_complete_step_e(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            self.try_transition_to_potato();
            return Ok(result);
        }

        Ok(None)
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        self.channel_finished_transaction = Some(bundle.clone());

        if let HandshakeState::PostStepF(info) = &self.state {
            let result = self.try_complete_step_f(
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
            self.try_transition_to_potato();
            return Ok(result);
        }

        Ok(None)
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        HandshakeHandler::channel_handler(self)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
