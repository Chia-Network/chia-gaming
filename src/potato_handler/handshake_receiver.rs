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
    Program, PuzzleHash, Sha256Input, Sha256tree, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{
    format_coin, ChannelState, ChannelStatusSnapshot, Effect, ResyncInfo,
};
use crate::potato_handler::handshake::{
    CoinSpendRequest, HandshakeB, HandshakeD, HandshakeStepInfo, HandshakeStepWithSpend,
    RawCoinCondition,
};
use crate::potato_handler::types::{
    GameFactory, PeerMessage, PotatoHandlerInit, PotatoState, SpendWalletReceiver,
};
use crate::potato_handler::PotatoHandler;

#[derive(Debug, Serialize, Deserialize)]
enum ReceiverState {
    WaitingForA,
    SentB(Box<HandshakeStepInfo>),
    SentD(Box<HandshakeStepInfo>),
    WaitingForCompletion(Box<HandshakeStepInfo>, SpendBundle),
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
pub struct HandshakeReceiverHandler {
    state: ReceiverState,
    have_potato: PotatoState,

    channel_handler: Option<ChannelHandler>,
    channel_finished_transaction: Option<SpendBundle>,
    launcher_coin: Option<CoinString>,

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

    last_height: u64,
    channel_deadline: Option<u64>,
    pending_coin_spend: bool,

