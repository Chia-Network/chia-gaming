#[cfg(test)]
use std::collections::{BTreeMap, HashMap, VecDeque};

use clvm_traits::ToClvm;

use crate::channel_state::types::ChannelEnv;
#[cfg(test)]
use crate::channel_state::types::{ChannelPrivateKeys, ReadableMove};
use crate::common::standard_coin::{private_to_public_key, ChiaIdentity};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinString, Error, IntoErr, PuzzleHash, Spend, SpendBundle,
};
#[cfg(test)]
use crate::common::types::{GameID, GameType, Hash, Node, PrivateKey, ProgramRef, Timeout};
#[cfg(test)]
use crate::game_session::{MessagePeerQueue, MessagePipe, PeerLifecyclePhase};
#[cfg(test)]
use crate::session_phases::effects::{
    apply_effects, ChannelStatusSnapshot, Effect, GameNotification,
};
#[cfg(test)]
use crate::session_phases::game_collection;
#[cfg(test)]
use crate::session_phases::handshake::raw_coin_conditions_to_clvm;
#[cfg(test)]
use crate::session_phases::handshake_initiator::HandshakeInitiatorPhase;
#[cfg(test)]
use crate::session_phases::handshake_receiver::HandshakeReceiverPhase;
#[cfg(test)]
use crate::session_phases::proposal::{GameProposal, ProposalParameters};
use crate::session_phases::types::{
    ChannelFundingWallet, PacketSender, PeerMessage, ToLocalUI, WalletSpendInterface,
};
#[cfg(test)]
use crate::session_phases::types::{FromLocalUI, OffChainPhaseInit};
use crate::session_phases::OffChainPhase;
use rand::Rng;
#[cfg(test)]
use rand::SeedableRng;
#[cfg(test)]
use rand_chacha::ChaCha8Rng;

use crate::common::constants::CREATE_COIN;
#[cfg(test)]
use crate::common::standard_coin::puzzle_hash_for_pk;
use crate::common::standard_coin::standard_solution_partial;
use crate::common::types::CoinSpend;

#[cfg(all(test, feature = "sim-tests"))]
use crate::test_support::calpoker_sim::prefix_test_moves;
#[cfg(all(test, feature = "sim-tests"))]
use crate::test_support::sim_script::{ScriptGameRef, SimScriptAction};

#[derive(Default)]
#[cfg(test)]
struct Pipe {
    message_pipe: MessagePipe,

    // WalletSpendInterface
    outgoing_transactions: VecDeque<SpendBundle>,
    registered_coins: HashMap<CoinString, Timeout>,

    // Opponent moves
    opponent_moves: Vec<(GameID, ReadableMove, Amount)>,
    opponent_messages: Vec<(GameID, ReadableMove)>,
    notifications: Vec<GameNotification>,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,

    // Have other side's offer
    unfunded_offer: Option<SpendBundle>,

    went_on_chain: Option<String>,
}

#[cfg(test)]
impl MessagePeerQueue for Pipe {
    fn message_pipe(&mut self) -> &mut MessagePipe {
        &mut self.message_pipe
    }
    fn get_channel_puzzle_hash(&self) -> Option<PuzzleHash> {
        self.channel_puzzle_hash.clone()
    }
    fn set_channel_puzzle_hash(&mut self, ph: Option<PuzzleHash>) {
        self.channel_puzzle_hash = ph;
    }
    fn get_unfunded_offer(&self) -> Option<SpendBundle> {
        self.unfunded_offer.clone()
    }
}

impl PacketSender for MessagePipe {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        let msg_data = crate::session_phases::peer_wire::encode_peer_message(msg)?;
        self.queue.push_back(msg_data);
        Ok(())
    }
}

#[cfg(test)]
impl PacketSender for Pipe {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        self.message_pipe.send_message(msg)
    }
}

