use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use clvm_traits::ToClvm;
use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerInitiationResult,
    ChannelHandlerPrivateKeys, PotatoSignatures, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_synthetic_public_key, sign_reward_payout,
    verify_reward_payout_signature,
};
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinSpend, CoinString, Error, GameID, GameType, GetCoinStringParts,
    Hash, IntoErr, Program, Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend, SpendBundle,
    Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{format_coin, Effect, GameNotification, ResyncInfo};
use crate::potato_handler::handshake::{
    CoinSpendRequest, HandshakeA, HandshakeB, HandshakeC, HandshakeStepInfo,
    HandshakeStepWithSpend, RawCoinCondition,
};
use crate::potato_handler::types::{
    GameFactory, PeerMessage, PotatoHandlerInit, PotatoState, SpendWalletReceiver,
};
use crate::potato_handler::PotatoHandler;

#[derive(Debug, Serialize, Deserialize)]
enum InitiatorState {
    WaitingForStart,
    SentA(Box<HandshakeA>),
    WaitingForLauncher(Box<HandshakeStepInfo>),
    SentC(Box<HandshakeStepInfo>),
    WaitingForOffer(Box<HandshakeStepInfo>, PotatoSignatures),
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
pub struct HandshakeInitiatorHandler {
    state: InitiatorState,
    have_potato: PotatoState,

    channel_handler: Option<ChannelHandler>,
    channel_initiation_transaction: Option<SpendBundle>,
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

    waiting_to_start: bool,
    incoming_messages: VecDeque<Rc<PeerMessage>>,

