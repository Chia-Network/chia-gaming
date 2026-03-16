#[cfg(test)]
use std::collections::{HashMap, VecDeque};

use clvm_traits::ToClvm;

use crate::channel_handler::types::ChannelHandlerEnv;
#[cfg(test)]
use crate::channel_handler::types::{ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::standard_coin::private_to_public_key;
#[cfg(test)]
use crate::common::types::GameType;
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinString, Error, IntoErr, PuzzleHash, Spend, SpendBundle,
};
#[cfg(test)]
use crate::common::types::{GameID, PrivateKey, Program, Timeout};
#[cfg(test)]
use crate::games::poker_collection;
#[cfg(test)]
use crate::peer_container::{MessagePeerQueue, MessagePipe, PeerHandler};
use crate::potato_handler::effects::{apply_effects, Effect, GameNotification};
#[cfg(test)]
use crate::potato_handler::handshake_handler::HandshakeHandler;
#[cfg(test)]
use crate::potato_handler::start::GameStart;
use crate::potato_handler::types::{
    BootstrapTowardWallet, PacketSender, PeerMessage, ToLocalUI, WalletSpendInterface,
};
#[cfg(test)]
use crate::potato_handler::types::{FromLocalUI, PotatoHandlerInit};
use crate::potato_handler::PotatoHandler;
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

#[cfg(test)]
use crate::test_support::calpoker::prefix_test_moves;
#[cfg(test)]
use crate::test_support::game::GameAction;

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
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
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
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.outgoing_transactions.push_back(bundle.clone());
        Ok(())
    }

    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        _name: Option<&'static str>,
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
impl BootstrapTowardWallet for Pipe {
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
        match notification {
            GameNotification::OpponentMoved {
                id,
                readable,
                mover_share,
                ..
            } => {
                self.opponent_moves
                    .push((id.clone(), readable.clone(), mover_share.clone()));
            }
            GameNotification::GameMessage { id, readable } => {
                self.opponent_messages.push((id.clone(), readable.clone()));
            }
            GameNotification::GoingOnChain { reason } => {
                self.went_on_chain = Some(reason.clone());
            }
            _ => {}
        }
        Ok(())
    }
}

/// Helper for test handshake: build spend bundle and call peer.channel_offer.
pub fn test_handle_received_channel_puzzle_hash(
    env: &mut ChannelHandlerEnv<'_>,
    peer: &mut dyn PeerHandler,
    parent: &CoinString,
    channel_handler_puzzle_hash: &PuzzleHash,
) -> Result<Vec<Effect>, Error> {
    let standard_puzzle = env.standard_puzzle.clone();
    let ch = peer.channel_handler()?;
    let channel_coin = ch.state_channel_coin();
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
    env: &mut ChannelHandlerEnv<'_>,
    peer: &mut dyn PeerHandler,
    unfunded_offer: &SpendBundle,
) -> Result<Vec<Effect>, Error> {
    peer.channel_transaction_completion(env, unfunded_offer)
        .map(|effect| effect.into_iter().collect::<Vec<_>>())
}

pub fn run_move<P>(
    allocator: &mut AllocEncoder,
    _amount: Amount,
    pipe: &mut [P; 2],
    peer: &mut PotatoHandler,
    who: usize,
) -> Result<bool, Error>
where
    P: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    let msg = if let Some(msg) = pipe[who ^ 1].message_pipe().queue.pop_front() {
        msg
    } else {
        return Ok(false);
    };

    let returned_effects = {
        let mut env = ChannelHandlerEnv::new(allocator)?;
        peer.received_message(&mut env, msg)?
    };

    apply_effects(returned_effects, allocator, &mut pipe[who])?;

    Ok(true)
}