#[cfg(test)]
impl WalletSpendInterface for Pipe {
    fn spend_transaction(
        &mut self,
        submission: &crate::session_phases::effects::TransactionSubmission,
    ) -> Result<(), Error> {
        self.outgoing_transactions
            .push_back(submission.bundle.clone());
        Ok(())
    }

    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        _name: Option<&'static str>,
        _spend: Option<crate::session_phases::effects::TransactionSubmission>,
        _semantic: Option<crate::session_phases::effects::TimeoutClaimSemantic>,
    ) -> Result<(), Error> {
        self.registered_coins
            .insert(coin_id.clone(), timeout.clone());

        Ok(())
    }

    fn request_puzzle_and_solution(&mut self, _coin_id: &CoinString) -> Result<(), Error> {
        Err(Error::StrErr(
            "request_puzzle_and_solution not expected in Pipe test helper".to_string(),
        ))
    }
}

#[cfg(test)]
impl ChannelFundingWallet for Pipe {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }
}

#[cfg(test)]
impl ToLocalUI for Pipe {
    fn notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        self.notifications.push(notification.clone());
        match notification {
            GameNotification::GameStatus {
                id,
                other_params: Some(params),
                ..
            } => {
                if let Some(readable) = params.readable.clone() {
                    if let Some(mover_share) = params.mover_share.clone() {
                        self.opponent_moves
                            .push((id.clone(), readable, mover_share));
                    } else {
                        self.opponent_messages.push((id.clone(), readable));
                    }
                }
            }
            GameNotification::ChannelStatus(ChannelStatusSnapshot {
                state, advisory, ..
            }) => {
                use crate::session_phases::effects::ChannelStatus;
                if matches!(
                    state,
                    ChannelStatus::GoingOnChain
                        | ChannelStatus::Unrolling
                        | ChannelStatus::ResolvedUnrolled
                        | ChannelStatus::ResolvedStale
                ) {
                    self.went_on_chain = Some(
                        advisory
                            .clone()
                            .unwrap_or_else(|| "going on-chain".to_string()),
                    );
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Helper for test handshake: build spend bundle and call peer.channel_offer.
pub fn test_handle_received_channel_puzzle_hash(
    env: &mut ChannelEnv<'_>,
    peer: &mut dyn PeerLifecyclePhase,
    parent: &CoinString,
    channel_handler_puzzle_hash: &PuzzleHash,
) -> Result<Vec<Effect>, Error> {
    let standard_puzzle = env.standard_puzzle.clone();
    let ch = peer.channel_state()?;
    let channel_coin = ch.channel_coin();
    let channel_coin_amt = if let Some((_, _, amt)) = channel_coin.to_parts() {
        amt
    } else {
        return Err(Error::StrErr("no channel coin".to_string()));
    };

    let public_key = private_to_public_key(&ch.channel_private_key());
    let conditions_clvm = [(
        CREATE_COIN,
        (channel_handler_puzzle_hash.clone(), (channel_coin_amt, ())),
    )]
    .to_clvm(env.allocator)
    .into_gen()?;
    let spend = standard_solution_partial(
        env.allocator,
        &ch.channel_private_key(),
        &parent.to_coin_id(),
        conditions_clvm,
        &public_key,
        &env.agg_sig_me_additional_data,
        false,
    )?;

    peer.channel_offer(
        env,
        SpendBundle {
            name: None,
            spends: vec![CoinSpend {
                coin: parent.clone(),
                bundle: Spend {
                    puzzle: standard_puzzle,
                    solution: spend.solution.clone(),
                    signature: spend.signature.clone(),
                },
            }],
        },
    )
    .map(|effect| effect.into_iter().collect::<Vec<_>>())
}

/// Helper for test handshake: call peer.channel_transaction_completion.
pub fn test_handle_received_unfunded_offer(
    env: &mut ChannelEnv<'_>,
    peer: &mut dyn PeerLifecyclePhase,
    unfunded_offer: &SpendBundle,
) -> Result<Vec<Effect>, Error> {
    peer.channel_transaction_completion(env, unfunded_offer)
        .map(|effect| effect.into_iter().collect::<Vec<_>>())
}

pub fn run_move<P>(
    allocator: &mut AllocEncoder,
    _amount: Amount,
    pipe: &mut [P; 2],
    peer: &mut OffChainPhase,
    who: usize,
) -> Result<bool, Error>
where
    P: ToLocalUI + ChannelFundingWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    let msg = if let Some(msg) = pipe[who ^ 1].message_pipe().queue.pop_front() {
        msg
    } else {
        return Ok(false);
    };

    let returned_effects = {
        let mut env = ChannelEnv::new(allocator)?;
        peer.received_message(&mut env, msg)?
    };

    apply_effects(returned_effects, allocator, &mut pipe[who])?;

    Ok(true)
}

#[cfg(test)]
const DUMMY_WALLET_COIN_AMOUNT: u64 = 200;

#[cfg(test)]
fn dummy_wallet_coin(
    allocator: &mut AllocEncoder,
    parent: &CoinID,
) -> Result<(CoinString, ChiaIdentity), Error> {
    let private_key = PrivateKey::from_bytes(&[3; 32]).expect("dummy wallet key");
    let identity = ChiaIdentity::new(allocator, private_key)?;
    let coin = CoinString::from_parts(
        parent,
        &identity.puzzle_hash,
        &Amount::new(DUMMY_WALLET_COIN_AMOUNT),
    );
    Ok((coin, identity))
}

#[cfg(test)]
fn build_dummy_wallet_bundle_for_request(
    allocator: &mut AllocEncoder,
    request: &crate::session_phases::handshake::CoinSpendRequest,
    player: usize,
) -> Result<SpendBundle, Error> {
    let parent = if request.coin_id.is_some() {
        CoinID::default()
    } else {
        CoinID::new(Hash::from_bytes([player as u8 + 1; 32]))
    };
    let (coin, identity) = dummy_wallet_coin(allocator, &parent)?;
    if let Some(expected_coin_id) = request.coin_id.as_ref() {
        game_assert_eq!(
            coin.to_coin_id(),
            *expected_coin_id,
            "dummy wallet selected a coin other than the requested coin"
        );
    }
    let direct_puzzle_hash = request
        .conditions
        .iter()
        .find(|condition| condition.opcode == crate::common::constants::RECEIVE_MESSAGE)
        .and_then(|condition| condition.args.get(2))
        .ok_or_else(|| Error::StrErr("dummy wallet request has no message source".to_string()))
        .and_then(|bytes| {
            Hash::from_slice(bytes)
                .map(PuzzleHash::from_hash)
                .map_err(|e| Error::StrErr(format!("dummy wallet message puzzle hash: {e:?}")))
        })?;
    let mut conditions = vec![Node(
        (
            CREATE_COIN,
            (direct_puzzle_hash, (request.amount.clone(), ())),
        )
            .to_clvm(allocator)
            .into_gen()?,
    )];
    conditions.extend(raw_coin_conditions_to_clvm(
        allocator,
        &request.conditions,
        request.max_height,
    )?);
    let conditions = conditions
        .to_clvm(allocator)
        .map_err(|e| Error::StrErr(format!("dummy wallet conditions: {e:?}")))?;
    let env = ChannelEnv::new(allocator)?;
    let spend = standard_solution_partial(
        env.allocator,
        &identity.synthetic_private_key,
        &coin.to_coin_id(),
        conditions,
        &identity.synthetic_public_key,
        &Hash::from_bytes(crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA),
        false,
    )?;
    Ok(SpendBundle {
        name: Some("dummy wallet coin spend request".to_string()),
        spends: vec![CoinSpend {
            coin,
            bundle: Spend {
                puzzle: identity.puzzle,
                solution: spend.solution,
                signature: spend.signature,
            },
        }],
    })
}

#[cfg(test)]
fn apply_effects_with_handshake_callbacks<P>(
    allocator: &mut AllocEncoder,
    handlers: &mut [Box<dyn PeerLifecyclePhase>; 2],
    pipes: &mut [P; 2],
    who: usize,
    effects: Vec<Effect>,
) -> Result<(), Error>
where
    P: ToLocalUI + ChannelFundingWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    let mut passthrough = Vec::new();
    let mut pending = VecDeque::from(effects);
    while let Some(effect) = pending.pop_front() {
        match effect {
            Effect::NeedCoinSpend(req) => {
                let bundle = build_dummy_wallet_bundle_for_request(allocator, &req, who)?;
                let mut env = ChannelEnv::new(allocator)?;
                let follow_up = handlers[who].provide_coin_spend_bundle(&mut env, bundle)?;
                pending.extend(follow_up);
            }
            other => passthrough.push(other),
        }
    }
    apply_effects(passthrough, allocator, &mut pipes[who])?;
    Ok(())
}

pub fn quiesce<P>(
    allocator: &mut AllocEncoder,
    amount: Amount,
    peers: &mut [OffChainPhase; 2],
    pipes: &mut [P; 2],
) -> Result<(), Error>
where
    P: ToLocalUI + ChannelFundingWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    loop {
        let mut activity = 0;
        for (who, peer) in peers.iter_mut().enumerate() {
            activity += run_move(allocator, amount.clone(), pipes, peer, who)? as usize;
        }
        for (who, peer) in peers.iter_mut().enumerate() {
            let effects = {
                let mut env = ChannelEnv::new(allocator)?;
                peer.flush_pending_actions(&mut env)?
            };
            if !effects.is_empty() {
                activity += 1;
                apply_effects(effects, allocator, &mut pipes[who])?;
            }
        }
        if activity == 0 {
            break;
        }
    }

    Ok(())
}

#[cfg(test)]
fn get_channel_coin_for_handler(p: &dyn PeerLifecyclePhase) -> Result<CoinString, Error> {
    let channel_state = p.channel_state()?;
    Ok(channel_state.channel_coin().clone())
}

#[cfg(test)]
fn extract_off_chain_phase(peer: &mut Box<dyn PeerLifecyclePhase>) -> Option<OffChainPhase> {
    peer.take_off_chain_phase_for_testing()
}

#[cfg(test)]
pub fn do_handshake<P>(
    allocator: &mut AllocEncoder,
    amount: Amount,
    handlers: &mut [Box<dyn PeerLifecyclePhase>; 2],
    pipes: &mut [P; 2],
) -> Result<[OffChainPhase; 2], Error>
where
    P: ToLocalUI + ChannelFundingWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    for handler in handlers.iter_mut() {
        let effects = {
            let mut env = ChannelEnv::new(allocator)?;
            handler.new_block(&mut env, 1)?
        };
        if !effects.is_empty() {
            return Err(Error::StrErr(
                "unexpected effects from initial new_block".to_string(),
            ));
        }
    }