    #[serde(skip)]
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    replacement: Option<Box<PotatoHandler>>,
}

const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

impl HandshakeInitiatorHandler {
    pub fn new(phi: PotatoHandlerInit) -> Self {
        HandshakeInitiatorHandler {
            state: InitiatorState::WaitingForStart,
            have_potato: PotatoState::Present,
            channel_handler: None,
            channel_initiation_transaction: None,
            launcher_coin: None,
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
            .ok_or_else(|| Error::StrErr("initiator handshake: no channel handler yet".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        self.channel_handler
            .as_mut()
            .ok_or_else(|| Error::StrErr("initiator handshake: no channel handler yet".to_string()))
    }

    pub fn start(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _parent_coin: CoinString,
    ) -> Result<Option<Effect>, Error> {
        game_assert!(
            matches!(self.state, InitiatorState::WaitingForStart),
            "start: expected WaitingForStart state"
        );

        let my_hs_info = self.my_handshake_b();
        self.state = InitiatorState::SentA(Box::new(my_hs_info.clone()));

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
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
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

    fn try_send_step_e(
        &mut self,
        info: HandshakeStepInfo,
        our_sigs: PotatoSignatures,
    ) -> Result<Option<Effect>, Error> {
        if let Some(spend) = self.channel_initiation_transaction.clone() {
            let send_effect = Effect::PeerHandshakeE {
                bundle: spend.clone(),
                signatures: our_sigs,
            };
            self.state = InitiatorState::Finished(Box::new(HandshakeStepWithSpend { info, spend }));
            return Ok(Some(send_effect));
        }
        Ok(None)
    }

    fn get_launcher_coin(&self) -> Result<&CoinString, Error> {
        self.launcher_coin
            .as_ref()
            .ok_or_else(|| Error::StrErr("launcher_coin not set".to_string()))
    }

    fn encode_u64_as_clvm_int(val: u64) -> Vec<u8> {
        super::handshake::encode_u64_as_clvm_int(val)
    }

    fn compute_not_valid_after_height(&self) -> Option<u64> {
        Some(self.channel_timeout.to_u64() + 100)
    }

    fn build_launcher_coin_spend(&self, env: &mut ChannelHandlerEnv<'_>) -> Result<CoinSpend, Error> {
        let ch = self.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let (_, channel_puzzle_hash, total_amount) = channel_coin.get_coin_string_parts()?;
        let launcher_coin = self.get_launcher_coin()?.clone();

        let nil: () = ();
        let launcher_solution_clvm = (
            channel_puzzle_hash.clone(),
            (total_amount.clone(), (nil, ())),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        let launcher_solution_program =
            Program::from_nodeptr(env.allocator, launcher_solution_clvm)?;

        Ok(CoinSpend {
            coin: launcher_coin,
            bundle: Spend {
                puzzle: Puzzle::from_bytes(&crate::common::constants::SINGLETON_LAUNCHER),
                solution: launcher_solution_program.into(),
                signature: Aggsig::default(),
            },
        })
    }

    fn compute_coin_announcement_hash(
        &self,
        launcher_coin_id: &CoinID,
        channel_puzzle_hash: &PuzzleHash,
        total_amount: &Amount,
    ) -> Result<Hash, Error> {
        let allocator_for_hash = &mut crate::common::types::AllocEncoder::new();
        let solution_tree_hash =
            (channel_puzzle_hash.clone(), (total_amount.clone(), ())).sha256tree(allocator_for_hash);
        Ok(Sha256Input::Array(vec![
            Sha256Input::Bytes(launcher_coin_id.bytes()),
            Sha256Input::Bytes(solution_tree_hash.bytes()),
        ])
        .hash())
    }

    fn build_alice_coin_spend_request(
        &self,
        _env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<CoinSpendRequest, Error> {
        let ch = self.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let (_, channel_puzzle_hash, total_amount) = channel_coin.get_coin_string_parts()?;
        let launcher_coin = self.get_launcher_coin()?;
        let launcher_coin_id = launcher_coin.to_coin_id();
        let (launcher_parent, _, _) = launcher_coin.get_coin_string_parts()?;

        let ann_hash =
            self.compute_coin_announcement_hash(&launcher_coin_id, &channel_puzzle_hash, &total_amount)?;
        let per_player = Amount::new(total_amount.to_u64() / 2);

        let launcher_ph_bytes = crate::common::constants::SINGLETON_LAUNCHER_HASH.to_vec();
        let zero_bytes = Self::encode_u64_as_clvm_int(0);
        let mut conditions = vec![
            RawCoinCondition {
                opcode: crate::common::constants::CREATE_COIN,
                args: vec![launcher_ph_bytes, zero_bytes],
            },
            RawCoinCondition {
                opcode: crate::common::constants::ASSERT_COIN_ANNOUNCEMENT,
                args: vec![ann_hash.bytes().to_vec()],
            },
        ];
        if let Some(height) = self.compute_not_valid_after_height() {
            conditions.push(RawCoinCondition {
                opcode: crate::common::constants::ASSERT_BEFORE_HEIGHT_ABSOLUTE,
                args: vec![Self::encode_u64_as_clvm_int(height)],
            });
        }

        Ok(CoinSpendRequest {
            amount: per_player,
            conditions,
            coin_id: Some(launcher_parent),
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
        if let InitiatorState::Finished(_) = &self.state {
            let ch = self
                .channel_handler
                .take()
                .expect("channel handler must exist at Finished");
            let queued_messages = std::mem::take(&mut self.incoming_messages);

            let ph = PotatoHandler::from_completed_handshake(
                true,
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
            self.state = InitiatorState::Done;
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
            InitiatorState::WaitingForStart => {
                return Err(Error::StrErr(format!(
                    "initiator WaitingForStart: unexpected message before start: {msg_envelope:?}"
                )));
            }

            InitiatorState::SentA(handshake_a) => {
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake B message, got {msg_envelope:?}"
                    )));
                };

                if !verify_reward_payout_signature(
                    &msg.referee_pubkey,
                    &msg.reward_puzzle_hash,
                    &msg.reward_payout_signature,
                ) {
                    return Err(Error::Channel(
                        "Invalid reward payout signature in HandshakeB".to_string(),
                    ));
                }

                let our_channel_pk =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let aggregate_pk = our_channel_pk + msg.channel_public_key.clone();
                let channel_puzzle_hash =
                    puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_pk)?;
                effects.push(Effect::ChannelPuzzleHash(channel_puzzle_hash));
                effects.push(Effect::NeedLauncherCoinId);

                self.state = InitiatorState::WaitingForLauncher(Box::new(HandshakeStepInfo {
                    first_player_hs_info: *handshake_a.clone(),
                    second_player_hs_info: msg.clone(),
                }));
            }

            InitiatorState::WaitingForLauncher(_) => {
                self.incoming_messages.push_front(msg_envelope);
            }

            InitiatorState::SentC(_info) => {
                let msg = if let PeerMessage::HandshakeD(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake D message, got {msg_envelope:?}"
                    )));
                };

                let our_sigs = {
                    let ch = self.channel_handler()?;
                    ch.get_initial_signatures()?
                };
                let spend_info = {
                    let ch = self.channel_handler_mut()?;
                    ch.verify_and_store_initial_peer_signatures(env, &msg.signatures)
                        .map_err(|e| {
                            Error::StrErr(format!(
                                "initiator step D: verify/store initial peer signatures failed: {e}"
                            ))
                        })?
                };
                self.last_channel_coin_spend_info = Some(spend_info);
                let coin_spend_request = self.build_alice_coin_spend_request(env)?;
                effects.push(Effect::NeedCoinSpend(coin_spend_request));

                let info = match std::mem::replace(&mut self.state, InitiatorState::WaitingForStart)
                {
                    InitiatorState::SentC(info) => *info,
                    _ => unreachable!(),
                };
                self.state = InitiatorState::WaitingForOffer(Box::new(info), our_sigs);
            }

            InitiatorState::WaitingForOffer(_, _) => {
                self.incoming_messages.push_front(msg_envelope);
            }

            InitiatorState::Finished(_) => {
                self.incoming_messages.push_front(msg_envelope);
            }

            InitiatorState::Done => {
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

impl SpendWalletReceiver for HandshakeInitiatorHandler {
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
            "[initiator-handshake:coin-spent] {}",
            format_coin(coin_id),
        ))])
    }

    fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::DebugLog(format!(
            "[initiator-handshake:coin-timeout] {}",
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
                "[initiator-handshake:coin-puzzle] {}",
                format_coin(coin_id),
            ))],
            None,
        ))
    }
}

#[typetag::serde]
impl PeerHandler for HandshakeInitiatorHandler {
    fn has_pending_incoming(&self) -> bool {
        !self.incoming_messages.is_empty()
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeInitiatorHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeInitiatorHandler::received_message(self, env, msg)
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

        if let InitiatorState::WaitingForOffer(info, sigs) = &self.state {
            let info = *info.clone();
            let sigs = sigs.clone();
            let result = self.try_send_step_e(info, sigs)?;
            self.try_transition_to_potato();
            return Ok(result);
        }

        Ok(None)
    }
    fn provide_launcher_coin(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        launcher_coin: CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let info = match &self.state {
            InitiatorState::WaitingForLauncher(info) => (**info).clone(),
            _ => {
                return Err(Error::StrErr(
                    "provide_launcher_coin: not in WaitingForLauncher state".to_string(),
                ))
            }
        };

        let (_, launcher_ph, _) = launcher_coin.get_coin_string_parts()?;
        let expected_ph = PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH);
        if launcher_ph != expected_ph {
            return Err(Error::Channel(
                "Launcher coin puzzle hash is not SINGLETON_LAUNCHER".to_string(),
            ));
        }

        let (channel_handler, _init_result) = self.make_channel_handler(
            launcher_coin.to_coin_id(),
            false,
            &info.second_player_hs_info,
            env,
        )?;
        let channel_coin = channel_handler.state_channel_coin().clone();
        self.channel_handler = Some(channel_handler);
        self.launcher_coin = Some(launcher_coin.clone());
        self.state = InitiatorState::SentC(Box::new(info));

        Ok(vec![
            Effect::RegisterCoin {
                coin: channel_coin,
                timeout: self.channel_timeout.clone(),
                name: Some("channel"),
            },
            Effect::PeerHandshakeC(HandshakeC { launcher_coin }),
        ])
    }
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        wallet_bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        let bundle = if matches!(self.state, InitiatorState::WaitingForOffer(_, _)) {
            let launcher_spend = self.build_launcher_coin_spend(env)?;
            let mut spends = wallet_bundle.spends;
            spends.push(launcher_spend);
            SpendBundle { name: None, spends }
        } else {
            wallet_bundle
        };

        self.channel_offer(env, bundle)
            .map(|effect| effect.into_iter().collect::<Vec<_>>())
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        HandshakeInitiatorHandler::channel_handler(self)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
