use std::collections::{BTreeMap, HashMap, VecDeque};

use clvm_traits::ToClvm;

use log::debug;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk, read_hex_puzzle};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinString, Error, GameID, IntoErr, PrivateKey, PuzzleHash,
    Spend, SpendBundle, Timeout,
};
use crate::peer_container::{MessagePeerQueue, MessagePipe, WalletBootstrapState};
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameStart, GameType, PacketSender,
    PeerEnv, PeerMessage, PotatoHandlerInit, SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;

use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::standard_solution_partial;
use crate::common::types::CoinSpend;

use crate::tests::calpoker::test_moves_1;
use crate::tests::game::GameAction;

#[derive(Default)]
struct Pipe {
    message_pipe: MessagePipe,

    // WalletSpendInterface
    outgoing_transactions: VecDeque<SpendBundle>,
    registered_coins: HashMap<CoinString, Timeout>,

    // Opponent moves
    opponent_moves: Vec<(GameID, ReadableMove, Amount)>,
    opponent_raw_messages: Vec<(GameID, Vec<u8>)>,
    opponent_messages: Vec<(GameID, ReadableMove)>,
    our_moves: Vec<(GameID, Vec<u8>)>,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,

    // Have other side's offer
    unfunded_offer: Option<SpendBundle>,

    #[allow(dead_code)]
    bootstrap_state: Option<WalletBootstrapState>,
}

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
        debug!("Send Message from {} {msg:?}", self.my_id);
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.queue.push_back(msg_data);
        Ok(())
    }
}

impl PacketSender for Pipe {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        self.message_pipe.send_message(msg)
    }
}

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
        todo!();
    }
}

impl BootstrapTowardWallet for Pipe {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }

    fn received_channel_transaction_completion(
        &mut self,
        _bundle: &SpendBundle,
    ) -> Result<(), Error> {
        todo!();
    }
}

impl ToLocalUI for Pipe {
    fn self_move(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.our_moves.push((id.clone(), readable.to_vec()));
        Ok(())
    }

    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        mover_share: Amount,
    ) -> Result<(), Error> {
        self.opponent_moves
            .push((id.clone(), readable, mover_share));
        Ok(())
    }
    fn raw_game_message(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.opponent_raw_messages
            .push((id.clone(), readable.to_vec()));
        Ok(())
    }
    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error> {
        self.opponent_messages.push((id.clone(), readable));
        Ok(())
    }
    fn game_finished(&mut self, _id: &GameID, _my_share: Amount) -> Result<(), Error> {
        Ok(())
    }
    fn game_cancelled(&mut self, _id: &GameID) -> Result<(), Error> {
        todo!();
    }

    fn shutdown_complete(&mut self, _reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
        todo!();
    }
    fn going_on_chain(&mut self, _got_error: bool) -> Result<(), Error> {
        todo!();
    }
}

pub struct TestPeerEnv<'inputs, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    pub env: &'inputs mut ChannelHandlerEnv<'inputs, R>,

    pub system_interface: &'inputs mut G,
}

impl<'inputs, G, R> PeerEnv<'inputs, G, R> for TestPeerEnv<'inputs, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    fn env(&mut self) -> (&mut ChannelHandlerEnv<'inputs, R>, &mut G) {
        (self.env, self.system_interface)
    }
}

impl<'inputs, G, R> TestPeerEnv<'inputs, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    pub fn test_handle_received_channel_puzzle_hash(
        &mut self,
        peer: &mut PotatoHandler,
        parent: &CoinString,
        channel_handler_puzzle_hash: &PuzzleHash,
    ) -> Result<(), Error> {
        let standard_puzzle = self.env.standard_puzzle.clone();
        let ch = peer.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let channel_coin_amt = if let Some((_, _, amt)) = channel_coin.coin_string().to_parts() {
            amt
        } else {
            return Err(Error::StrErr("no channel coin".to_string()));
        };

        let public_key = private_to_public_key(&ch.channel_private_key());
        let conditions_clvm = [(
            CREATE_COIN,
            (channel_handler_puzzle_hash.clone(), (channel_coin_amt, ())),
        )]
        .to_clvm(self.env.allocator)
        .into_gen()?;
        let spend = standard_solution_partial(
            self.env.allocator,
            &ch.channel_private_key(),
            &parent.to_coin_id(),
            conditions_clvm,
            &public_key,
            &self.env.agg_sig_me_additional_data,
            false,
        )?;

        peer.channel_offer(
            self,
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
    }

    // XXX fund the offer when we hook up simulation.
    pub fn test_handle_received_unfunded_offer(
        &mut self,
        peer: &mut PotatoHandler,
        unfunded_offer: &SpendBundle,
    ) -> Result<(), Error> {
        peer.channel_transaction_completion(self, unfunded_offer)
    }
}