    let mut completed: [Option<OffChainPhase>; 2] = [None, None];
    for _ in 0..100 {
        for who in 0..2 {
            if let Some(msg) = pipes[who ^ 1].message_pipe().queue.pop_front() {
                let effects = {
                    let mut env = ChannelEnv::new(allocator)?;
                    handlers[who].received_message(&mut env, msg)?
                };
                apply_effects_with_handshake_callbacks(allocator, handlers, pipes, who, effects)?;
            }

            {
                let mut immediate_effects = Vec::new();
                let mut env = ChannelEnv::new(allocator)?;

                if let Some(ch) = pipes[who].get_channel_puzzle_hash() {
                    let parent =
                        CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &amount);
                    let effects = test_handle_received_channel_puzzle_hash(
                        &mut env,
                        &mut *handlers[who],
                        &parent,
                        &ch,
                    )?;
                    immediate_effects.extend(effects);
                    pipes[who].set_channel_puzzle_hash(None);
                }

                if let Some(ufo) = pipes[who].get_unfunded_offer() {
                    let effects =
                        test_handle_received_unfunded_offer(&mut env, &mut *handlers[who], &ufo)?;
                    immediate_effects.extend(effects);
                }
                drop(env);
                apply_effects_with_handshake_callbacks(
                    allocator,
                    handlers,
                    pipes,
                    who,
                    immediate_effects,
                )?;
            }

            {
                if let Ok(channel_coin) = get_channel_coin_for_handler(&*handlers[who]) {
                    let effects = {
                        let mut env = ChannelEnv::new(allocator)?;
                        handlers[who].coin_created(&mut env, &channel_coin)?
                    };
                    if let Some(effects) = effects {
                        apply_effects_with_handshake_callbacks(
                            allocator, handlers, pipes, who, effects,
                        )?;
                    }
                }
            }
        }

