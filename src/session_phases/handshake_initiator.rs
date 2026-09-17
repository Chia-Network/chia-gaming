use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::run_program;
use serde::{Deserialize, Serialize};

use crate::channel_state::types::{
    ChannelCoinSpendInfo, ChannelEnv, ChannelInitiationResult, ChannelPrivateKeys, ReadableMove,
    StateUpdateSignatures,
};
use crate::channel_state::ChannelState;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_synthetic_public_key, sign_reward_payout,
};
use crate::common::types::{
    chia_dialect, Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, Error, GameID,
    GameType, GetCoinStringParts, Hash, IntoErr, Node, Program, ProgramRef, Puzzle, PuzzleHash,
    Sha256Input, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram, MAX_BLOCK_COST_CLVM,
};
use crate::game_session::{phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::effects::{
    format_coin, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect, FailedGameAction,
    GameNotification, TimeoutClaimSemantic,
};
use crate::session_phases::handshake::{
    local_capabilities, raw_coin_conditions_to_clvm, validate_ab_payload,
    validate_assembled_channel_funding, CoinSpendRequest, HandshakePayloadB, HandshakePayloadC,
    HandshakePayloadD, HandshakeStepInfo, HandshakeStepWithSpend, RawCoinCondition,
    MAX_PEER_MESSAGE_SIZE, MAX_QUEUED_PEER_BYTES, MAX_QUEUED_PEER_MESSAGES,
};
use crate::session_phases::proposal::GameProposal;
use crate::session_phases::types::{OffChainPhaseInit, PeerMessage, SpendWalletReceiver};
use crate::session_phases::OffChainPhase;

#[derive(Debug, Serialize, Deserialize)]
enum InitiatorState {
    WaitingForStart,
    SentA(Box<HandshakePayloadB>),
    WaitingForOffer(Box<HandshakeStepInfo>, StateUpdateSignatures),
    Finished(Box<HandshakeStepWithSpend>),
    Done,
}

pub(crate) fn validate_wallet_bundle_applies_conditions(
    allocator: &mut AllocEncoder,
    wallet_bundle: &SpendBundle,
    request: &CoinSpendRequest,
) -> Result<CoinString, Error> {
    let required_hashes =
        raw_coin_conditions_to_clvm(allocator, &request.conditions, request.max_height)?
            .into_iter()
            .map(|condition| condition.sha256tree(allocator))
            .collect::<Vec<_>>();
    let mut matching_coin = None;
    for spend in &wallet_bundle.spends {
        if request
            .coin_id
            .as_ref()
            .is_some_and(|coin_id| spend.coin.to_coin_id() != *coin_id)
        {
            continue;
        }
        let puzzle = spend.bundle.puzzle.to_program().to_nodeptr(allocator)?;
        let solution = spend.bundle.solution.to_nodeptr(allocator)?;
        let emitted = run_program(
            allocator.allocator(),
            &chia_dialect(),
            puzzle,
            solution,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()?
        .1;
        let emitted = crate::utils::proper_list(allocator.allocator_ref(), emitted, true)
            .ok_or_else(|| Error::Channel("wallet coin conditions were not a list".to_string()))?;
        let emitted_hashes = emitted
            .into_iter()
            .map(|condition| Node(condition).sha256tree(allocator))
            .collect::<Vec<_>>();
        if required_hashes
            .iter()
            .all(|required| emitted_hashes.contains(required))
        {
            if matching_coin.is_some() {
                return Err(Error::Channel(
                    "wallet funding offer applied the required conditions to multiple spends; expected exactly one"
                        .to_string(),
                ));
            }
            matching_coin = Some(spend.coin.clone());
        }
    }
    matching_coin.ok_or_else(|| {
        Error::Channel(
            "wallet funding offer applied the required conditions to 0 spends; expected exactly one"
                .to_string(),
        )
    })
}

#[derive(Serialize, Deserialize)]
pub struct HandshakeInitiatorPhase {
    state: InitiatorState,

    channel_state: Option<ChannelState>,
    channel_initiation_transaction: Option<SpendBundle>,
    funding_coin: Option<CoinString>,
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

    waiting_to_start: bool,
    transaction_pushed: bool,
    funding_announcement: Option<Hash>,
    incoming_messages: VecDeque<(Rc<PeerMessage>, usize)>,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    failed: bool,
    #[serde(default)]
    failure_advisory: Option<String>,

    #[serde(skip)]
    replacement: Option<Box<OffChainPhase>>,
}

impl HandshakeInitiatorPhase {
    pub fn new(phi: OffChainPhaseInit) -> Self {
        HandshakeInitiatorPhase {
            state: InitiatorState::WaitingForStart,
            channel_state: None,
            channel_initiation_transaction: None,
            funding_coin: None,
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
            waiting_to_start: true,
            transaction_pushed: false,
            funding_announcement: None,
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
            .ok_or_else(|| Error::StrErr("initiator handshake: no channel handler yet".to_string()))
    }

    fn channel_state_mut(&mut self) -> Result<&mut ChannelState, Error> {
        self.channel_state
            .as_mut()
            .ok_or_else(|| Error::StrErr("initiator handshake: no channel handler yet".to_string()))
    }

    pub fn start(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Option<Effect>, Error> {
        game_assert!(
            matches!(self.state, InitiatorState::WaitingForStart),
            "start: expected WaitingForStart state"
        );

        let my_hs_info = self.my_handshake_b();
        self.state = InitiatorState::SentA(Box::new(my_hs_info.clone()));

        Ok(Some(Effect::PeerHandshakeA(my_hs_info)))
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

    fn my_handshake_b(&self) -> HandshakePayloadB {
        let channel_public_key =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
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
    }

    fn try_send_step_c(
        &mut self,
        info: HandshakeStepInfo,
        our_sigs: StateUpdateSignatures,
    ) -> Result<Option<Effect>, Error> {
        if let Some(spend) = self.channel_initiation_transaction.clone() {
            let send_effect = Effect::PeerHandshakeC(HandshakePayloadC {
                bundle: spend.clone(),
                signatures: our_sigs,
            });
            self.state = InitiatorState::Finished(Box::new(HandshakeStepWithSpend { info, spend }));
            return Ok(Some(send_effect));
        }
        Ok(None)
    }

    fn encode_u64_as_clvm_int(val: u64) -> Vec<u8> {
        if val == 0 {
            return vec![];
        }
        let mut bytes = Vec::new();
        let mut h = val;
        while h > 0 {
            bytes.push((h & 0xff) as u8);
            h >>= 8;
        }
        bytes.reverse();
        if bytes[0] & 0x80 != 0 {
            bytes.insert(0, 0);
        }
        bytes
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

    fn contribution_amount(&self) -> Result<Amount, Error> {
        self.my_contribution
            .to_u64()
            .checked_add(self.opening_fee.to_u64())
            .map(Amount::new)
            .ok_or_else(|| {
                Error::StrErr("initiator contribution plus opening fee overflowed u64".to_string())
            })
    }

    fn contribution_puzzle(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<(Puzzle, PuzzleHash), Error> {
        let ch = self.channel_state()?;
        let channel_coin = ch.channel_coin();
        let (launcher_coin_id, channel_puzzle_hash, total_amount) =
            channel_coin.get_coin_string_parts()?;
        let ann_hash = self.compute_coin_announcement_hash(
            &launcher_coin_id,
            &channel_puzzle_hash,
            &total_amount,
        )?;
        self.funding_announcement = Some(ann_hash.clone());
        let mut nodes = vec![
            (crate::common::constants::SEND_MESSAGE, (24_u8, ((), ())))
                .to_clvm(env.allocator)
                .into_gen()?,
            (
                crate::common::constants::ASSERT_COIN_ANNOUNCEMENT,
                (ann_hash.clone(), ()),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        ];
        if self.opening_fee.to_u64() > 0 {
            nodes.push(
                (
                    crate::common::constants::RESERVE_FEE_ATOM[0],
                    (self.opening_fee.clone(), ()),
                )
                    .to_clvm(env.allocator)
                    .into_gen()?,
            );
        }
        let conditions = nodes.to_clvm(env.allocator).into_gen()?;
        let puzzle: Puzzle = conditions.to_quoted_program(env.allocator)?.into();
        let puzzle_hash = puzzle.sha256tree(env.allocator);
        Ok((puzzle, puzzle_hash))
    }

    fn build_alice_coin_spend_request(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<CoinSpendRequest, Error> {
        let amount = self.contribution_amount()?;
        let (_, puzzle_hash) = self.contribution_puzzle(env)?;
        Ok(CoinSpendRequest {
            amount: amount.clone(),
            fee: self.opening_fee.clone(),
            conditions: vec![RawCoinCondition {
                opcode: crate::common::constants::RECEIVE_MESSAGE,
                args: vec![
                    vec![24],
                    vec![],
                    puzzle_hash.bytes().to_vec(),
                    Self::encode_u64_as_clvm_int(amount.to_u64()),
                ],
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
        if let InitiatorState::Finished(_) = &self.state {
            let ch = self
                .channel_state
                .take()
                .expect("channel handler must exist at Finished");
            let queued_messages = std::mem::take(&mut self.incoming_messages)
                .into_iter()
                .map(|(message, _)| message)
                .collect();

            let ph = OffChainPhase::from_completed_handshake(
                true,
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
            self.state = InitiatorState::Done;
        }
    }

    fn process_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        match &self.state {
            InitiatorState::WaitingForStart => {
                return Err(Error::StrErr(format!(
                    "initiator WaitingForStart: unexpected message before start: {msg_envelope:?}"
                )));
            }

            InitiatorState::SentA(handshake_a) => {
                let handshake_a = (**handshake_a).clone();
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake B message, got {msg_envelope:?}"
                    )));
                };

                validate_ab_payload(
                    &msg.identity,
                    &self.private_keys,
                    &self.reward_puzzle_hash,
                    &self.my_contribution,
                    &self.their_contribution,
                )?;

                let our_channel_pk =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let aggregate_pk = our_channel_pk + msg.identity.channel_public_key.clone();
                let channel_puzzle_hash =
                    puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_pk)?;
                let launcher_coin = CoinString::from_parts(
                    &msg.channel_coin_grandparent,
                    &PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH),
                    &Amount::default(),
                );
                let (channel_state, _) =
                    self.make_channel_state(launcher_coin.to_coin_id(), false, &msg.identity, env)?;
                self.channel_state = Some(channel_state);
                let genesis = self
                    .channel_state_mut()?
                    .initialize_genesis_as_initiator(env, &msg.signatures)
                    .map_err(|e| {
                        Error::StrErr(format!(
                            "initiator step B: genesis initialization failed: {e}"
                        ))
                    })?;
                self.last_channel_coin_spend_info = Some(genesis.state_zero_spend);
                let our_sigs = genesis.state_one_signatures;
                let info = HandshakeStepInfo {
                    first_player_hs_info: handshake_a,
                    second_player_hs_info: msg.identity.clone(),
                };
                effects.push(Effect::ChannelPuzzleHash(channel_puzzle_hash));
                effects.push(Effect::RegisterCoin {
                    coin: self.channel_state()?.channel_coin().clone(),
                    timeout: Timeout::new(1_000_000),
                    name: Some("channel"),
                    spend: None,
                    semantic: None,
                });
                if self.last_height > 0 {
                    let coin_spend_request = self.build_alice_coin_spend_request(env)?;
                    self.channel_deadline = self.compute_not_valid_after_height();
                    effects.push(Effect::NeedCoinSpend(coin_spend_request));
                } else {
                    self.pending_coin_spend = true;
                }
                self.state = InitiatorState::WaitingForOffer(Box::new(info), our_sigs);
            }

            InitiatorState::WaitingForOffer(_, _) => {
                return Err(Error::StrErr(format!(
                    "initiator WaitingForOffer: unexpected peer message: {msg_envelope:?}"
                )));
            }

            InitiatorState::Finished(_) => {
                if let PeerMessage::HandshakeD(HandshakePayloadD { bundle }) = msg_envelope.borrow()
                {
                    if !self.transaction_pushed {
                        let initiator_bundle = match &self.state {
                            InitiatorState::Finished(step) => step.spend.clone(),
                            _ => unreachable!(),
                        };
                        let announcement = self.funding_announcement.as_ref().ok_or_else(|| {
                            Error::StrErr(
                                "handshake D arrived without a funding announcement".to_string(),
                            )
                        })?;
                        let combined = validate_assembled_channel_funding(
                            env.allocator,
                            &initiator_bundle,
                            bundle,
                            announcement,
                            &env.agg_sig_me_additional_data,
                            self.last_height,
                        )?;
                        effects.push(Effect::SpendTransaction(combined, self.channel_deadline));
                        self.transaction_pushed = true;
                    }
                } else {
                    return Err(Error::StrErr(format!(
                        "initiator Finished: expected handshake D, got {msg_envelope:?}"
                    )));
                }
            }

            InitiatorState::Done => {
                return Err(Error::StrErr(format!(
                    "initiator Done: unexpected queued message: {msg_envelope:?}"
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
        if matches!(self.state, InitiatorState::Finished(_)) {
            match &msg_envelope {
                PeerMessage::HandshakeD(_) => {}
                PeerMessage::HandshakeA(_)
                | PeerMessage::HandshakeB(_)
                | PeerMessage::HandshakeC(_) => {
                    return Err(Error::StrErr(
                        "initiator Finished: out-of-order handshake message".to_string(),
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
                "initiator handshake queued message count exceeds maximum {MAX_QUEUED_PEER_MESSAGES}"
            )));
        }
        if queued_bytes + raw_len > MAX_QUEUED_PEER_BYTES {
            return Err(Error::StrErr(format!(
                "initiator handshake queued message bytes {} exceeds maximum {MAX_QUEUED_PEER_BYTES}",
                queued_bytes + raw_len
            )));
        }
        self.incoming_messages.push_back((message, raw_len));
        Ok(())
    }
}

impl SpendWalletReceiver for HandshakeInitiatorPhase {
    fn coin_created(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        if !self.waiting_to_start {
            return Ok(None);
        }

        let has_channel_coin = self
            .channel_state()
            .ok()
            .map(|ch| ch.channel_coin())
            .is_some();

        if !has_channel_coin {
            return Ok(None);
        }

        self.waiting_to_start = false;

        let channel_coin = self
            .channel_state()
            .ok()
            .map(|ch| ch.channel_coin().clone())
            .expect("has_channel_coin was true");

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
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::Log(format!(
            "[initiator-handshake:coin-spent] {}",
            format_coin(coin_id),
        ))])
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::Log(format!(
            "[initiator-handshake:coin-puzzle] {}",
            format_coin(coin_id),
        ))])
    }
}

#[typetag::serde]
impl PeerLifecyclePhase for HandshakeInitiatorPhase {
    fn phase_name(&self) -> &'static str {
        "handshake initiator phase"
    }
    fn has_queued_message(&self) -> bool {
        !self.incoming_messages.is_empty()
    }
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        HandshakeInitiatorPhase::process_queued_message(self, env)
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
        HandshakeInitiatorPhase::received_message(self, env, msg)
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
    #[cfg(test)]
    fn self_accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "self_accept_proposal",
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
            let req = self.build_alice_coin_spend_request(env)?;
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
        env: &mut ChannelEnv<'_>,
        opening_fee: Amount,
    ) -> Result<Option<Effect>, Error> {
        self.opening_fee = opening_fee;
        self.start(env)
    }
    fn channel_offer(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        self.channel_initiation_transaction = Some(bundle);

        if let InitiatorState::WaitingForOffer(info, sigs) = &self.state {
            let info = *info.clone();
            let sigs = sigs.clone();
            let result = self.try_send_step_c(info, sigs)?;
            self.try_transition_to_off_chain();
            return Ok(result);
        }

        Ok(None)
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "channel_transaction_completion",
        ))
    }
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelEnv<'_>,
        wallet_bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        let bundle = if matches!(self.state, InitiatorState::WaitingForOffer(_, _)) {
            let mut request = self.build_alice_coin_spend_request(env)?;
            request.max_height = self.channel_deadline;
            self.funding_coin = Some(validate_wallet_bundle_applies_conditions(
                env.allocator,
                &wallet_bundle,
                &request,
            )?);
            let amount = self.contribution_amount()?;
            let (contribution_puzzle, contribution_ph) = self.contribution_puzzle(env)?;
            let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
            let mut settlement_coins = Vec::new();
            let mut direct_contribution_coins = Vec::new();
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
                        } else if ph == contribution_ph && created_amount == amount {
                            direct_contribution_coins.push(CoinString::from_parts(
                                &spend.coin.to_coin_id(),
                                &contribution_ph,
                                &amount,
                            ));
                        }
                    }
                }
            }
            let (settlement_coin, contribution_coin) = match (
                settlement_coins.as_slice(),
                direct_contribution_coins.as_slice(),
            ) {
                ([settlement_coin], []) => (
                    Some(settlement_coin.clone()),
                    CoinString::from_parts(
                        &settlement_coin.to_coin_id(),
                        &contribution_ph,
                        &amount,
                    ),
                ),
                ([], [contribution_coin]) => (None, contribution_coin.clone()),
                _ => {
                    return Err(Error::Channel(format!(
                            "initiator wallet bundle created {} settlement and {} direct contribution candidates; expected exactly one funding path",
                            settlement_coins.len(),
                            direct_contribution_coins.len(),
                        )));
                }
            };
            let settlement_solution_node = if let Some(settlement_coin) = &settlement_coin {
                let payment = (contribution_ph, (amount.clone(), ()))
                    .to_clvm(env.allocator)
                    .into_gen()?;
                let notarized_payment = (settlement_coin.to_coin_id(), (payment, ()))
                    .to_clvm(env.allocator)
                    .into_gen()?;
                Some(vec![notarized_payment].to_clvm(env.allocator).into_gen()?)
            } else {
                None
            };
            let mut spends = wallet_bundle.spends;
            if let (Some(settlement_coin), Some(settlement_solution_node)) =
                (settlement_coin, settlement_solution_node)
            {
                spends.push(CoinSpend {
                    coin: settlement_coin,
                    bundle: Spend {
                        puzzle: Puzzle::from_bytes(&chia_puzzles::SETTLEMENT_PAYMENT)?,
                        solution: Program::from_nodeptr(env.allocator, settlement_solution_node)?
                            .into(),
                        signature: Aggsig::default(),
                    },
                });
            }
            spends.push(CoinSpend {
                coin: contribution_coin,
                bundle: Spend {
                    puzzle: contribution_puzzle,
                    solution: Program::nil().into(),
                    signature: Aggsig::default(),
                },
            });
            SpendBundle {
                name: Some("channel-opening".to_string()),
                spends,
            }
        } else {
            wallet_bundle
        };

        self.channel_offer(env, bundle)
            .map(|effect| effect.into_iter().collect::<Vec<_>>())
    }
    fn propose_games(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        Err(phase_operation_error(self.phase_name(), "propose_games"))
    }
    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "accept_proposal"))
    }
    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
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
                ..ChannelStatusSnapshot::new(ChannelStatus::WaitingForHeightToOffer)
            });
        }
        let state = match &self.state {
            InitiatorState::WaitingForStart | InitiatorState::SentA(_) => {
                ChannelStatus::Handshaking
            }
            InitiatorState::WaitingForOffer(_, _) => ChannelStatus::OurWalletMakingOffer,
            InitiatorState::Finished(_) => {
                if self.transaction_pushed {
                    ChannelStatus::TransactionPending
                } else {
                    ChannelStatus::OfferSent
                }
            }
            InitiatorState::Done => return None,
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
        // While funding is pending, surface both the predicted channel coin and
        // the local wallet coin that emitted the required extra conditions.
        let mut coins = self
            .channel_state
            .as_ref()
            .map(|ch| vec![(CoinOfInterest::Channel, ch.channel_coin().clone())])
            .unwrap_or_default();
        if let Some(funding_coin) = &self.funding_coin {
            coins.push((CoinOfInterest::Funding, funding_coin.clone()));
        }
        coins
    }
    fn channel_state(&self) -> Result<&ChannelState, Error> {
        HandshakeInitiatorPhase::channel_state(self)
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
    fn corrupt_state_for_testing(&mut self, _new_sn: usize) -> Result<(), Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "corrupt_state_for_testing",
        ))
    }
    #[cfg(test)]
    fn force_unroll_spend_for_testing(
        &self,
        _env: &mut ChannelEnv<'_>,
    ) -> Result<SpendBundle, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "force_unroll_spend_for_testing",
        ))
    }
    #[cfg(test)]
    fn last_channel_coin_spend_info_for_testing(&self) -> Option<ChannelCoinSpendInfo> {
        None
    }
    #[cfg(test)]
    fn force_stale_unroll_spend_for_testing(
        &self,
        _env: &mut ChannelEnv<'_>,
        _saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "force_stale_unroll_spend_for_testing",
        ))
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
mod finished_message_tests {
    use super::*;
    use crate::common::constants::{ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN_ANNOUNCEMENT};
    use crate::common::standard_coin::{private_to_public_key, sign_agg_sig_me};
    use crate::common::types::{Sha256Input, Sha256tree, ToQuotedProgram};
    use clvm_traits::ClvmEncoder;
    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    fn spend_for_conditions(
        allocator: &mut crate::common::types::AllocEncoder,
        tag: u8,
        conditions: clvmr::NodePtr,
    ) -> CoinSpend {
        let private_key =
            crate::common::types::PrivateKey::from_bytes(&[tag; 32]).expect("funding test key");
        let public_key = private_to_public_key(&private_key);
        let raw_message = b"funding test message";
        let message = crate::common::types::Node(
            allocator
                .encode_atom(clvm_traits::Atom::Borrowed(raw_message))
                .expect("signature message"),
        );
        let mut condition_nodes: Vec<_> =
            crate::utils::proper_list(allocator.allocator_ref(), conditions, true)
                .expect("condition list")
                .into_iter()
                .map(crate::common::types::Node)
                .collect();
        condition_nodes.push(crate::common::types::Node(
            (50_u8, (public_key, (message, ())))
                .to_clvm(allocator)
                .expect("AGG_SIG_ME condition"),
        ));
        let conditions = condition_nodes
            .to_clvm(allocator)
            .expect("combined conditions");
        let puzzle: Puzzle = conditions
            .to_quoted_program(allocator)
            .expect("quoted conditions")
            .into();
        let coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([tag; 32])),
            &puzzle.sha256tree(allocator),
            &Amount::new(1),
        );
        let signature = sign_agg_sig_me(
            &private_key,
            raw_message,
            &coin.to_coin_id(),
            &Hash::from_bytes(crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA),
        );
        CoinSpend {
            coin,
            bundle: Spend {
                puzzle,
                solution: Program::nil().into(),
                signature,
            },
        }
    }

    fn announcement_bound_bundles(
        allocator: &mut crate::common::types::AllocEncoder,
    ) -> (SpendBundle, SpendBundle, Hash) {
        let message = Hash::from_bytes([0xab; 32]);
        let create_conditions = ((CREATE_COIN_ANNOUNCEMENT, (message.clone(), ())), ())
            .to_clvm(allocator)
            .expect("create announcement conditions");
        let receiver_spend = spend_for_conditions(allocator, 2, create_conditions);
        let announcement = Sha256Input::Array(vec![
            Sha256Input::Bytes(receiver_spend.coin.to_coin_id().bytes()),
            Sha256Input::Bytes(message.bytes()),
        ])
        .hash();
        let assert_conditions = ((ASSERT_COIN_ANNOUNCEMENT, (announcement.clone(), ())), ())
            .to_clvm(allocator)
            .expect("assert announcement conditions");
        let initiator_spend = spend_for_conditions(allocator, 1, assert_conditions);
        (
            SpendBundle {
                name: None,
                spends: vec![initiator_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![receiver_spend],
            },
            announcement,
        )
    }

    fn finished_phase(e_bundle: SpendBundle, announcement: Hash) -> HandshakeInitiatorPhase {
        let mut rng = ChaCha8Rng::from_seed([20; 32]);
        let mut phase = HandshakeInitiatorPhase::new(OffChainPhaseInit {
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
        phase.funding_announcement = Some(announcement);
        phase.state = InitiatorState::Finished(Box::new(HandshakeStepWithSpend {
            info: HandshakeStepInfo {
                first_player_hs_info: payload.clone(),
                second_player_hs_info: payload,
            },
            spend: e_bundle,
        }));
        phase
    }

    fn encode_d(bundle: SpendBundle) -> Vec<u8> {
        crate::session_phases::peer_wire::encode_peer_message(&PeerMessage::HandshakeD(
            HandshakePayloadD { bundle },
        ))
        .expect("encode D")
    }

    fn payload_colliding_with_local_channel_key(
        phase: &HandshakeInitiatorPhase,
    ) -> HandshakePayloadB {
        let channel_key =
            crate::common::types::PrivateKey::from_bytes(&[41; 32]).expect("channel key");
        let unroll_key =
            crate::common::types::PrivateKey::from_bytes(&[42; 32]).expect("unroll key");
        let referee_key = phase.private_keys.my_channel_coin_private_key.clone();
        let channel_public_key = private_to_public_key(&channel_key);
        let unroll_public_key = private_to_public_key(&unroll_key);
        let referee_pubkey = private_to_public_key(&referee_key);
        let reward_puzzle_hash = PuzzleHash::from_bytes([43; 32]);
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
    fn handshake_b_is_routed_through_shared_ab_validator() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let mut phase = finished_phase(
            SpendBundle {
                name: None,
                spends: vec![],
            },
            Hash::default(),
        );
        phase.state = InitiatorState::WaitingForStart;
        phase.start(&mut env).expect("start initiator");
        let payload = payload_colliding_with_local_channel_key(&phase);
        let error = phase
            .process_message(
                &mut env,
                Rc::new(PeerMessage::HandshakeB(
                    crate::session_phases::handshake::HandshakePayloadBWithGenesis {
                        identity: payload,
                        channel_coin_grandparent: CoinID::default(),
                        signatures: StateUpdateSignatures::default(),
                    },
                )),
            )
            .expect_err("HandshakeB collision");
        assert!(format!("{error:?}").contains("public key collision"));
    }

    #[test]
    fn wallet_funding_bundle_returns_the_unique_condition_emitting_coin() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let conditions = ().to_clvm(&mut allocator).expect("nil conditions");
        let spend = spend_for_conditions(&mut allocator, 7, conditions);
        let expected_coin_id = spend.coin.to_coin_id();
        let request = CoinSpendRequest {
            amount: Amount::new(1),
            fee: Amount::default(),
            conditions: vec![],
            coin_id: Some(expected_coin_id.clone()),
            max_height: None,
        };

        let funding_coin = validate_wallet_bundle_applies_conditions(
            &mut allocator,
            &SpendBundle {
                name: None,
                spends: vec![spend.clone()],
            },
            &request,
        )
        .expect("matching launcher parent");
        assert_eq!(funding_coin.to_coin_id(), expected_coin_id);

        for spends in [vec![], vec![spend.clone(), spend]] {
            let error = validate_wallet_bundle_applies_conditions(
                &mut allocator,
                &SpendBundle { name: None, spends },
                &request,
            )
            .expect_err("missing or duplicate launcher parent must fail");
            assert!(format!("{error:?}").contains("expected exactly one"));
        }
    }

    #[test]
    fn finished_submits_only_the_first_independently_delivered_handshake_d() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (e_bundle, f_bundle, announcement) = announcement_bound_bundles(&mut allocator);
        let e_coin = e_bundle.spends[0].coin.clone();
        let f_coin = f_bundle.spends[0].coin.clone();
        let mut phase = finished_phase(e_bundle, announcement);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let encoded = encode_d(f_bundle);

        let first = phase
            .received_message(&mut env, encoded.clone())
            .expect("first D");
        let second = phase.received_message(&mut env, encoded).expect("second D");

        let submitted: Vec<_> = first
            .iter()
            .filter_map(|effect| match effect {
                Effect::SpendTransaction(bundle, _) => Some(bundle),
                _ => None,
            })
            .collect();
        assert_eq!(submitted.len(), 1);
        assert_eq!(submitted[0].spends.len(), 2);
        assert_eq!(submitted[0].spends[0].coin, e_coin);
        assert_eq!(submitted[0].spends[1].coin, f_coin);
        assert!(second.is_empty());
        assert!(phase.transaction_pushed);
    }

    #[test]
    fn finished_rejects_handshake_d_that_echoes_initiator_coins() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (e_bundle, mut f_bundle, announcement) = announcement_bound_bundles(&mut allocator);
        let mut echoed_spend = e_bundle.spends[0].clone();
        echoed_spend.bundle.signature = Aggsig::default();
        f_bundle.spends.push(echoed_spend);
        let mut phase = finished_phase(e_bundle, announcement);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let err = phase
            .received_message(&mut env, encode_d(f_bundle))
            .expect_err("echoed D");
        assert!(format!("{err:?}").contains("DoubleSpend"));
        assert!(!phase.transaction_pushed);
    }

    #[test]
    fn finished_rejects_handshake_d_without_launcher_announcement() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (e_bundle, _, announcement) = announcement_bound_bundles(&mut allocator);
        let empty_conditions = ().to_clvm(&mut allocator).expect("empty conditions");
        let f_bundle = SpendBundle {
            name: None,
            spends: vec![spend_for_conditions(&mut allocator, 2, empty_conditions)],
        };
        let mut phase = finished_phase(e_bundle, announcement);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let err = phase
            .received_message(&mut env, encode_d(f_bundle))
            .expect_err("silent D");
        assert!(format!("{err:?}").contains("spend bundle consensus validation failed"));
        assert!(!phase.transaction_pushed);
    }
}