    waiting_to_start: bool,
    incoming_messages: VecDeque<Rc<PeerMessage>>,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    replacement: Option<Box<PotatoHandler>>,
}

const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

impl HandshakeReceiverHandler {
    pub fn new(phi: PotatoHandlerInit) -> Self {
        HandshakeReceiverHandler {
            state: ReceiverState::WaitingForA,
            have_potato: PotatoState::Absent,
            channel_handler: None,
            channel_finished_transaction: None,
            launcher_coin: None,
            private_keys: phi.private_keys,
            game_types: phi.game_types,
            my_contribution: phi.my_contribution,
            their_contribution: phi.their_contribution,
            channel_timeout: phi.channel_timeout,
            unroll_timeout: phi.unroll_timeout,
            reward_puzzle_hash: phi.reward_puzzle_hash,
            last_height: 0,
            channel_deadline: None,
            pending_coin_spend: false,
            waiting_to_start: true,
            incoming_messages: VecDeque::new(),
            last_channel_coin_spend_info: None,
            replacement: None,
        }
    }

    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.channel_handler
            .as_ref()
            .ok_or_else(|| Error::StrErr("receiver handshake: no channel handler yet".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        self.channel_handler
            .as_mut()
            .ok_or_else(|| Error::StrErr("receiver handshake: no channel handler yet".to_string()))
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
        if !msg
            .channel_key_pop
            .verify(&msg.channel_public_key, &msg.channel_public_key.bytes())
        {
            return Err(Error::Channel(
                "Invalid proof-of-possession for channel key".to_string(),
            ));
        }
        if !msg
            .unroll_key_pop
            .verify(&msg.unroll_public_key, &msg.unroll_public_key.bytes())
        {
            return Err(Error::Channel(
                "Invalid proof-of-possession for unroll key".to_string(),
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

    fn try_send_step_f(&mut self, info: HandshakeStepInfo) -> Result<Option<Effect>, Error> {
        if let Some(spend) = self.channel_finished_transaction.clone() {
            let send_effect = Effect::PeerHandshakeF {
                bundle: spend.clone(),
            };
            self.state = ReceiverState::Finished(Box::new(HandshakeStepWithSpend { info, spend }));
            return Ok(Some(send_effect));
        }

        Ok(None)
    }

    fn get_launcher_coin(&self) -> Result<&CoinString, Error> {
        self.launcher_coin
            .as_ref()
            .ok_or_else(|| Error::StrErr("launcher_coin not set".to_string()))
    }

    fn compute_not_valid_after_height(&self) -> Option<u64> {
        Some(self.last_height + self.channel_timeout.to_u64())
    }

    fn compute_coin_announcement_hash(
        &self,
        launcher_coin_id: &CoinID,
        channel_puzzle_hash: &PuzzleHash,
        total_amount: &Amount,
    ) -> Result<Hash, Error> {
        let allocator_for_hash = &mut crate::common::types::AllocEncoder::new();
        // Must exactly match launcher solution shape:
        // (channel_puzzle_hash, (total_amount, (nil, ())))
        let nil: () = ();
        let solution_tree_hash = (
            channel_puzzle_hash.clone(),
            (total_amount.clone(), (nil, ())),
        )
            .sha256tree(allocator_for_hash);
        Ok(Sha256Input::Array(vec![
            Sha256Input::Bytes(launcher_coin_id.bytes()),
            Sha256Input::Bytes(solution_tree_hash.bytes()),
        ])
        .hash())
    }

    fn build_bob_coin_spend_request(&self) -> Result<CoinSpendRequest, Error> {
        let ch = self.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let (_, channel_puzzle_hash, total_amount) = channel_coin.get_coin_string_parts()?;
        let launcher_coin = self.get_launcher_coin()?;
        let launcher_coin_id = launcher_coin.to_coin_id();
        let ann_hash = self.compute_coin_announcement_hash(
            &launcher_coin_id,
            &channel_puzzle_hash,
            &total_amount,
        )?;
        let per_player = Amount::new(total_amount.to_u64() / 2);
        let conditions = vec![RawCoinCondition {
            opcode: crate::common::constants::ASSERT_COIN_ANNOUNCEMENT,
            args: vec![ann_hash.bytes().to_vec()],
        }];
        Ok(CoinSpendRequest {
            amount: per_player,
            conditions,
            coin_id: None,
            max_height: self.compute_not_valid_after_height(),
        })
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
        if let ReceiverState::Finished(_) = &self.state {
            let ch = self
                .channel_handler
                .take()
                .expect("channel handler must exist at Finished");
            let queued_messages = std::mem::take(&mut self.incoming_messages);

            let ph = PotatoHandler::from_completed_handshake(
                false,
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
            self.state = ReceiverState::Done;
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
            ReceiverState::WaitingForA => {
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake A message, got {msg_envelope:?}"
                    )));
                };

                if !verify_reward_payout_signature(
                    &msg.referee_pubkey,
                    &msg.reward_puzzle_hash,
                    &msg.reward_payout_signature,
                ) {
                    return Err(Error::Channel(
                        "Invalid reward payout signature in HandshakeA".to_string(),
                    ));
                }
                if !msg
                    .channel_key_pop
                    .verify(&msg.channel_public_key, &msg.channel_public_key.bytes())
                {
                    return Err(Error::Channel(
                        "Invalid proof-of-possession for channel key in HandshakeA".to_string(),
                    ));
                }
                if !msg
                    .unroll_key_pop
                    .verify(&msg.unroll_public_key, &msg.unroll_public_key.bytes())
                {
                    return Err(Error::Channel(
                        "Invalid proof-of-possession for unroll key in HandshakeA".to_string(),
                    ));
                }

                let my_hs_info = {
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
                    let channel_key_pop = self
                        .private_keys
                        .my_channel_coin_private_key
                        .sign(channel_public_key.bytes());
                    let unroll_key_pop = self
                        .private_keys
                        .my_unroll_coin_private_key
                        .sign(unroll_public_key.bytes());
                    HandshakeB {
                        channel_public_key,
                        unroll_public_key,
                        reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                        referee_pubkey: referee_public_key,
                        reward_payout_signature: reward_payout_sig,
                        channel_key_pop,
                        unroll_key_pop,
                    }
                };

                self.state = ReceiverState::SentB(Box::new(HandshakeStepInfo {
                    first_player_hs_info: msg.clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));

                effects.push(Effect::PeerHandshakeB(my_hs_info));
            }

            ReceiverState::SentB(_info) => {
                let msg = if let PeerMessage::HandshakeC(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake C message, got {msg_envelope:?}"
                    )));
                };

                let (_, launcher_ph, _) = msg.launcher_coin.get_coin_string_parts()?;
                let expected_ph =
                    PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH);
                if launcher_ph != expected_ph {
                    return Err(Error::Channel(
                        "Launcher coin puzzle hash is not SINGLETON_LAUNCHER".to_string(),
                    ));
                }

                let info = match std::mem::replace(&mut self.state, ReceiverState::WaitingForA) {
                    ReceiverState::SentB(info) => *info,
                    _ => unreachable!(),
                };
                let (channel_handler, _init_result) = self.make_channel_handler(
                    msg.launcher_coin.to_coin_id(),
                    true,
                    &info.first_player_hs_info,
                    env,
                )?;
                let sigs = channel_handler.get_initial_signatures()?;
                self.launcher_coin = Some(msg.launcher_coin.clone());
                self.channel_handler = Some(channel_handler);
                self.last_channel_coin_spend_info = None;

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
                    effects.push(Effect::Log(parts.join("\n")));
                }

                let channel_coin = self.channel_handler()?.state_channel_coin().clone();
                effects.push(Effect::RegisterCoin {
                    coin: channel_coin,
                    timeout: Timeout::new(1_000_000),
                    name: Some("channel"),
                });
                effects.push(Effect::PeerHandshakeD(HandshakeD { signatures: sigs }));
                self.state = ReceiverState::SentD(Box::new(info));
            }