        for who in 0..2 {
            if completed[who].is_none() {
                completed[who] = extract_off_chain_phase(&mut handlers[who]);
            }
        }
        if completed.iter().all(Option::is_some) {
            return Ok([
                completed[0]
                    .take()
                    .expect("first completed off-chain phase retained"),
                completed[1]
                    .take()
                    .expect("second completed off-chain phase retained"),
            ]);
        }
    }

    Err(Error::StrErr(format!(
        "handshake did not complete (retained off-chain phases: first={}, second={})",
        completed[0].is_some(),
        completed[1].is_some(),
    )))
}

#[cfg(test)]
fn new_test_handshake_handler(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    game_types: &BTreeMap<GameType, ProgramRef>,
    is_initiator: bool,
) -> Box<dyn PeerLifecyclePhase> {
    let channel_key = rng.random();
    let unroll_key = rng.random();
    let referee_key: PrivateKey = rng.random();
    let mut pre_launcher_rng = ChaCha8Rng::from_seed(referee_key.bytes());
    let private_keys = ChannelPrivateKeys {
        my_channel_coin_private_key: channel_key,
        my_unroll_coin_private_key: unroll_key,
        my_referee_private_key: referee_key,
        my_pre_launcher_private_key: pre_launcher_rng.random(),
    };
    let reward_private_key: PrivateKey = rng.random();
    let reward_public_key = private_to_public_key(&reward_private_key);
    let reward_puzzle_hash =
        puzzle_hash_for_pk(allocator, &reward_public_key).expect("reward puzzle hash");

    let init = OffChainPhaseInit {
        private_keys,
        game_types: game_types.clone(),
        my_contribution: Amount::new(100),
        their_contribution: Amount::new(100),
        channel_timeout: Timeout::new(1000),
        unroll_timeout: Timeout::new(15),
        reward_puzzle_hash,
    };
    if is_initiator {
        Box::new(HandshakeInitiatorPhase::new(init))
    } else {
        Box::new(HandshakeReceiverPhase::new(init))
    }
}