pub fn run_move<'a, P, R: Rng>(
    env: &'a mut ChannelHandlerEnv<'a, R>,
    _amount: Amount,
    pipe: &'a mut [P; 2],
    peer: &mut PotatoHandler,
    who: usize,
) -> Result<bool, Error>
where
    P: ToLocalUI
        + BootstrapTowardWallet
        + WalletSpendInterface
        + PacketSender
        + MessagePeerQueue
        + 'a,
{
    // assert!(pipe[who ^ 1].message_pipe().queue.len() < 2);
    let msg = if let Some(msg) = pipe[who ^ 1].message_pipe().queue.pop_front() {
        msg
    } else {
        return Ok(false);
    };

    let mut penv: TestPeerEnv<P, R> = TestPeerEnv {
        env,
        system_interface: &mut pipe[who],
    };

    peer.received_message(&mut penv, msg)?;

    Ok(true)
}

pub fn quiesce<'a, P, R: Rng + 'a>(
    rng: &'a mut R,
    allocator: &'a mut AllocEncoder,
    amount: Amount,
    peers: &'a mut [PotatoHandler; 2],
    pipes: &'a mut [P; 2],
) -> Result<(), Error>
where
    P: ToLocalUI
        + BootstrapTowardWallet
        + WalletSpendInterface
        + PacketSender
        + MessagePeerQueue
        + 'a,
{
    loop {
        let mut msgs = 0;
        for (who, peer) in peers.iter_mut().enumerate() {
            let mut env = channel_handler_env(allocator, rng)?;
            msgs += run_move(&mut env, amount.clone(), pipes, peer, who)? as usize;
        }
        if msgs == 0 {
            break;
        }
    }

    Ok(())
}

fn get_channel_coin_for_peer(p: &PotatoHandler) -> Result<CoinString, Error> {
    let channel_handler = p.channel_handler()?;
    Ok(channel_handler.state_channel_coin().coin_string().clone())
}

pub fn handshake<'a, P, R: Rng + 'a>(
    rng: &'a mut R,
    allocator: &'a mut AllocEncoder,
    amount: Amount,
    peers: &'a mut [PotatoHandler; 2],
    pipes: &'a mut [P; 2],
) -> Result<(), Error>
where
    P: ToLocalUI
        + BootstrapTowardWallet
        + WalletSpendInterface
        + PacketSender
        + MessagePeerQueue
        + 'a,
{
    let mut i = 0;

    while !peers[0].handshake_finished() || !peers[1].handshake_finished() {
        if i > 50 {
            panic!();
        }

        let who = i % 2;

        {
            let mut env = channel_handler_env(allocator, rng)?;
            run_move(&mut env, Amount::new(200), pipes, &mut peers[who], who).expect("should send");
        }

        i += 1;

        {
            let mut env = channel_handler_env(allocator, rng)?;
            let mut penv: TestPeerEnv<P, R> = TestPeerEnv {
                env: &mut env,
                system_interface: &mut pipes[who],
            };

            if let Some(ch) = penv.system_interface.get_channel_puzzle_hash() {
                let parent =
                    CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &amount);
                penv.test_handle_received_channel_puzzle_hash(&mut peers[who], &parent, &ch)?;
                penv.system_interface.set_channel_puzzle_hash(None);
            }

            if let Some(ufo) = penv.system_interface.get_unfunded_offer() {
                penv.test_handle_received_unfunded_offer(&mut peers[who], &ufo)?;
            }
        }

        if (10..12).contains(&i) {
            let mut env = channel_handler_env(allocator, rng)?;
            // Ensure that we notify about the channel coin (fake here, but the notification
            // is required).
            let channel_coin = get_channel_coin_for_peer(&peers[who])?;

            {
                let mut penv: TestPeerEnv<P, R> = TestPeerEnv {
                    env: &mut env,
                    system_interface: &mut pipes[who],
                };
                peers[who].coin_created(&mut penv, &channel_coin)?;
            }
        }
    }

    Ok(())
}