            ReceiverState::SentD(info) => {
                let info_clone = info.as_ref().clone();
                let (bundle, signatures) =
                    if let PeerMessage::HandshakeE { bundle, signatures } = msg_envelope.borrow() {
                        (bundle, signatures)
                    } else {
                        self.incoming_messages.push_front(msg_envelope.clone());
                        return Ok(effects);
                    };

                let spend_info = {
                    let ch = self.channel_handler_mut()?;
                    ch.verify_and_store_initial_peer_signatures(env, signatures)
                        .map_err(|e| {
                            Error::StrErr(format!(
                                "receiver step E: verify/store initial peer signatures failed: {e}"
                            ))
                        })?
                };
                self.last_channel_coin_spend_info = Some(spend_info);
                if self.last_height > 0 {
                    let coin_spend_request = self.build_bob_coin_spend_request()?;
                    self.channel_deadline = self.compute_not_valid_after_height();
                    effects.push(Effect::NeedCoinSpend(coin_spend_request));
                } else {
                    self.pending_coin_spend = true;
                }

                let bundle = bundle.clone();
                if bundle.spends.is_empty() {
                    return Err(Error::StrErr(
                        "No spends to draw the channel coin from".to_string(),
                    ));
                }

                let first_player_hs = info_clone.first_player_hs_info.clone();
                let second_player_hs = info_clone.second_player_hs_info.clone();

                let info = HandshakeStepInfo {
                    first_player_hs_info: first_player_hs,
                    second_player_hs_info: second_player_hs,
                };

                self.state = ReceiverState::WaitingForCompletion(Box::new(info.clone()), bundle);
                effects.extend(self.try_send_step_f(info)?);
            }

            ReceiverState::WaitingForCompletion(_, _) => {
                self.incoming_messages.push_front(msg_envelope);
            }

            ReceiverState::Finished(_) => {
                self.incoming_messages.push_front(msg_envelope);
            }

            ReceiverState::Done => {
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
        let msg_envelope: PeerMessage = bencodex::from_slice(&msg).into_gen()?;
        self.incoming_messages.push_back(Rc::new(msg_envelope));
        self.process_incoming_message(env)
    }
}

impl SpendWalletReceiver for HandshakeReceiverHandler {
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

        if let ReceiverState::WaitingForCompletion(info, _) = &self.state {
            let info = *info.clone();
            let step_f_effects: Vec<Effect> = self.try_send_step_f(info)?.into_iter().collect();
            effects.extend(step_f_effects);
        }

        {
            let ch = self.channel_handler()?;
            effects.push(Effect::Log(format!(
                "[channel-created] {} state={} have_potato={}",
                format_coin(&channel_coin),
                ch.state_number(),
                ch.have_potato(),
            )));
        }
        self.try_transition_to_potato();
        Ok(Some(effects))
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::Log(format!(
            "[receiver-handshake:coin-spent] {}",
            format_coin(coin_id),
        ))])
    }

    fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::Log(format!(
            "[receiver-handshake:coin-timeout] {}",
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
            vec![Effect::Log(format!(
                "[receiver-handshake:coin-puzzle] {}",
                format_coin(coin_id),
            ))],
            None,
        ))
    }
}