pub fn test_peer_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let mut pipe_sender: [Pipe; 2] = Default::default();
    pipe_sender[1].message_pipe.my_id = 1;

    let game_type_map = game_collection(&mut allocator);

    // Keep RNG draws stable for deterministic test vectors.
    let _parent_private_key: PrivateKey = rng.random();
    let _parent_public_key = private_to_public_key(&_parent_private_key);
    let _parent_puzzle_hash =
        puzzle_hash_for_pk(&mut allocator, &_parent_public_key).expect("should work");
    let _parent_coin_id = CoinID::default();
    let _parent_coin =
        CoinString::from_parts(&_parent_coin_id, &_parent_puzzle_hash, &Amount::new(200));

    let h1 = new_test_handshake_handler(&mut allocator, &mut rng, &game_type_map, true);
    let h2 = new_test_handshake_handler(&mut allocator, &mut rng, &game_type_map, false);
    let mut handlers = [h1, h2];

    {
        let start_effect = {
            let mut env = ChannelEnv::new(&mut allocator).expect("should work");
            handlers[0]
                .start_handshake(&mut env, Amount::default())
                .expect("should work")
        };
        apply_effects(
            start_effect.into_iter().collect(),
            &mut allocator,
            &mut pipe_sender[0],
        )
        .expect("should work");
    }

    let mut peers = do_handshake(
        &mut allocator,
        Amount::new(200),
        &mut handlers,
        &mut pipe_sender,
    )
    .expect("handshake should complete");

    let rollback_probe = GameProposal {
        sender_is_player_a: true,
        game_type: game_collection::game_type_for_package(&mut allocator, "calpoker"),
        timeout: Timeout::new(15),
        parameters: ProposalParameters::Integer(100),
    };
    for peer in &mut peers {
        let mut env = ChannelEnv::new(&mut allocator).expect("channel environment");
        peer.assert_invalid_clean_shutdown_rollback_for_testing(&mut env, &rollback_probe);
    }

    peers[0].queue_stale_game_action_for_testing(GameID(999));
    let request_potato =
        crate::session_phases::peer_wire::encode_peer_message(&PeerMessage::RequestPotato(()))
            .expect("encode potato request");
    let effects = {
        let mut env = ChannelEnv::new(&mut allocator).expect("channel environment");
        peers[1]
            .received_message(&mut env, request_potato)
            .expect("valid potato request")
    };
    apply_effects(effects, &mut allocator, &mut pipe_sender[1])
        .expect("send valid empty peer batch");
    quiesce(
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");
    assert!(
        pipe_sender[0].notifications.iter().any(|notification| {
            matches!(
                notification,
                GameNotification::ActionFailed {
                    id: Some(GameID(999)),
                    ..
                }
            )
        }),
        "valid peer batch should commit and reconcile the stale local game action"
    );
    assert!(
        pipe_sender[0].went_on_chain.is_none(),
        "peer 0 went on chain after handshake: {:?}",
        pipe_sender[0].went_on_chain
    );
    assert!(
        pipe_sender[1].went_on_chain.is_none(),
        "peer 1 went on chain after handshake: {:?}",
        pipe_sender[1].went_on_chain
    );

    let proposal_id = {
        let (proposal_id, effects1) = {
            let calpoker_type = game_collection::game_type_for_package(&mut allocator, "calpoker");
            let mut env = ChannelEnv::new(&mut allocator).expect("should work");
            let (proposal_id, effects1) = FromLocalUI::propose(
                &mut peers[1],
                &mut env,
                &GameProposal {
                    sender_is_player_a: true,
                    game_type: calpoker_type,
                    timeout: Timeout::new(15),
                    parameters: ProposalParameters::Integer(100),
                },
            )
            .expect("should run");
            (proposal_id, effects1)
        };
        apply_effects(effects1, &mut allocator, &mut pipe_sender[1]).expect("should work");

        proposal_id
    };

    quiesce(
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    {
        let effects0 = {
            let mut env = ChannelEnv::new(&mut allocator).expect("should work");
            FromLocalUI::accept_proposal(&mut peers[0], &mut env, &proposal_id)
                .expect("should accept")
        };
        apply_effects(effects0, &mut allocator, &mut pipe_sender[0]).expect("should work");
    }

    quiesce(
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    assert!(
        pipe_sender[0].went_on_chain.is_none(),
        "peer 0 went on chain after game start: {:?}",
        pipe_sender[0].went_on_chain
    );
    assert!(
        pipe_sender[1].went_on_chain.is_none(),
        "peer 1 went on chain after game start: {:?}",
        pipe_sender[1].went_on_chain
    );
    assert!(pipe_sender[0].message_pipe.queue.is_empty());
    assert!(pipe_sender[1].message_pipe.queue.is_empty());

    #[cfg(feature = "sim-tests")]
    {
        let moves = prefix_test_moves(&mut allocator, ScriptGameRef::accepted(0, 0));

        for this_move in moves.iter() {
            let (who, what) = if let SimScriptAction::Move(who, _, what, _) = this_move {
                (*who, what.clone())
            } else {
                panic!();
            };

            {
                let entropy = rng.random();
                let mut env = ChannelEnv::new(&mut allocator).expect("should work");
                let effects = FromLocalUI::make_move(
                    &mut peers[who ^ 1],
                    &mut env,
                    &GameID(0),
                    &what,
                    entropy,
                )
                .expect("should work");
                apply_effects(effects, &mut allocator, &mut pipe_sender[who ^ 1])
                    .expect("should work");
            }

            quiesce(
                &mut allocator,
                Amount::new(200),
                &mut peers,
                &mut pipe_sender,
            )
            .expect("should work");
        }

        assert!(
            pipe_sender[0].went_on_chain.is_none(),
            "peer 0 went on chain after moves: {:?}",
            pipe_sender[0].went_on_chain
        );
        assert!(
            pipe_sender[1].went_on_chain.is_none(),
            "peer 1 went on chain after moves: {:?}",
            pipe_sender[1].went_on_chain
        );
        assert!(pipe_sender[0].message_pipe.queue.is_empty());
        assert!(pipe_sender[1].message_pipe.queue.is_empty());
    }
}

fn prepare_receiver_for_handshake_c(
    seed: [u8; 32],
) -> (
    AllocEncoder,
    [Box<dyn PeerLifecyclePhase>; 2],
    [Pipe; 2],
    Vec<u8>,
) {
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let mut pipes: [Pipe; 2] = Default::default();
    pipes[1].message_pipe.my_id = 1;
    let game_types = game_collection(&mut allocator);
    let mut handlers = [
        new_test_handshake_handler(&mut allocator, &mut rng, &game_types, true),
        new_test_handshake_handler(&mut allocator, &mut rng, &game_types, false),
    ];

    for handler in &mut handlers {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handler.new_block(&mut env, 1).expect("initial height");
    }
    let start_effect = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[0]
            .start_handshake(&mut env, Amount::default())
            .expect("start handshake")
    };
    apply_effects(
        start_effect.into_iter().collect(),
        &mut allocator,
        &mut pipes[0],
    )
    .expect("send handshake A");

    let handshake_a = pipes[0]
        .message_pipe
        .queue
        .pop_front()
        .expect("handshake A");
    let receiver_effects = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[1]
            .received_message(&mut env, handshake_a)
            .expect("receive handshake A")
    };
    apply_effects_with_handshake_callbacks(
        &mut allocator,
        &mut handlers,
        &mut pipes,
        1,
        receiver_effects,
    )
    .expect("complete receiver funding");

    let handshake_b = pipes[1]
        .message_pipe
        .queue
        .pop_front()
        .expect("handshake B");
    let initiator_effects = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[0]
            .received_message(&mut env, handshake_b)
            .expect("receive handshake B")
    };
    apply_effects_with_handshake_callbacks(
        &mut allocator,
        &mut handlers,
        &mut pipes,
        0,
        initiator_effects,
    )
    .expect("complete initiator funding");

    let valid_c = pipes[0]
        .message_pipe
        .queue
        .pop_front()
        .expect("handshake C");

    (allocator, handlers, pipes, valid_c)
}

