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
    Sha256Input, Sha256tree, Spend, SpendBundle, Timeout, MAX_BLOCK_COST_CLVM,
};
use crate::game_session::{claim_settlement_coins, phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::effects::{
    format_coin, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect, FailedGameAction,
    GameNotification, TimeoutClaimSemantic,
};
use crate::session_phases::handshake::{
    local_capabilities, raw_coin_conditions_to_clvm, validate_ab_payload,
    validate_assembled_channel_funding, CoinSpendRequest, HandshakePayloadB, HandshakePayloadC,
    HandshakePayloadE, HandshakePayloadF, HandshakeStepInfo, HandshakeStepWithSpend,
    RawCoinCondition, MAX_PEER_MESSAGE_SIZE, MAX_QUEUED_PEER_BYTES, MAX_QUEUED_PEER_MESSAGES,
};
use crate::session_phases::proposal::GameProposal;
use crate::session_phases::types::{OffChainPhaseInit, PeerMessage, SpendWalletReceiver};
use crate::session_phases::OffChainPhase;

const MAX_WALLET_OFFER_MISMATCHES: u8 = 3;

#[derive(Debug, Serialize, Deserialize)]
enum InitiatorState {
    WaitingForStart,
    SentA(Box<HandshakePayloadB>),
    WaitingForLauncher(Box<HandshakeStepInfo>),
    SentC(Box<HandshakeStepInfo>),
    WaitingForOffer(Box<HandshakeStepInfo>, StateUpdateSignatures),
    Finished(Box<HandshakeStepWithSpend>),
    Done,
}

fn validate_wallet_bundle_applies_conditions(
    allocator: &mut AllocEncoder,
    wallet_bundle: &SpendBundle,
    request: &CoinSpendRequest,
) -> Result<(), Error> {
    let expected_coin_id = request.coin_id.as_ref().ok_or_else(|| {
        Error::Channel("wallet funding request did not specify a coin".to_string())
    })?;
    let matching_spends = wallet_bundle
        .spends
        .iter()
        .filter(|spend| spend.coin.to_coin_id() == *expected_coin_id)
        .collect::<Vec<_>>();
    if matching_spends.len() != 1 {
        return Err(Error::Channel(format!(
            "wallet funding offer spent launcher parent {} times; expected exactly once",
            matching_spends.len()
        )));
    }

    let spend = matching_spends[0];
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
    let mut emitted_hashes = emitted
        .into_iter()
        .map(|condition| Node(condition).sha256tree(allocator))
        .collect::<Vec<_>>();

    for required in raw_coin_conditions_to_clvm(allocator, &request.conditions, request.max_height)?
    {
        let required_hash = required.sha256tree(allocator);
        let Some(index) = emitted_hashes
            .iter()
            .position(|emitted| *emitted == required_hash)
        else {
            return Err(Error::Channel(
                "wallet funding offer put required conditions on a different coin".to_string(),
            ));
        };
        emitted_hashes.swap_remove(index);
    }

    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct HandshakeInitiatorPhase {
    state: InitiatorState,

    channel_state: Option<ChannelState>,
    channel_initiation_transaction: Option<SpendBundle>,
    launcher_coin: Option<CoinString>,
    #[serde(default)]
    opening_fee: Amount,
    #[serde(default)]
    offer_settlement_coin: Option<CoinString>,

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
    #[serde(default)]
    wallet_offer_mismatches: u8,

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
            launcher_coin: None,
            opening_fee: Amount::default(),
            offer_settlement_coin: None,
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
            wallet_offer_mismatches: 0,
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

    fn try_send_step_e(
        &mut self,
        info: HandshakeStepInfo,
        our_sigs: StateUpdateSignatures,
    ) -> Result<Option<Effect>, Error> {
        if let Some(spend) = self.channel_initiation_transaction.clone() {
            let send_effect = Effect::PeerHandshakeE(HandshakePayloadE {
                bundle: spend.clone(),
                signatures: our_sigs,
            });
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

    fn build_launcher_coin_spend(&self, env: &mut ChannelEnv<'_>) -> Result<CoinSpend, Error> {
        let ch = self.channel_state()?;
        let channel_coin = ch.channel_coin();
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
                puzzle: Puzzle::from_bytes(&crate::common::constants::SINGLETON_LAUNCHER)
                    .expect("valid singleton launcher constant"),
                solution: launcher_solution_program.into(),
                signature: Aggsig::default(),
            },
        })
    }

    fn build_settlement_launcher_spend(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<Option<CoinSpend>, Error> {
        let Some(settlement_coin) = self.offer_settlement_coin.clone() else {
            return Ok(None);
        };
        let launcher_coin = self.get_launcher_coin()?;
        let (_, launcher_puzzle_hash, launcher_amount) = launcher_coin.get_coin_string_parts()?;
        let payment = (launcher_puzzle_hash, (launcher_amount, ()))
            .to_clvm(env.allocator)
            .into_gen()?;
        let notarized_payment = (settlement_coin.to_coin_id(), (payment, ()))
            .to_clvm(env.allocator)
            .into_gen()?;
        let solution_node = vec![notarized_payment].to_clvm(env.allocator).into_gen()?;
        let solution = Program::from_nodeptr(env.allocator, solution_node)?;
        Ok(Some(CoinSpend {
            coin: settlement_coin,
            bundle: Spend {
                puzzle: Puzzle::from_bytes(&chia_puzzles::SETTLEMENT_PAYMENT)?,
                solution: solution.into(),
                signature: Aggsig::default(),
            },
        }))
    }

    fn validate_offer_settlement_created(
        &self,
        allocator: &mut AllocEncoder,
        wallet_bundle: &SpendBundle,
    ) -> Result<(), Error> {
        let Some(settlement_coin) = self.offer_settlement_coin.as_ref() else {
            return Ok(());
        };
        let (wallet_coin_id, settlement_ph, settlement_amount) =
            settlement_coin.get_coin_string_parts()?;
        let source_spend = wallet_bundle
            .spends
            .iter()
            .find(|spend| spend.coin.to_coin_id() == wallet_coin_id)
            .ok_or_else(|| {
                Error::Channel(
                    "wallet funding offer did not spend the committed settlement parent"
                        .to_string(),
                )
            })?;
        let conditions = crate::common::types::CoinCondition::from_puzzle_and_solution(
            allocator,
            source_spend.bundle.puzzle.to_program().as_ref(),
            source_spend.bundle.solution.p().as_ref(),
        )?;
        let matching = conditions
            .iter()
            .filter(|condition| {
                matches!(
                    condition,
                    crate::common::types::CoinCondition::CreateCoin(ph, amount)
                        if *ph == settlement_ph && *amount == settlement_amount
                )
            })
            .count();
        if matching != 1 {
            return Err(Error::Channel(format!(
                "wallet funding offer created {matching} matching settlement coins, expected 1"
            )));
        }
        Ok(())
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

    fn build_alice_coin_spend_request(&mut self) -> Result<CoinSpendRequest, Error> {
        let ch = self.channel_state()?;
        let channel_coin = ch.channel_coin();
        let (_, channel_puzzle_hash, total_amount) = channel_coin.get_coin_string_parts()?;
        let launcher_coin = self.get_launcher_coin()?;
        let launcher_coin_id = launcher_coin.to_coin_id();
        let (launcher_parent, _, launcher_amount) = launcher_coin.get_coin_string_parts()?;

        let ann_hash = self.compute_coin_announcement_hash(
            &launcher_coin_id,
            &channel_puzzle_hash,
            &total_amount,
        )?;
        self.funding_announcement = Some(ann_hash.clone());
        let (amount, coin_id, mut conditions) =
            if let Some(settlement_coin) = self.offer_settlement_coin.as_ref() {
                let (wallet_coin_id, _, _) = settlement_coin.get_coin_string_parts()?;
                let total = self
                    .my_contribution
                    .to_u64()
                    .checked_add(self.opening_fee.to_u64())
                    .ok_or_else(|| {
                        Error::StrErr(
                            "initiator contribution plus opening fee overflowed u64".to_string(),
                        )
                    })?;
                (Amount::new(total), wallet_coin_id, Vec::new())
            } else {
                let launcher_ph_bytes = crate::common::constants::SINGLETON_LAUNCHER_HASH.to_vec();
                let amount_bytes = Self::encode_u64_as_clvm_int(launcher_amount.to_u64());
                (
                    self.my_contribution.clone(),
                    launcher_parent,
                    vec![RawCoinCondition {
                        opcode: crate::common::constants::CREATE_COIN,
                        args: vec![launcher_ph_bytes, amount_bytes],
                    }],
                )
            };
        conditions.push(RawCoinCondition {
            opcode: crate::common::constants::ASSERT_COIN_ANNOUNCEMENT,
            args: vec![ann_hash.bytes().to_vec()],
        });
        if self.opening_fee.to_u64() > 0 {
            conditions.push(RawCoinCondition {
                opcode: crate::common::constants::RESERVE_FEE_ATOM[0] as u32,
                args: vec![Self::encode_u64_as_clvm_int(self.opening_fee.to_u64())],
            });
        }
        Ok(CoinSpendRequest {
            amount,
            fee: self.opening_fee.clone(),
            conditions,
            coin_id: Some(coin_id),
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
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake B message, got {msg_envelope:?}"
                    )));
                };

                validate_ab_payload(
                    msg,
                    &self.private_keys,
                    &self.reward_puzzle_hash,
                    &self.my_contribution,
                    &self.their_contribution,
                )?;

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
                return Err(Error::StrErr(format!(
                    "initiator WaitingForLauncher: unexpected peer message: {msg_envelope:?}"
                )));
            }

            InitiatorState::SentC(_info) => {
                let msg = if let PeerMessage::HandshakeD(msg) = msg_envelope.borrow() {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake D message, got {msg_envelope:?}"
                    )));
                };

                let genesis = {
                    let ch = self.channel_state_mut()?;
                    ch.initialize_genesis_as_initiator(env, &msg.signatures)
                        .map_err(|e| {
                            Error::StrErr(format!(
                                "initiator step D: genesis initialization failed: {e}"
                            ))
                        })?
                };
                self.last_channel_coin_spend_info = Some(genesis.state_zero_spend);
                let our_sigs = genesis.state_one_signatures;
                if self.last_height > 0 {
                    let coin_spend_request = self.build_alice_coin_spend_request()?;
                    self.channel_deadline = self.compute_not_valid_after_height();
                    effects.push(Effect::NeedCoinSpend(coin_spend_request));
                } else {
                    self.pending_coin_spend = true;
                }

                let info = match std::mem::replace(&mut self.state, InitiatorState::WaitingForStart)
                {
                    InitiatorState::SentC(info) => *info,
                    _ => unreachable!(),
                };
                self.state = InitiatorState::WaitingForOffer(Box::new(info), our_sigs);
            }

            InitiatorState::WaitingForOffer(_, _) => {
                return Err(Error::StrErr(format!(
                    "initiator WaitingForOffer: unexpected peer message: {msg_envelope:?}"
                )));
            }

            InitiatorState::Finished(_) => {
                if let PeerMessage::HandshakeF(HandshakePayloadF { bundle }) = msg_envelope.borrow()
                {
                    if !self.transaction_pushed {
                        let initiator_bundle = match &self.state {
                            InitiatorState::Finished(step) => step.spend.clone(),
                            _ => unreachable!(),
                        };
                        let announcement = self.funding_announcement.as_ref().ok_or_else(|| {
                            Error::StrErr(
                                "handshake F arrived without a funding announcement".to_string(),
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
                        "initiator Finished: expected handshake F, got {msg_envelope:?}"
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
                PeerMessage::HandshakeF(_) => {}
                PeerMessage::HandshakeA(_)
                | PeerMessage::HandshakeB(_)
                | PeerMessage::HandshakeC(_)
                | PeerMessage::HandshakeD(_)
                | PeerMessage::HandshakeE(_) => {
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
    fn new_block(&mut self, height: u64) -> Result<Vec<Effect>, Error> {
        self.last_height = height;
        if self.pending_coin_spend && self.last_height > 0 {
            self.pending_coin_spend = false;
            let req = self.build_alice_coin_spend_request()?;
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
    fn start_handshake(&mut self, env: &mut ChannelEnv<'_>) -> Result<Option<Effect>, Error> {
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
            let result = self.try_send_step_e(info, sigs)?;
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
    fn provide_launcher_coin(
        &mut self,
        env: &mut ChannelEnv<'_>,
        launcher_coin: CoinString,
        opening_fee: Amount,
        offer_settlement_coin: Option<CoinString>,
    ) -> Result<Vec<Effect>, Error> {
        let info = match &self.state {
            InitiatorState::WaitingForLauncher(info) => (**info).clone(),
            _ => {
                return Err(Error::StrErr(
                    "provide_launcher_coin: not in WaitingForLauncher state".to_string(),
                ))
            }
        };

        let (launcher_parent, launcher_ph, launcher_amount) =
            launcher_coin.get_coin_string_parts()?;
        let expected_ph = PuzzleHash::from_bytes(crate::common::constants::SINGLETON_LAUNCHER_HASH);
        if launcher_ph != expected_ph {
            return Err(Error::Channel(
                "Launcher coin puzzle hash is not SINGLETON_LAUNCHER".to_string(),
            ));
        }
        if let Some(settlement_coin) = offer_settlement_coin.as_ref() {
            let (_, settlement_ph, settlement_amount) = settlement_coin.get_coin_string_parts()?;
            let expected_settlement_ph =
                PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
            let expected_settlement_amount = self
                .my_contribution
                .to_u64()
                .checked_add(opening_fee.to_u64())
                .ok_or_else(|| {
                    Error::StrErr(
                        "initiator contribution plus opening fee overflowed u64".to_string(),
                    )
                })?;
            if settlement_ph != expected_settlement_ph
                || settlement_amount.to_u64() != expected_settlement_amount
            {
                return Err(Error::Channel(
                    "offer settlement coin does not match contribution plus fee".to_string(),
                ));
            }
            if launcher_parent != settlement_coin.to_coin_id()
                || launcher_amount != self.my_contribution
            {
                return Err(Error::Channel(
                    "offer-funded launcher has invalid parent or amount".to_string(),
                ));
            }
        } else if launcher_amount.to_u64() != 0 {
            return Err(Error::Channel(
                "direct-funded launcher must have amount zero".to_string(),
            ));
        }

        let (channel_state, _init_result) = self.make_channel_state(
            launcher_coin.to_coin_id(),
            false,
            &info.second_player_hs_info,
            env,
        )?;
        let channel_coin = channel_state.channel_coin().clone();
        self.channel_state = Some(channel_state);
        self.launcher_coin = Some(launcher_coin.clone());
        self.opening_fee = opening_fee;
        self.offer_settlement_coin = offer_settlement_coin;
        self.state = InitiatorState::SentC(Box::new(info.clone()));

        Ok(vec![
            Effect::RegisterCoin {
                coin: channel_coin,
                timeout: Timeout::new(1_000_000),
                name: Some("channel"),
                spend: None,
                semantic: None,
            },
            Effect::PeerHandshakeC(HandshakePayloadC { launcher_coin }),
        ])
    }
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelEnv<'_>,
        wallet_bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        let bundle = if matches!(self.state, InitiatorState::WaitingForOffer(_, _)) {
            let mut request = self.build_alice_coin_spend_request()?;
            request.max_height = self.channel_deadline;
            if let Err(validation_error) =
                validate_wallet_bundle_applies_conditions(env.allocator, &wallet_bundle, &request)
            {
                self.wallet_offer_mismatches = self.wallet_offer_mismatches.saturating_add(1);
                if self.wallet_offer_mismatches >= MAX_WALLET_OFFER_MISMATCHES {
                    return Err(Error::Channel(format!(
                        "wallet failed to spend the committed launcher parent after \
                         {MAX_WALLET_OFFER_MISMATCHES} funding offers: {validation_error}"
                    )));
                }
                return Ok(vec![Effect::NeedCoinSpend(request)]);
            }
            if let Err(validation_error) =
                self.validate_offer_settlement_created(env.allocator, &wallet_bundle)
            {
                self.wallet_offer_mismatches = self.wallet_offer_mismatches.saturating_add(1);
                if self.wallet_offer_mismatches >= MAX_WALLET_OFFER_MISMATCHES {
                    return Err(Error::Channel(format!(
                        "wallet failed to create the committed settlement coin after \
                         {MAX_WALLET_OFFER_MISMATCHES} funding offers: {validation_error}"
                    )));
                }
                return Ok(vec![Effect::NeedCoinSpend(request)]);
            }
            let launcher_spend = self.build_launcher_coin_spend(env)?;
            let mut spends = if self.offer_settlement_coin.is_some() {
                wallet_bundle.spends
            } else {
                claim_settlement_coins(env.allocator, wallet_bundle).spends
            };
            if let Some(settlement_spend) = self.build_settlement_launcher_spend(env)? {
                spends.push(settlement_spend);
            }
            spends.push(launcher_spend);
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
            InitiatorState::WaitingForLauncher(_) | InitiatorState::SentC(_) => {
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
        // Surface the state channel coin once it's known so the host can show
        // its id in the unfolded data while the channel-creation transaction is
        // pending (the default returns none, the right answer only before any
        // coin exists).
        match self.channel_state.as_ref() {
            Some(ch) => vec![(CoinOfInterest::Channel, ch.channel_coin().clone())],
            None => vec![],
        }
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
    use crate::common::constants::{
        ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN_ANNOUNCEMENT, SINGLETON_LAUNCHER_HASH,
    };
    use crate::common::standard_coin::{
        private_to_public_key, sign_agg_sig_me, standard_solution_partial, ChiaIdentity,
    };
    use crate::common::types::{PrivateKey, Sha256Input, Sha256tree, ToQuotedProgram};
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
        let initiator_spend = spend_for_conditions(allocator, 1, create_conditions);
        let announcement = Sha256Input::Array(vec![
            Sha256Input::Bytes(initiator_spend.coin.to_coin_id().bytes()),
            Sha256Input::Bytes(message.bytes()),
        ])
        .hash();
        let assert_conditions = ((ASSERT_COIN_ANNOUNCEMENT, (announcement.clone(), ())), ())
            .to_clvm(allocator)
            .expect("assert announcement conditions");
        let receiver_spend = spend_for_conditions(allocator, 2, assert_conditions);
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

    fn waiting_for_offer_phase(
        allocator: &mut crate::common::types::AllocEncoder,
    ) -> (HandshakeInitiatorPhase, SpendBundle, SpendBundle, CoinID) {
        let wallet_identity = ChiaIdentity::new(
            allocator,
            PrivateKey::from_bytes(&[7; 32]).expect("wallet key"),
        )
        .expect("wallet identity");
        let wallet_coin = CoinString::from_parts(
            &CoinID::default(),
            &wallet_identity.puzzle_hash,
            &Amount::new(200),
        );
        let launcher_parent = wallet_coin.to_coin_id();
        let launcher_coin = CoinString::from_parts(
            &launcher_parent,
            &PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH),
            &Amount::default(),
        );

        let make_phase = |seed| {
            let mut rng = ChaCha8Rng::from_seed([seed; 32]);
            HandshakeInitiatorPhase::new(OffChainPhaseInit {
                private_keys: rng.random(),
                game_types: BTreeMap::new(),
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(5),
                unroll_timeout: Timeout::new(15),
                reward_puzzle_hash: PuzzleHash::from_bytes([seed; 32]),
            })
        };
        let mut phase = make_phase(20);
        let peer = make_phase(21);
        let first_player_hs_info = phase.my_handshake_b();
        let second_player_hs_info = peer.my_handshake_b();
        let mut env = ChannelEnv::new(allocator).expect("env");
        let (channel_state, _) = phase
            .make_channel_state(
                launcher_coin.to_coin_id(),
                false,
                &second_player_hs_info,
                &mut env,
            )
            .expect("channel state");
        phase.channel_state = Some(channel_state);
        phase.launcher_coin = Some(launcher_coin);
        phase.last_height = 10;
        phase.channel_deadline = phase.compute_not_valid_after_height();
        phase.state = InitiatorState::WaitingForOffer(
            Box::new(HandshakeStepInfo {
                first_player_hs_info,
                second_player_hs_info,
            }),
            StateUpdateSignatures::default(),
        );

        let request = phase
            .build_alice_coin_spend_request()
            .expect("funding request");
        let required_conditions =
            raw_coin_conditions_to_clvm(allocator, &request.conditions, request.max_height)
                .expect("required conditions")
                .to_clvm(allocator)
                .expect("condition list");
        let unrelated_conditions = (
            (
                crate::common::constants::CREATE_COIN,
                (PuzzleHash::from_bytes([9; 32]), (Amount::new(1), ())),
            ),
            (),
        )
            .to_clvm(allocator)
            .expect("unrelated conditions");
        let make_wallet_spend = |allocator: &mut AllocEncoder, conditions| {
            let spend = standard_solution_partial(
                allocator,
                &wallet_identity.synthetic_private_key,
                &wallet_coin.to_coin_id(),
                conditions,
                &wallet_identity.synthetic_public_key,
                &Hash::from_bytes(crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA),
                false,
            )
            .expect("wallet spend");
            CoinSpend {
                coin: wallet_coin.clone(),
                bundle: Spend {
                    puzzle: wallet_identity.puzzle.clone(),
                    solution: spend.solution,
                    signature: spend.signature,
                },
            }
        };
        let matching_spend = make_wallet_spend(allocator, required_conditions);
        let expected_without_conditions = make_wallet_spend(allocator, unrelated_conditions);
        let wrong_origin_conditions =
            raw_coin_conditions_to_clvm(allocator, &request.conditions, request.max_height)
                .expect("wrong-origin conditions")
                .to_clvm(allocator)
                .expect("wrong-origin condition list");
        let wrong_origin_spend = spend_for_conditions(allocator, 8, wrong_origin_conditions);

        (
            phase,
            SpendBundle {
                name: None,
                spends: vec![matching_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![expected_without_conditions, wrong_origin_spend],
            },
            launcher_parent,
        )
    }

    fn encode_f(bundle: SpendBundle) -> Vec<u8> {
        crate::session_phases::peer_wire::encode_peer_message(&PeerMessage::HandshakeF(
            HandshakePayloadF { bundle },
        ))
        .expect("encode F")
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
            .process_message(&mut env, Rc::new(PeerMessage::HandshakeB(payload)))
            .expect_err("HandshakeB collision");
        assert!(format!("{error:?}").contains("public key collision"));
    }

    #[test]
    fn wallet_funding_bundle_must_spend_launcher_parent_exactly_once() {
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

        validate_wallet_bundle_applies_conditions(
            &mut allocator,
            &SpendBundle {
                name: None,
                spends: vec![spend.clone()],
            },
            &request,
        )
        .expect("matching launcher parent");

        for spends in [vec![], vec![spend.clone(), spend]] {
            let error = validate_wallet_bundle_applies_conditions(
                &mut allocator,
                &SpendBundle { name: None, spends },
                &request,
            )
            .expect_err("missing or duplicate launcher parent must fail");
            assert!(format!("{error:?}").contains("expected exactly once"));
        }
    }

    #[test]
    fn wallet_offer_mismatch_retries_without_advancing_then_matching_offer_proceeds() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (mut phase, matching_bundle, wrong_origin_bundle, launcher_parent) =
            waiting_for_offer_phase(&mut allocator);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");

        let effects = phase
            .provide_coin_spend_bundle(&mut env, wrong_origin_bundle)
            .expect("mismatch should retry");
        let request = match effects.as_slice() {
            [Effect::NeedCoinSpend(request)] => request,
            _ => panic!("mismatch must emit one NeedCoinSpend"),
        };
        assert_eq!(request.coin_id.as_ref(), Some(&launcher_parent));
        assert_eq!(phase.wallet_offer_mismatches, 1);
        assert!(matches!(phase.state, InitiatorState::WaitingForOffer(_, _)));
        assert!(phase.channel_initiation_transaction.is_none());

        let effects = phase
            .provide_coin_spend_bundle(&mut env, matching_bundle)
            .expect("matching retry should proceed");
        assert!(matches!(effects.as_slice(), [Effect::PeerHandshakeE(_)]));
        assert!(matches!(phase.state, InitiatorState::Finished(_)));
        assert!(phase.channel_initiation_transaction.is_some());
    }

    #[test]
    fn offer_funding_routes_contribution_plus_fee_through_positive_launcher() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (mut phase, wallet_bundle, _, wallet_coin_id) = waiting_for_offer_phase(&mut allocator);
        let settlement_coin = CoinString::from_parts(
            &wallet_coin_id,
            &PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH),
            &Amount::new(110),
        );
        let launcher_coin = CoinString::from_parts(
            &settlement_coin.to_coin_id(),
            &PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH),
            &Amount::new(100),
        );
        phase.opening_fee = Amount::new(10);
        phase.offer_settlement_coin = Some(settlement_coin.clone());
        phase.launcher_coin = Some(launcher_coin.clone());
        phase
            .channel_state
            .as_mut()
            .expect("channel state")
            .set_launcher_coin_id(&launcher_coin.to_coin_id())
            .expect("set launcher id");

        let request = phase
            .build_alice_coin_spend_request()
            .expect("offer funding request");
        assert_eq!(request.amount, Amount::new(110));
        assert_eq!(request.fee, Amount::new(10));
        assert_eq!(request.coin_id.as_ref(), Some(&wallet_coin_id));
        assert!(request
            .conditions
            .iter()
            .any(|condition| condition.opcode
                == crate::common::constants::RESERVE_FEE_ATOM[0] as u32));
        assert!(!request
            .conditions
            .iter()
            .any(|condition| condition.opcode == crate::common::constants::CREATE_COIN));

        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let settlement_spend = phase
            .build_settlement_launcher_spend(&mut env)
            .expect("settlement spend")
            .expect("offer mode");
        assert_eq!(settlement_spend.coin, settlement_coin);
        let conditions = crate::common::types::CoinCondition::from_puzzle_and_solution(
            env.allocator,
            settlement_spend.bundle.puzzle.to_program().as_ref(),
            settlement_spend.bundle.solution.p().as_ref(),
        )
        .expect("settlement conditions");
        assert!(conditions.iter().any(|condition| {
            matches!(
                condition,
                crate::common::types::CoinCondition::CreateCoin(ph, amount)
                    if *ph == PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH)
                        && *amount == Amount::new(100)
            )
        }));

        let error = phase
            .validate_offer_settlement_created(env.allocator, &wallet_bundle)
            .expect_err("wallet bundle without committed settlement must fail");
        assert!(format!("{error:?}").contains("matching settlement coins"));

        let encoded = bencodex::to_vec(&phase).expect("serialize offer-funded phase");
        let restored: HandshakeInitiatorPhase =
            bencodex::from_slice(&encoded).expect("restore offer-funded phase");
        assert_eq!(restored.opening_fee, Amount::new(10));
        assert_eq!(
            restored.offer_settlement_coin.as_ref(),
            Some(&settlement_coin)
        );
        assert_eq!(restored.launcher_coin.as_ref(), Some(&launcher_coin));
    }

    #[test]
    fn wallet_offer_mismatch_exhaustion_fails_after_three_offers() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (mut phase, _, _, launcher_parent) = waiting_for_offer_phase(&mut allocator);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");

        for attempt in 1..=MAX_WALLET_OFFER_MISMATCHES {
            let result = phase.provide_coin_spend_bundle(
                &mut env,
                SpendBundle {
                    name: None,
                    spends: vec![],
                },
            );
            if attempt < MAX_WALLET_OFFER_MISMATCHES {
                let effects = result.expect("mismatch before limit should retry");
                let request = match effects.as_slice() {
                    [Effect::NeedCoinSpend(request)] => request,
                    _ => panic!("mismatch must emit one NeedCoinSpend"),
                };
                assert_eq!(request.coin_id.as_ref(), Some(&launcher_parent));
            } else {
                let error = result.expect_err("third mismatch must fail");
                assert!(format!("{error:?}").contains(
                    "wallet failed to spend the committed launcher parent after 3 funding offers"
                ));
            }
        }

        assert_eq!(phase.wallet_offer_mismatches, MAX_WALLET_OFFER_MISMATCHES);
        assert!(matches!(phase.state, InitiatorState::WaitingForOffer(_, _)));
        assert!(phase.channel_initiation_transaction.is_none());
    }

    #[test]
    fn finished_submits_only_the_first_independently_delivered_handshake_f() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (e_bundle, f_bundle, announcement) = announcement_bound_bundles(&mut allocator);
        let e_coin = e_bundle.spends[0].coin.clone();
        let f_coin = f_bundle.spends[0].coin.clone();
        let mut phase = finished_phase(e_bundle, announcement);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let encoded = encode_f(f_bundle);

        let first = phase
            .received_message(&mut env, encoded.clone())
            .expect("first F");
        let second = phase.received_message(&mut env, encoded).expect("second F");

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
    fn finished_rejects_handshake_f_that_echoes_initiator_coins() {
        let mut allocator = crate::common::types::AllocEncoder::new();
        let (e_bundle, mut f_bundle, announcement) = announcement_bound_bundles(&mut allocator);
        let mut echoed_spend = e_bundle.spends[0].clone();
        echoed_spend.bundle.signature = Aggsig::default();
        f_bundle.spends.push(echoed_spend);
        let mut phase = finished_phase(e_bundle, announcement);
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        let err = phase
            .received_message(&mut env, encode_f(f_bundle))
            .expect_err("echoed F");
        assert!(format!("{err:?}").contains("DoubleSpend"));
        assert!(!phase.transaction_pushed);
    }

    #[test]
    fn finished_rejects_handshake_f_without_launcher_announcement() {
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
            .received_message(&mut env, encode_f(f_bundle))
            .expect_err("silent F");
        assert!(format!("{err:?}").contains("does not assert the launcher announcement"));
        assert!(!phase.transaction_pushed);
    }
}