#[test]
#[ignore]
fn test_peer_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let mut pipe_sender: [Pipe; 2] = Default::default();
    pipe_sender[1].message_pipe.my_id = 1;

    let mut game_type_map = BTreeMap::new();
    let calpoker_factory = read_hex_puzzle(
        &mut allocator,
        "clsp/games/calpoker-v0/calpoker_include_calpoker_factory.hex",
    )
    .expect("should load");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        calpoker_factory.to_program(),
    );

    let new_peer = |allocator: &mut AllocEncoder, rng: &mut ChaCha8Rng, have_potato: bool| {
        let private_keys1: ChannelHandlerPrivateKeys = rng.gen();
        let reward_private_key1: PrivateKey = rng.gen();
        let reward_public_key1 = private_to_public_key(&reward_private_key1);
        let reward_puzzle_hash1 =
            puzzle_hash_for_pk(allocator, &reward_public_key1).expect("should work");

        PotatoHandler::new(PotatoHandlerInit {
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

    let p1 = new_peer(&mut allocator, &mut rng, true);
    let p2 = new_peer(&mut allocator, &mut rng, false);
    let mut peers = [p1, p2];

    {
        let mut env = channel_handler_env(&mut allocator, &mut rng).expect("should work");
        let mut penv = TestPeerEnv {
            env: &mut env,
            system_interface: &mut pipe_sender[0],
        };
        peers[0].start(&mut penv, parent_coin).expect("should work");
    };

    // Do handshake for peers.
    handshake(
        &mut rng,
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    quiesce(
        &mut rng,
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    // Start a game
    let game_ids = {
        let mut env = channel_handler_env(&mut allocator, &mut rng).expect("should work");
        let mut penv = TestPeerEnv {
            env: &mut env,
            system_interface: &mut pipe_sender[1],
        };

        let game_ids = peers[1]
            .start_games(
                &mut penv,
                true,
                &GameStart {
                    amount: Amount::new(200),
                    my_contribution: Amount::new(100),
                    game_type: GameType(b"calpoker".to_vec()),
                    timeout: Timeout::new(10),
                    my_turn: true,
                    parameters: vec![0x80],
                },
            )
            .expect("should run");

        peers[0]
            .start_games(
                &mut penv,
                false,
                &GameStart {
                    amount: Amount::new(200),
                    my_contribution: Amount::new(100),
                    game_type: GameType(b"calpoker".to_vec()),
                    timeout: Timeout::new(10),
                    my_turn: false,
                    parameters: vec![0x80],
                },
            )
            .expect("should run");

        game_ids
    };

    quiesce(
        &mut rng,
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    assert!(pipe_sender[0].message_pipe.queue.is_empty());
    assert!(pipe_sender[1].message_pipe.queue.is_empty());

    let moves = test_moves_1(&mut allocator);

    for this_move in moves.iter() {
        let (who, what) = if let GameAction::Move(who, what, _) = this_move {
            (who, what)
        } else {
            panic!();
        };

        {
            let entropy = rng.gen();
            let mut env = channel_handler_env(&mut allocator, &mut rng).expect("should work");
            let move_readable =
                ReadableMove::from_nodeptr(env.allocator, *what).expect("should work");
            let mut penv = TestPeerEnv {
                env: &mut env,
                system_interface: &mut pipe_sender[who ^ 1],
            };
            peers[who ^ 1]
                .make_move(&mut penv, &game_ids[0], &move_readable, entropy)
                .expect("should work");
        }

        quiesce(
            &mut rng,
            &mut allocator,
            Amount::new(200),
            &mut peers,
            &mut pipe_sender,
        )
        .expect("should work");
    }

    assert!(pipe_sender[0].message_pipe.queue.is_empty());
    assert!(pipe_sender[1].message_pipe.queue.is_empty());

    let have_potato = if peers[0].has_potato() { 0 } else { 1 };

    {
        let mut env = channel_handler_env(&mut allocator, &mut rng).expect("should work");
        let mut penv = TestPeerEnv {
            env: &mut env,
            system_interface: &mut pipe_sender[have_potato],
        };
        peers[have_potato]
            .accept(&mut penv, &game_ids[0])
            .expect("should work");
    }

    quiesce(
        &mut rng,
        &mut allocator,
        Amount::new(200),
        &mut peers,
        &mut pipe_sender,
    )
    .expect("should work");

    assert!(pipe_sender[0].message_pipe.queue.is_empty());
    assert!(pipe_sender[1].message_pipe.queue.is_empty());
}