pub fn test_receiver_handshake_c_is_atomic() {
    let (mut allocator, mut handlers, mut pipes, valid_c) =
        prepare_receiver_for_handshake_c([23; 32]);
    let mut invalid_c =
        crate::session_phases::peer_wire::decode_peer_message(&valid_c).expect("decode C");
    match &mut invalid_c {
        PeerMessage::HandshakeC(payload) => {
            let signed_spend = payload
                .bundle
                .spends
                .iter_mut()
                .find(|spend| !spend.bundle.signature.is_twos_complement_zero())
                .expect("handshake C aggregate signature");
            signed_spend.bundle.signature = Default::default();
            assert!(!payload.bundle.spends.is_empty());
        }
        other => panic!("expected handshake C, got {other:?}"),
    }
    let invalid_c = crate::session_phases::peer_wire::encode_peer_message(&invalid_c)
        .expect("encode invalid C");

    let before = bencodex::to_vec(&handlers[1]).expect("serialize receiver before C");
    let error = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[1]
            .received_message(&mut env, invalid_c)
            .expect_err("invalid funding signature must be rejected")
    };
    assert!(format!("{error:?}").contains("aggregate signature"));
    let after = bencodex::to_vec(&handlers[1]).expect("serialize receiver after invalid C");
    assert_eq!(
        after, before,
        "rejected handshake C must not mutate receiver phase state"
    );

    let valid_effects = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[1]
            .received_message(&mut env, valid_c)
            .expect("valid handshake C retry")
    };
    assert!(
        valid_effects
            .iter()
            .any(|effect| matches!(effect, Effect::SendPeer(PeerMessage::HandshakeD(_)))),
        "valid retry must send handshake D"
    );
    assert!(
        valid_effects.iter().any(|effect| matches!(
            effect,
            Effect::SpendTransaction(submission)
                if submission.fee_policy
                    == crate::session_phases::effects::FeePolicy::AlreadyPaid
        )),
        "valid retry must submit the already-paid funding transaction"
    );
    apply_effects(valid_effects, &mut allocator, &mut pipes[1])
        .expect("apply valid handshake C effects");
    assert_eq!(pipes[1].message_pipe.queue.len(), 1);
    assert_eq!(pipes[1].outgoing_transactions.len(), 1);
}