#[typetag::serde]
impl PeerHandler for HandshakeReceiverHandler {
    fn has_pending_incoming(&self) -> bool {
        !self.incoming_messages.is_empty()
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeReceiverHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeReceiverHandler::received_message(self, env, msg)
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
    fn new_block(&mut self, height: u64) -> Result<Vec<Effect>, Error> {
        self.last_height = height;
        if self.pending_coin_spend && self.last_height > 0 {
            self.pending_coin_spend = false;
            let req = self.build_bob_coin_spend_request()?;
            self.channel_deadline = self.compute_not_valid_after_height();
            return Ok(vec![Effect::NeedCoinSpend(req)]);
        }
        Ok(vec![])
    }
    fn handshake_finished(&self) -> bool {
        false
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        if let ReceiverState::WaitingForCompletion(info, _alice_bundle) = &self.state {
            self.channel_finished_transaction = Some(bundle.clone());
            let info = *info.clone();
            let result = self.try_send_step_f(info)?;
            self.try_transition_to_potato();
            return Ok(result);
        }

        self.channel_finished_transaction = Some(bundle.clone());

        Ok(None)
    }
    fn provide_launcher_coin(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _launcher_coin: CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "provide_launcher_coin: receiver does not provide launcher coin".to_string(),
        ))
    }
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        if let ReceiverState::WaitingForCompletion(_, alice_bundle) = &self.state {
            let mut spends = alice_bundle.spends.clone();
            spends.extend(bundle.spends.clone());
            let final_bundle = SpendBundle { name: None, spends };
            let completion_effect = self.channel_transaction_completion(env, &final_bundle)?;
            let mut effects = Vec::new();
            effects.extend(completion_effect);
            effects.push(Effect::SpendTransaction(final_bundle));
            return Ok(effects);
        }

        self.channel_transaction_completion(env, &bundle)
            .map(|effect| effect.into_iter().collect::<Vec<_>>())
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        if let Some(deadline) = self.channel_deadline {
            if self.waiting_to_start && self.last_height >= deadline {
                return Some(ChannelStatusSnapshot {
                    state: ChannelState::Failed,
                    advisory: Some("channel coin not confirmed in time".to_string()),
                    coin: None,
                    our_balance: None,
                    their_balance: None,
                    game_allocated: None,
                    have_potato: None,
                });
            }
        }
        if self.pending_coin_spend {
            return Some(ChannelStatusSnapshot {
                state: ChannelState::WaitingForHeightToAccept,
                advisory: None,
                coin: self
                    .channel_handler
                    .as_ref()
                    .map(|ch| ch.state_channel_coin().clone()),
                our_balance: self
                    .channel_handler
                    .as_ref()
                    .map(|ch| ch.my_out_of_game_balance()),
                their_balance: self
                    .channel_handler
                    .as_ref()
                    .map(|ch| ch.their_out_of_game_balance()),
                game_allocated: self
                    .channel_handler
                    .as_ref()
                    .map(|ch| ch.total_game_allocated()),
                have_potato: None,
            });
        }
        let state = match &self.state {
            ReceiverState::WaitingForA | ReceiverState::SentB(_) => ChannelState::Handshaking,
            ReceiverState::SentD(_) => ChannelState::Handshaking,
            ReceiverState::WaitingForCompletion(_, _) => ChannelState::WaitingForOffer,
            ReceiverState::Finished(_) => ChannelState::TransactionPending,
            ReceiverState::Done => return None,
        };
        let coin = self
            .channel_handler
            .as_ref()
            .map(|ch| ch.state_channel_coin().clone());
        let (our_balance, their_balance, game_allocated) =
            if let Some(ch) = self.channel_handler.as_ref() {
                (
                    Some(ch.my_out_of_game_balance()),
                    Some(ch.their_out_of_game_balance()),
                    Some(ch.total_game_allocated()),
                )
            } else {
                (None, None, None)
            };
        Some(ChannelStatusSnapshot {
            state,
            advisory: None,
            coin,
            our_balance,
            their_balance,
            game_allocated,
            have_potato: None,
        })
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        HandshakeReceiverHandler::channel_handler(self)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
