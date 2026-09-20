use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use clvm_traits::ToClvm;
use serde::{Deserialize, Serialize};

use crate::channel_state::types::{
    ChannelCoinSpendInfo, ChannelEnv, ChannelInitiationResult, ChannelPrivateKeys, ReadableMove,
};
use crate::channel_state::ChannelState;
use crate::common::standard_coin::{
    private_to_public_key, sign_reward_payout, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinSpend, CoinString, Error, GameID, GameType, GetCoinStringParts,
    Hash, IntoErr, LocalProposalId, Program, ProgramRef, Puzzle, PuzzleHash, Sha256Input,
    Sha256tree, Spend, SpendBundle, Timeout,
};
use crate::game_session::{phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::effects::{
    format_coin, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect, FailedGameAction,
    GameNotification, TimeoutClaimSemantic,
};
use crate::session_phases::handshake::{
    local_capabilities, validate_ab_payload, validate_assembled_channel_funding, CoinSpendRequest,
    HandshakePayloadB, HandshakePayloadBWithGenesis, HandshakePayloadD, HandshakeStepInfo,
    HandshakeStepWithSpend, RawCoinCondition, MAX_PEER_MESSAGE_SIZE, MAX_QUEUED_PEER_BYTES,
    MAX_QUEUED_PEER_MESSAGES,
};
use crate::session_phases::handshake_initiator::validate_wallet_bundle_applies_conditions;
use crate::session_phases::proposal::GameProposal;
use crate::session_phases::types::{OffChainPhaseInit, PeerMessage, SpendWalletReceiver};
use crate::session_phases::OffChainPhase;

#[derive(Debug, Serialize, Deserialize)]
enum ReceiverState {
    WaitingForA,
    WaitingForOffer(Box<HandshakeStepInfo>),
    SentB(Box<HandshakeStepInfo>),
    Finished(Box<HandshakeStepWithSpend>),
    Done,
}

#[derive(Serialize, Deserialize)]
pub struct HandshakeReceiverPhase {
    state: ReceiverState,

    channel_state: Option<ChannelState>,
    channel_finished_transaction: Option<SpendBundle>,
    #[serde(default)]
    opening_fee: Amount,

    private_keys: ChannelPrivateKeys,
    #[serde(skip, default)]
    game_types: BTreeMap<GameType, ProgramRef>,
    my_contribution: Amount,
    their_contribution: Amount,
    channel_timeout: Timeout,
    unroll_timeout: Timeout,
    reward_puzzle_hash: PuzzleHash,

    last_height: u64,
    channel_deadline: Option<u64>,
    pending_coin_spend: bool,
    funding_announcement: Option<Hash>,

    waiting_to_start: bool,
    incoming_messages: VecDeque<(Rc<PeerMessage>, usize)>,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    failed: bool,
    #[serde(default)]
    failure_advisory: Option<String>,

    replacement: Option<Box<OffChainPhase>>,
}

impl HandshakeReceiverPhase {
    pub fn new(phi: OffChainPhaseInit) -> Self {
        HandshakeReceiverPhase {
            state: ReceiverState::WaitingForA,
            channel_state: None,
            channel_finished_transaction: None,
            opening_fee: Amount::default(),
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
            funding_announcement: None,
            waiting_to_start: true,
            incoming_messages: VecDeque::new(),
            last_channel_coin_spend_info: None,
            failed: false,
            failure_advisory: None,
            replacement: None,
        }
    }

    fn channel_state(&self) -> Result<&ChannelState, Error> {
        self.channel_state
            .as_ref()
            .ok_or_else(|| Error::StrErr("receiver handshake: no channel handler yet".to_string()))
    }

    fn make_channel_state(
        &self,
        parent: CoinID,
        is_receiver: bool,
        msg: &HandshakePayloadB,
        env: &mut ChannelEnv<'_>,
    ) -> Result<(ChannelState, ChannelInitiationResult), Error> {
        ChannelState::new(
            env,
            self.private_keys.clone(),
            parent,
            is_receiver,
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

    fn pre_launcher_amount(&self) -> Result<Amount, Error> {
        self.my_contribution
            .to_u64()
            .checked_add(self.opening_fee.to_u64())
            .map(Amount::new)
            .ok_or_else(|| {
                Error::StrErr("receiver contribution plus opening fee overflowed u64".to_string())
            })
    }

    fn pre_launcher_identity(&self, env: &mut ChannelEnv<'_>) -> Result<ChiaIdentity, Error> {
        ChiaIdentity::new(
            env.allocator,
            self.private_keys.my_pre_launcher_private_key.clone(),
        )
    }

    fn build_bob_coin_spend_request(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<CoinSpendRequest, Error> {
        let amount = self.pre_launcher_amount()?;
        let pre_launcher = self.pre_launcher_identity(env)?;
        Ok(CoinSpendRequest {
            amount,
            fee: self.opening_fee.clone(),
            conditions: vec![RawCoinCondition {
                opcode: crate::common::constants::RECEIVE_MESSAGE,
                args: vec![vec![16], vec![], pre_launcher.puzzle_hash.bytes().to_vec()],
            }],
            coin_id: None,
            max_height: self.compute_not_valid_after_height(),
        })
    }

    pub fn take_off_chain_phase(&mut self) -> Option<OffChainPhase> {
        self.replacement.take().map(|ph| *ph)
    }

    fn try_transition_to_off_chain(&mut self) {
        if self.replacement.is_some() {
            return;
        }
        if self.waiting_to_start {
            return;
        }
        if let ReceiverState::Finished(_) = &self.state {
            let ch = self
                .channel_state
                .take()
                .expect("channel handler must exist at Finished");
            let queued_messages = std::mem::take(&mut self.incoming_messages)
                .into_iter()
                .map(|(message, _)| message)
                .collect();

            let ph = OffChainPhase::from_completed_handshake(
                false,
                ch,
                self.game_types.clone(),
                self.private_keys.clone(),
                self.my_contribution.clone(),
                self.their_contribution.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.reward_puzzle_hash.clone(),
                queued_messages,
                self.last_channel_coin_spend_info.take(),
                self.last_height,
            );
            self.replacement = Some(Box::new(ph));
            self.state = ReceiverState::Done;
        }
    }

    fn process_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        match &self.state {
            ReceiverState::WaitingForA => {
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake A message, got {msg_envelope:?}"
                    )));
                };

                validate_ab_payload(
                    msg,
                    &self.private_keys,
                    &self.reward_puzzle_hash,
                    &self.my_contribution,
                    &self.their_contribution,
                )?;

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

                    HandshakePayloadB {
                        capabilities: local_capabilities(),
                        channel_public_key,
                        unroll_public_key,
                        reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                        referee_pubkey: referee_public_key,
                        reward_payout_signature: reward_payout_sig,
                        channel_key_pop,
                        unroll_key_pop,
                        my_contribution: self.my_contribution.clone(),
                        their_contribution: self.their_contribution.clone(),
                    }
                };

                let coin_spend_request = if self.last_height > 0 {
                    Some(self.build_bob_coin_spend_request(env)?)
                } else {
                    None
                };
                self.state = ReceiverState::WaitingForOffer(Box::new(HandshakeStepInfo {
                    first_player_hs_info: (**msg).clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));
                if let Some(request) = coin_spend_request {
                    self.channel_deadline = self.compute_not_valid_after_height();
                    effects.push(Effect::NeedCoinSpend(request));
                } else {
                    self.pending_coin_spend = true;
                }
            }

            ReceiverState::WaitingForOffer(_) => {
                return Err(Error::StrErr(format!(
                    "receiver WaitingForOffer: unexpected peer message: {msg_envelope:?}"
                )));
            }

            ReceiverState::SentB(info) => {
                let msg = if let PeerMessage::HandshakeC(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake C message, got {msg_envelope:?}"
                    )));
                };

                if msg.bundle.spends.is_empty() {
                    return Err(Error::StrErr(
                        "No spends to draw the channel coin from".to_string(),
                    ));
                }
                let receiver_bundle =
                    self.channel_finished_transaction.clone().ok_or_else(|| {
                        Error::StrErr(
                            "receiver ancestry bundle missing after handshake B".to_string(),
                        )
                    })?;
                let announcement = self.funding_announcement.as_ref().ok_or_else(|| {
                    Error::StrErr("receiver funding announcement missing".to_string())
                })?;
                let combined = validate_assembled_channel_funding(
                    env.allocator,
                    &msg.bundle,
                    &receiver_bundle,
                    announcement,
                    &env.agg_sig_me_additional_data,
                    self.last_height,
                )?;
                let mut staged_channel_state = self.channel_state()?.clone();
                let spend_info = staged_channel_state
                    .initialize_genesis_as_receiver(env, &msg.signatures)
                    .map_err(|e| {
                        Error::StrErr(format!(
                            "receiver step C: genesis initialization failed: {e}"
                        ))
                    })?;

                let info_clone = info.as_ref().clone();
                self.channel_state = Some(staged_channel_state);
                self.last_channel_coin_spend_info = Some(spend_info);
                self.state = ReceiverState::Finished(Box::new(HandshakeStepWithSpend {
                    info: info_clone,
                    spend: receiver_bundle.clone(),
                }));
                effects.push(Effect::SendPeer(PeerMessage::HandshakeD(
                    HandshakePayloadD {
                        bundle: receiver_bundle,
                    },
                )));
                effects.push(Effect::SpendTransaction(
                    crate::session_phases::effects::TransactionSubmission::already_paid(
                        combined,
                        self.channel_deadline,
                    ),
                ));
            }

            ReceiverState::Finished(_) => {
                return Err(Error::StrErr(format!(
                    "receiver Finished: unexpected queued message: {msg_envelope:?}"
                )));
            }

            ReceiverState::Done => {
                return Err(Error::StrErr(format!(
                    "receiver Done: unexpected queued message: {msg_envelope:?}"
                )));
            }
        }

        self.try_transition_to_off_chain();
        Ok(effects)
    }

    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        let Some((message, _)) = self.incoming_messages.pop_front() else {
            return Ok(vec![]);
        };
        self.process_message(env, message)
    }

    fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        if msg.len() > MAX_PEER_MESSAGE_SIZE {
            return Err(Error::StrErr(format!(
                "message too large: {} bytes (max {MAX_PEER_MESSAGE_SIZE})",
                msg.len(),
            )));
        }
        let raw_len = msg.len();
        let msg_envelope = crate::session_phases::peer_wire::decode_peer_message(&msg)?;
        if matches!(self.state, ReceiverState::Finished(_)) {
            match &msg_envelope {
                PeerMessage::HandshakeA(_)
                | PeerMessage::HandshakeB(_)
                | PeerMessage::HandshakeC(_)
                | PeerMessage::HandshakeD(_) => {
                    return Err(Error::StrErr(
                        "receiver post-C state: out-of-order handshake message".to_string(),
                    ));
                }
                _ => {
                    self.queue_activation_lag_message(Rc::new(msg_envelope), raw_len)?;
                    return Ok(vec![]);
                }
            }
        }
        self.process_message(env, Rc::new(msg_envelope))
    }

    fn queue_activation_lag_message(
        &mut self,
        message: Rc<PeerMessage>,
        raw_len: usize,
    ) -> Result<(), Error> {
        let queued_bytes: usize = self.incoming_messages.iter().map(|(_, len)| *len).sum();
        if self.incoming_messages.len() + 1 > MAX_QUEUED_PEER_MESSAGES {
            return Err(Error::StrErr(format!(
                "receiver handshake queued message count exceeds maximum {MAX_QUEUED_PEER_MESSAGES}"
            )));
        }
        if queued_bytes + raw_len > MAX_QUEUED_PEER_BYTES {
            return Err(Error::StrErr(format!(
                "receiver handshake queued message bytes {} exceeds maximum {MAX_QUEUED_PEER_BYTES}",
                queued_bytes + raw_len
            )));
        }
        self.incoming_messages.push_back((message, raw_len));
        Ok(())
    }
}