pub fn test_receiver_handshake_c_genesis_signature_failure_is_atomic() {
    let (mut allocator, mut handlers, mut pipes, valid_c) =
        prepare_receiver_for_handshake_c([24; 32]);
    let valid_message =
        crate::session_phases::peer_wire::decode_peer_message(&valid_c).expect("decode valid C");
    let mut invalid_message = valid_message.clone();
    match (&valid_message, &mut invalid_message) {
        (PeerMessage::HandshakeC(valid), PeerMessage::HandshakeC(invalid)) => {
            invalid.signatures.unroll_preempt_half_sig = Default::default();
            assert_eq!(
                invalid.bundle, valid.bundle,
                "signature corruption must leave the funding bundle intact"
            );
            assert_ne!(
                invalid.signatures, valid.signatures,
                "invalid C must change only the state-one signatures"
            );
        }
        (other, _) => panic!("expected handshake C, got {other:?}"),
    }
    let invalid_c = crate::session_phases::peer_wire::encode_peer_message(&invalid_message)
        .expect("encode invalid C");

    let before = bencodex::to_vec(&handlers[1]).expect("serialize receiver before invalid C");
    let error = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[1]
            .received_message(&mut env, invalid_c)
            .expect_err("invalid state-one signature must be rejected")
    };
    let error = format!("{error:?}");
    assert!(
        error.contains("receiver step C: genesis initialization failed"),
        "error must identify receiver genesis initialization: {error}"
    );
    assert!(
        error.contains("bad unroll signature verify"),
        "error must identify state-one signature verification: {error}"
    );
    let after =
        bencodex::to_vec(&handlers[1]).expect("serialize receiver after rejected invalid C");
    assert_eq!(
        after, before,
        "genesis signature failure must not mutate receiver phase state"
    );

    let valid_effects = {
        let mut env = ChannelEnv::new(&mut allocator).expect("env");
        handlers[1]
            .received_message(&mut env, valid_c)
            .expect("valid handshake C retry")
    };
    assert!(
        valid_effects
            .iter()
            .any(|effect| matches!(effect, Effect::SendPeer(PeerMessage::HandshakeD(_)))),
        "valid retry must send handshake D"
    );
    assert!(
        valid_effects.iter().any(|effect| matches!(
            effect,
            Effect::SpendTransaction(submission)
                if submission.fee_policy
                    == crate::session_phases::effects::FeePolicy::AlreadyPaid
        )),
        "valid retry must submit the already-paid funding transaction"
    );
    apply_effects(valid_effects, &mut allocator, &mut pipes[1])
        .expect("apply valid handshake C effects");
    assert_eq!(pipes[1].message_pipe.queue.len(), 1);
    assert_eq!(pipes[1].outgoing_transactions.len(), 1);
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_peer_smoke", &test_peer_smoke),
        (
            "test_receiver_handshake_c_is_atomic",
            &test_receiver_handshake_c_is_atomic,
        ),
        (
            "test_receiver_handshake_c_genesis_signature_failure_is_atomic",
            &test_receiver_handshake_c_genesis_signature_failure_is_atomic,
        ),
    ]
}