pub fn quiesce<P>(
    allocator: &mut AllocEncoder,
    amount: Amount,
    peers: &mut [PotatoHandler; 2],
    pipes: &mut [P; 2],
) -> Result<(), Error>
where
    P: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    loop {
        let mut activity = 0;
        for (who, peer) in peers.iter_mut().enumerate() {
            activity += run_move(allocator, amount.clone(), pipes, peer, who)? as usize;
        }
        for (who, peer) in peers.iter_mut().enumerate() {
            let effects = {
                let mut env = ChannelHandlerEnv::new(allocator)?;
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
fn get_channel_coin_for_handler(p: &dyn PeerHandler) -> Result<CoinString, Error> {
    let channel_handler = p.channel_handler()?;
    Ok(channel_handler.state_channel_coin().clone())
}

#[cfg(test)]
pub fn handshake<P>(
    allocator: &mut AllocEncoder,
    amount: Amount,
    handlers: &mut [HandshakeHandler; 2],
    pipes: &mut [P; 2],
) -> Result<[PotatoHandler; 2], Error>
where
    P: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    let mut i = 0;
    let mut done = [false; 2];

    while !done[0] || !done[1] {
        if i > 50 {
            panic!("handshake did not complete in 50 iterations");
        }

        let who = i % 2;

        if let Some(msg) = pipes[who ^ 1].message_pipe().queue.pop_front() {
            let effects = {
                let mut env = ChannelHandlerEnv::new(allocator)?;
                handlers[who].received_message(&mut env, msg)?
            };
            apply_effects(effects, allocator, &mut pipes[who])?;
        }

        i += 1;

        {
            let mut immediate_effects = Vec::new();
            let mut env = ChannelHandlerEnv::new(allocator)?;

            if let Some(ch) = pipes[who].get_channel_puzzle_hash() {
                let parent =
                    CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &amount);
                let effects = test_handle_received_channel_puzzle_hash(
                    &mut env,
                    &mut handlers[who],
                    &parent,
                    &ch,
                )?;
                immediate_effects.extend(effects);
                pipes[who].set_channel_puzzle_hash(None);
            }

            if let Some(ufo) = pipes[who].get_unfunded_offer() {
                let effects =
                    test_handle_received_unfunded_offer(&mut env, &mut handlers[who], &ufo)?;
                immediate_effects.extend(effects);
            }
            drop(env);
            apply_effects(immediate_effects, allocator, &mut pipes[who])?;
        }

        if i >= 10 {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            if let Ok(channel_coin) = get_channel_coin_for_handler(&handlers[who]) {
                let effects = PeerHandler::coin_created(&mut handlers[who], &mut env, &channel_coin)?;
                if let Some(effects) = effects {
                    apply_effects(effects, allocator, &mut pipes[who])?;
                }
            }
        }

        if handlers[who].take_replacement().is_some() {
            done[who] = true;
        }
    }

    unreachable!("restructured below")
}

// The issue with the above is that take_replacement consumes the replacement.
// Let me restructure: run the handshake, then extract replacements at the end.

#[cfg(test)]
pub fn do_handshake<P>(
    allocator: &mut AllocEncoder,
    amount: Amount,
    handlers: &mut [HandshakeHandler; 2],
    pipes: &mut [P; 2],
) -> Result<[PotatoHandler; 2], Error>
where
    P: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + MessagePeerQueue,
{
    for _ in 0..100 {
        for who in 0..2 {
            if let Some(msg) = pipes[who ^ 1].message_pipe().queue.pop_front() {
                let effects = {
                    let mut env = ChannelHandlerEnv::new(allocator)?;
                    handlers[who].received_message(&mut env, msg)?
                };
                apply_effects(effects, allocator, &mut pipes[who])?;
            }

            {
                let mut immediate_effects = Vec::new();
                let mut env = ChannelHandlerEnv::new(allocator)?;

                if let Some(ch) = pipes[who].get_channel_puzzle_hash() {
                    let parent = CoinString::from_parts(
                        &CoinID::default(),
                        &PuzzleHash::default(),
                        &amount,
                    );
                    let effects = test_handle_received_channel_puzzle_hash(
                        &mut env,
                        &mut handlers[who],
                        &parent,
                        &ch,
                    )?;
                    immediate_effects.extend(effects);
                    pipes[who].set_channel_puzzle_hash(None);
                }

                if let Some(ufo) = pipes[who].get_unfunded_offer() {
                    let effects = test_handle_received_unfunded_offer(
                        &mut env,
                        &mut handlers[who],
                        &ufo,
                    )?;
                    immediate_effects.extend(effects);
                }
                drop(env);
                apply_effects(immediate_effects, allocator, &mut pipes[who])?;
            }

            {
                let mut env = ChannelHandlerEnv::new(allocator)?;
                if let Ok(channel_coin) = get_channel_coin_for_handler(&handlers[who]) {
                    let effects = PeerHandler::coin_created(&mut handlers[who], &mut env, &channel_coin)?;
                    if let Some(effects) = effects {
                        apply_effects(effects, allocator, &mut pipes[who])?;
                    }
                }
            }
        }

        let r0 = handlers[0].take_potato_handler();
        let r1 = handlers[1].take_potato_handler();
        if let (Some(p0), Some(p1)) = (r0, r1) {
            return Ok([p0, p1]);
        }
    }

    Err(Error::StrErr("handshake did not complete".to_string()))
}

pub fn test_peer_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let mut pipe_sender: [Pipe; 2] = Default::default();
    pipe_sender[1].message_pipe.my_id = 1;

    let game_type_map = poker_collection(&mut allocator);

    let new_handler =
        |allocator: &mut AllocEncoder, rng: &mut ChaCha8Rng, have_potato: bool| {
            let private_keys1: ChannelHandlerPrivateKeys = rng.gen();
            let reward_private_key1: PrivateKey = rng.gen();
            let reward_public_key1 = private_to_public_key(&reward_private_key1);
            let reward_puzzle_hash1 =
                puzzle_hash_for_pk(allocator, &reward_public_key1).expect("should work");

            HandshakeHandler::new(PotatoHandlerInit {
                have_potato,
                private_keys: private_keys1,
                game_types: game_type_map.clone(),
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(1000),
                unroll_timeout: Timeout::new(5),
                reward_puzzle_hash: reward_puzzle_hash1.clone(),
            })
        };

    let parent_private_key: PrivateKey = rng.gen();
    let parent_public_key = private_to_public_key(&parent_private_key);
    let parent_puzzle_hash =
        puzzle_hash_for_pk(&mut allocator, &parent_public_key).expect("should work");

    let parent_coin_id = CoinID::default();
    let parent_coin =
        CoinString::from_parts(&parent_coin_id, &parent_puzzle_hash, &Amount::new(200));

    let h1 = new_handler(&mut allocator, &mut rng, true);
    let h2 = new_handler(&mut allocator, &mut rng, false);
    let mut handlers = [h1, h2];

    {
        let start_effect = {
            let mut env = ChannelHandlerEnv::new(&mut allocator).expect("should work");
            handlers[0]
                .start(&mut env, parent_coin)
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

    quiesce(
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");
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

    let game_ids = {
        let (game_ids, effects1) = {
            let mut env = ChannelHandlerEnv::new(&mut allocator).expect("should work");

            let nil = Program::from_hex("80").unwrap();
            let game_id = peers[1].next_game_id().unwrap();
            let (game_ids, effects1) = FromLocalUI::propose_game(
                &mut peers[1],
                    &mut env,
                    &GameStart {
                        game_id: game_id.clone(),
                        amount: Amount::new(200),
                        my_contribution: Amount::new(100),
                        game_type: GameType(b"ca1poker".to_vec()),
                        timeout: Timeout::new(10),
                        my_turn: true,
                        parameters: nil,
                    },
                )
                .expect("should run");
            (game_ids, effects1)
        };
        apply_effects(effects1, &mut allocator, &mut pipe_sender[1]).expect("should work");

        game_ids
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
            let mut env = ChannelHandlerEnv::new(&mut allocator).expect("should work");
            FromLocalUI::accept_proposal(&mut peers[0], &mut env, &game_ids[0])
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

    let moves = prefix_test_moves(&mut allocator, GameID(0));

    for this_move in moves.iter() {
        let (who, what) = if let GameAction::Move(who, _, what, _) = this_move {
            (*who, what.clone())
        } else {
            panic!();
        };

        {
            let entropy = rng.gen();
            let mut env = ChannelHandlerEnv::new(&mut allocator).expect("should work");
            let effects = FromLocalUI::make_move(&mut peers[who ^ 1], &mut env, &game_ids[0], &what, entropy)
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

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![("test_peer_smoke", &test_peer_smoke)]
}