impl SpendWalletReceiver for HandshakeReceiverPhase {
    fn coin_created(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        let channel_coin = self.channel_state()?.channel_coin().clone();
        if *coin != channel_coin {
            return Err(Error::StrErr(format!(
                "receiver handshake observed unexpected coin creation: {}",
                format_coin(coin),
            )));
        }
        if !self.waiting_to_start {
            return Ok(None);
        }

        self.waiting_to_start = false;

        let mut effects = Vec::new();

        {
            let ch = self.channel_state()?;
            effects.push(Effect::Log(format!(
                "[channel-created] {} state={} have_potato={}",
                format_coin(&channel_coin),
                ch.state_number(),
                ch.have_potato(),
            )));
        }
        self.try_transition_to_off_chain();
        Ok(Some(effects))
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        coin: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        if self.channel_state()?.channel_coin() == coin {
            return Ok(vec![Effect::Log(format!(
                "[receiver-handshake:channel-spent] {}",
                format_coin(coin),
            ))]);
        }

        Err(Error::StrErr(format!(
            "receiver handshake observed unexpected coin spend: {}",
            format_coin(coin),
        )))
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::Log(format!(
            "[receiver-handshake:coin-puzzle] {}",
            format_coin(coin_id),
        ))])
    }
}

#[typetag::serde]
impl PeerLifecyclePhase for HandshakeReceiverPhase {
    fn phase_name(&self) -> &'static str {
        "handshake receiver phase"
    }
    fn has_queued_message(&self) -> bool {
        !self.incoming_messages.is_empty()
    }
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        HandshakeReceiverPhase::process_queued_message(self, env)
    }
    fn has_queued_action(&self) -> bool {
        false
    }
    fn process_queued_action(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        HandshakeReceiverPhase::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_spent(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        <Self as SpendWalletReceiver>::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_puzzle_and_solution(
            self,
            env,
            coin_id,
            puzzle_and_solution,
        )
    }
    fn make_move(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _id: &GameID,
        _readable: &ReadableMove,
        _new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "make_move not available during handshake".to_string(),
        ))
    }
    fn accept_settlement(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_settlement not available during handshake".to_string(),
        ))
    }
    fn cheat_game(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
        _mover_share: Amount,
        _entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cheat_game not available during handshake".to_string(),
        ))
    }
    fn take_next_phase(&mut self) -> Option<Box<dyn PeerLifecyclePhase>> {
        self.replacement
            .take()
            .map(|ph| ph as Box<dyn PeerLifecyclePhase>)
    }
    fn go_on_chain(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        self.failed = true;
        self.incoming_messages.clear();
        Ok(vec![])
    }
    fn wallet_callback_failed(&mut self, reason: String) {
        self.failed = true;
        self.failure_advisory = Some(reason);
    }
    fn new_block(&mut self, env: &mut ChannelEnv<'_>, height: u64) -> Result<Vec<Effect>, Error> {
        self.last_height = height;
        if self.pending_coin_spend && self.last_height > 0 {
            self.pending_coin_spend = false;
            let req = self.build_bob_coin_spend_request(env)?;
            self.channel_deadline = self.compute_not_valid_after_height();
            return Ok(vec![Effect::NeedCoinSpend(req)]);
        }
        Ok(vec![])
    }
    fn handshake_finished(&self) -> bool {
        false
    }
    fn is_on_chain(&self) -> bool {
        false
    }
    fn start_handshake(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        opening_fee: Amount,
    ) -> Result<Option<Effect>, Error> {
        self.opening_fee = opening_fee;
        Ok(None)
    }
    fn channel_offer(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "channel_offer"))
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        self.channel_finished_transaction = Some(bundle.clone());
        Ok(None)
    }
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelEnv<'_>,
        wallet_bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        let info = match &self.state {
            ReceiverState::WaitingForOffer(info) => (**info).clone(),
            _ => {
                return Err(Error::StrErr(
                    "receiver wallet bundle arrived outside WaitingForOffer".to_string(),
                ))
            }
        };
        let mut request = self.build_bob_coin_spend_request(env)?;
        request.max_height = self.channel_deadline;
        validate_wallet_bundle_applies_conditions(env.allocator, &wallet_bundle, &request)?;

        let amount = self.pre_launcher_amount()?;
        let pre_identity = self.pre_launcher_identity(env)?;
        let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
        let mut settlement_coins = Vec::new();
        let mut direct_pre_launchers = Vec::new();
        for spend in &wallet_bundle.spends {
            let conditions = crate::common::types::CoinCondition::from_puzzle_and_solution(
                env.allocator,
                spend.bundle.puzzle.to_program().as_ref(),
                spend.bundle.solution.p().as_ref(),
            )?;
            for condition in conditions {
                if let crate::common::types::CoinCondition::CreateCoin(ph, created_amount) =
                    condition
                {
                    if ph == settlement_ph && created_amount == amount {
                        settlement_coins.push(CoinString::from_parts(
                            &spend.coin.to_coin_id(),
                            &settlement_ph,
                            &amount,
                        ));
                    } else if ph == pre_identity.puzzle_hash && created_amount == amount {
                        direct_pre_launchers.push(CoinString::from_parts(
                            &spend.coin.to_coin_id(),
                            &pre_identity.puzzle_hash,
                            &amount,
                        ));
                    }
                }
            }
        }
        let (settlement_coin, pre_launcher_coin) = match (
            settlement_coins.as_slice(),
            direct_pre_launchers.as_slice(),
        ) {
            ([settlement_coin], []) => (
                Some(settlement_coin.clone()),
                CoinString::from_parts(
                    &settlement_coin.to_coin_id(),
                    &pre_identity.puzzle_hash,
                    &amount,
                ),
            ),
            ([], [pre_launcher]) => (None, pre_launcher.clone()),
            _ => {
                return Err(Error::Channel(format!(
                        "receiver wallet bundle created {} settlement and {} direct pre-launcher candidates; expected exactly one funding path",
                        settlement_coins.len(),
                        direct_pre_launchers.len(),
                    )));
            }
        };
        let launcher_coin = CoinString::from_parts(
            &pre_launcher_coin.to_coin_id(),
            &PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH),
            &Amount::default(),
        );
        let (channel_state, _) = self.make_channel_state(
            launcher_coin.to_coin_id(),
            true,
            &info.first_player_hs_info,
            env,
        )?;
        let state_zero_signatures = channel_state.get_initial_signatures()?;
        self.channel_state = Some(channel_state);
        let channel_coin = self.channel_state()?.channel_coin().clone();
        let (_, channel_ph, channel_amount) = channel_coin.get_coin_string_parts()?;
        let announcement = self.compute_coin_announcement_hash(
            &launcher_coin.to_coin_id(),
            &channel_ph,
            &channel_amount,
        )?;
        self.funding_announcement = Some(announcement);

        let settlement_solution = if let Some(settlement_coin) = &settlement_coin {
            let payment = (pre_identity.puzzle_hash.clone(), (amount.clone(), ()))
                .to_clvm(env.allocator)
                .into_gen()?;
            let notarized = (settlement_coin.to_coin_id(), (payment, ()))
                .to_clvm(env.allocator)
                .into_gen()?;
            Some(vec![notarized].to_clvm(env.allocator).into_gen()?)
        } else {
            None
        };

        let mut pre_condition_nodes = vec![
            (crate::common::constants::SEND_MESSAGE, (16_u8, ((), ())))
                .to_clvm(env.allocator)
                .into_gen()?,
            (
                crate::common::constants::CREATE_COIN,
                (
                    PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH),
                    (Amount::default(), ()),
                ),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
            (
                crate::common::constants::ASSERT_CONCURRENT_SPEND_ATOM[0],
                (launcher_coin.to_coin_id(), ()),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        ];
        if self.opening_fee.to_u64() > 0 {
            pre_condition_nodes.push(
                (
                    crate::common::constants::RESERVE_FEE_ATOM[0],
                    (self.opening_fee.clone(), ()),
                )
                    .to_clvm(env.allocator)
                    .into_gen()?,
            );
        }
        if let Some(deadline) = self.channel_deadline {
            pre_condition_nodes.push(
                (
                    crate::common::constants::ASSERT_BEFORE_HEIGHT_ABSOLUTE,
                    (deadline, ()),
                )
                    .to_clvm(env.allocator)
                    .into_gen()?,
            );
        }
        let pre_conditions = pre_condition_nodes.to_clvm(env.allocator).into_gen()?;
        let pre_spend = standard_solution_partial(
            env.allocator,
            &pre_identity.synthetic_private_key,
            &pre_launcher_coin.to_coin_id(),
            pre_conditions,
            &pre_identity.synthetic_public_key,
            &env.agg_sig_me_additional_data,
            false,
        )?;

        let nil: () = ();
        let launcher_solution = (channel_ph, (channel_amount, (nil, ())))
            .to_clvm(env.allocator)
            .into_gen()?;
        let mut spends = wallet_bundle.spends;
        let wallet_signature_indexes = spends
            .iter()
            .enumerate()
            .filter(|(_, spend)| !spend.bundle.signature.is_twos_complement_zero())
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if wallet_signature_indexes.len() != 1 {
            return Err(Error::Channel(format!(
                "receiver wallet offer must contain one aggregate signature, found {}",
                wallet_signature_indexes.len()
            )));
        }
        let signature_index = wallet_signature_indexes[0];
        let aggregate_signature = spends[signature_index]
            .bundle
            .signature
            .aggregate(&pre_spend.signature);
        for spend in &mut spends {
            spend.bundle.signature = Aggsig::default();
        }
        spends[signature_index].bundle.signature = aggregate_signature;
        if let (Some(settlement_coin), Some(settlement_solution)) =
            (settlement_coin, settlement_solution)
        {
            spends.push(CoinSpend {
                coin: settlement_coin,
                bundle: Spend {
                    puzzle: Puzzle::from_bytes(&chia_puzzles::SETTLEMENT_PAYMENT)?,
                    solution: Program::from_nodeptr(env.allocator, settlement_solution)?.into(),
                    signature: Aggsig::default(),
                },
            });
        }
        spends.push(CoinSpend {
            coin: pre_launcher_coin.clone(),
            bundle: Spend {
                puzzle: pre_identity.puzzle,
                solution: pre_spend.solution,
                signature: Aggsig::default(),
            },
        });
        spends.push(CoinSpend {
            coin: launcher_coin,
            bundle: Spend {
                puzzle: Puzzle::from_bytes(&crate::common::constants::SINGLETON_LAUNCHER)?,
                solution: Program::from_nodeptr(env.allocator, launcher_solution)?.into(),
                signature: Aggsig::default(),
            },
        });
        let receiver_bundle = SpendBundle {
            name: Some("channel-opening".to_string()),
            spends,
        };
        self.channel_finished_transaction = Some(receiver_bundle);
        self.state = ReceiverState::SentB(Box::new(info.clone()));
        Ok(vec![
            Effect::RegisterCoin {
                coin: channel_coin,
                timeout: Timeout::new(1_000_000),
                name: Some("channel"),
                spend: None,
                semantic: None,
            },
            Effect::SendPeer(PeerMessage::HandshakeB(Box::new(
                HandshakePayloadBWithGenesis {
                    identity: info.second_player_hs_info,
                    channel_coin_grandparent: pre_launcher_coin.to_coin_id(),
                    signatures: state_zero_signatures,
                },
            ))),
        ])
    }
    fn propose(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _proposal: &GameProposal,
    ) -> Result<(LocalProposalId, Vec<Effect>), Error> {
        Err(phase_operation_error(self.phase_name(), "propose"))
    }
    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "accept_proposal"))
    }
    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "cancel_proposal"))
    }
    fn shut_down(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "shut_down"))
    }
    fn flush_pending_actions(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn take_failed_queued_action(&mut self) -> Option<(GameID, FailedGameAction)> {
        None
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        if self.failed {
            return Some(ChannelStatusSnapshot {
                advisory: self.failure_advisory.clone(),
                coin: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.channel_coin().clone()),
                our_balance: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.my_out_of_game_balance()),
                their_balance: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.their_out_of_game_balance()),
                game_allocated: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.total_game_allocated()),
                ..ChannelStatusSnapshot::new(ChannelStatus::Failed)
            });
        }
        // The channel-creation expiry -> Failed signal now lives in the
        // TransactionManager, which owns the deadline threaded onto the funding
        // transaction.  `channel_deadline` here is retained only to thread that
        // value; it no longer drives a status branch.
        if self.pending_coin_spend {
            return Some(ChannelStatusSnapshot {
                coin: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.channel_coin().clone()),
                our_balance: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.my_out_of_game_balance()),
                their_balance: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.their_out_of_game_balance()),
                game_allocated: self
                    .channel_state
                    .as_ref()
                    .map(|ch| ch.total_game_allocated()),
                ..ChannelStatusSnapshot::new(ChannelStatus::WaitingForHeightToAccept)
            });
        }
        let state = match &self.state {
            ReceiverState::WaitingForA => ChannelStatus::Handshaking,
            ReceiverState::WaitingForOffer(_) => ChannelStatus::OurWalletMakingOfferAcceptance,
            ReceiverState::SentB(_) => ChannelStatus::OfferSent,
            ReceiverState::Finished(_) => ChannelStatus::TransactionPending,
            ReceiverState::Done => return None,
        };
        let coin = self
            .channel_state
            .as_ref()
            .map(|ch| ch.channel_coin().clone());
        let (our_balance, their_balance, game_allocated) =
            if let Some(ch) = self.channel_state.as_ref() {
                (
                    Some(ch.my_out_of_game_balance()),
                    Some(ch.their_out_of_game_balance()),
                    Some(ch.total_game_allocated()),
                )
            } else {
                (None, None, None)
            };
        Some(ChannelStatusSnapshot {
            coin,
            our_balance,
            their_balance,
            game_allocated,
            ..ChannelStatusSnapshot::new(state)
        })
    }
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)> {
        self.channel_state
            .as_ref()
            .map(|ch| vec![(CoinOfInterest::Channel, ch.channel_coin().clone())])
            .unwrap_or_default()
    }
    fn channel_state(&self) -> Result<&ChannelState, Error> {
        HandshakeReceiverPhase::channel_state(self)
    }
    fn has_active_on_chain_games(&self) -> bool {
        false
    }
    fn timeout_claim_submitted(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error> {
        Ok(None)
    }
    fn timeout_claim_rearmed(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error> {
        Ok(None)
    }
    #[cfg(test)]
    fn take_off_chain_phase_for_testing(&mut self) -> Option<OffChainPhase> {
        self.take_off_chain_phase()
    }
    fn get_game_coin(&self, _game_id: &GameID) -> Option<CoinString> {
        None
    }
}

#[cfg(test)]
mod queued_message_tests {
    use super::*;
    use crate::common::standard_coin::{private_to_public_key, sign_reward_payout};
    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    fn finished_phase() -> HandshakeReceiverPhase {
        let mut rng = ChaCha8Rng::from_seed([19; 32]);
        let mut phase = HandshakeReceiverPhase::new(OffChainPhaseInit {
            private_keys: rng.random(),
            game_types: BTreeMap::new(),
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(5),
            unroll_timeout: Timeout::new(15),
            reward_puzzle_hash: PuzzleHash::default(),
        });
        let payload = HandshakePayloadB {
            capabilities: local_capabilities(),
            channel_public_key: Default::default(),
            unroll_public_key: Default::default(),
            reward_puzzle_hash: Default::default(),
            referee_pubkey: Default::default(),
            reward_payout_signature: Default::default(),
            channel_key_pop: Default::default(),
            unroll_key_pop: Default::default(),
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
        };
        phase.state = ReceiverState::Finished(Box::new(HandshakeStepWithSpend {
            info: HandshakeStepInfo {
                first_player_hs_info: payload.clone(),
                second_player_hs_info: payload,
            },
            spend: SpendBundle {
                name: None,
                spends: vec![],
            },
        }));
        phase
    }

    fn payload_colliding_with_local_channel_key(
        phase: &HandshakeReceiverPhase,
    ) -> HandshakePayloadB {
        let channel_key =
            crate::common::types::PrivateKey::from_bytes(&[44; 32]).expect("channel key");
        let unroll_key =
            crate::common::types::PrivateKey::from_bytes(&[45; 32]).expect("unroll key");
        let referee_key = phase.private_keys.my_channel_coin_private_key.clone();
        let channel_public_key = private_to_public_key(&channel_key);
        let unroll_public_key = private_to_public_key(&unroll_key);
        let referee_pubkey = private_to_public_key(&referee_key);
        let reward_puzzle_hash = PuzzleHash::from_bytes([46; 32]);
        HandshakePayloadB {
            capabilities: local_capabilities(),
            channel_key_pop: channel_key.sign(channel_public_key.bytes()),
            unroll_key_pop: unroll_key.sign(unroll_public_key.bytes()),
            reward_payout_signature: sign_reward_payout(&referee_key, &reward_puzzle_hash),
            channel_public_key,
            unroll_public_key,
            reward_puzzle_hash,
            referee_pubkey,
            my_contribution: phase.their_contribution.clone(),
            their_contribution: phase.my_contribution.clone(),
        }
    }

    #[test]
    fn handshake_a_is_routed_through_shared_ab_validator() {
        let mut phase = finished_phase();
        phase.state = ReceiverState::WaitingForA;
        let payload = payload_colliding_with_local_channel_key(&phase);
        let mut allocator = crate::common::types::AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let error = phase
            .process_message(
                &mut env,
                Rc::new(PeerMessage::HandshakeA(Box::new(payload))),
            )
            .expect_err("HandshakeA collision");
        assert!(format!("{error:?}").contains("public key collision"));
    }

    #[test]
    fn handshake_a_request_failure_does_not_publish_waiting_state() {
        let mut phase = finished_phase();
        phase.state = ReceiverState::WaitingForA;
        phase.last_height = 1;
        phase.my_contribution = Amount::new(u64::MAX);
        phase.opening_fee = Amount::new(1);
        let mut payload = payload_colliding_with_local_channel_key(&phase);
        let referee_key =
            crate::common::types::PrivateKey::from_bytes(&[47; 32]).expect("referee key");
        payload.referee_pubkey = private_to_public_key(&referee_key);
        payload.reward_payout_signature =
            sign_reward_payout(&referee_key, &payload.reward_puzzle_hash);

        let mut allocator = crate::common::types::AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let error = phase
            .process_message(
                &mut env,
                Rc::new(PeerMessage::HandshakeA(Box::new(payload))),
            )
            .expect_err("overflow must reject HandshakeA");

        assert!(format!("{error:?}").contains("overflowed u64"));
        assert!(matches!(phase.state, ReceiverState::WaitingForA));
        assert!(!phase.pending_coin_spend);
        assert!(phase.channel_deadline.is_none());
    }

    #[test]
    fn activation_lag_messages_remain_fifo_while_wallet_completion_waits() {
        let mut phase = finished_phase();
        let mut allocator = crate::common::types::AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        for message in [
            PeerMessage::Message(GameID(1), vec![1]),
            PeerMessage::RequestPotato(()),
            PeerMessage::Message(GameID(2), vec![2]),
        ] {
            let encoded =
                crate::session_phases::peer_wire::encode_peer_message(&message).expect("encode");
            phase
                .received_message(&mut env, encoded)
                .expect("queue activation-lag message");
        }

        let queued: Vec<PeerMessage> = phase
            .incoming_messages
            .iter()
            .map(|(message, _)| message.as_ref().clone())
            .collect();
        assert!(matches!(queued[0], PeerMessage::Message(GameID(1), _)));
        assert!(matches!(queued[1], PeerMessage::RequestPotato(())));
        assert!(matches!(queued[2], PeerMessage::Message(GameID(2), _)));
    }

    #[test]
    fn handshake_queue_count_violation_clears_during_failure_escalation() {
        let mut phase = finished_phase();
        let mut allocator = crate::common::types::AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let encoded =
            crate::session_phases::peer_wire::encode_peer_message(&PeerMessage::RequestPotato(()))
                .expect("encode request");
        for _ in 0..MAX_QUEUED_PEER_MESSAGES {
            phase
                .received_message(&mut env, encoded.clone())
                .expect("within queue limit");
        }
        let error = phase
            .received_message(&mut env, encoded)
            .expect_err("queue count must be bounded");
        assert!(format!("{error:?}").contains("queued message count"));

        PeerLifecyclePhase::go_on_chain(&mut phase, &mut env, true).expect("failure escalation");
        assert!(phase.incoming_messages.is_empty());
    }
}
