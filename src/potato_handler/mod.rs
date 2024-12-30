use std::collections::{BTreeMap, VecDeque};

use clvm_traits::ToClvm;
use clvmr::serde::node_from_bytes;
use clvmr::{run_program, Allocator, NodePtr};

use log::debug;
use rand::Rng;

use crate::channel_handler::game_handler::chia_dialect;
use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerInitiationData, ChannelHandlerPrivateKeys,
    FlatGameStartInfo, GameStartInfo, PotatoSignatures, PrintableGameStartInfo, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinString, Error, GameID, Hash, IntoErr, Node, Program,
    PuzzleHash, Sha256Input, SpendBundle, Timeout,
};
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameAction, GameStart,
    GameStartQueueEntry, GameType, HandshakeA, HandshakeB, HandshakeState, HandshakeStepInfo,
    HandshakeStepWithSpend, MyGameStartQueueEntry, PacketSender, PeerEnv, PeerMessage, PotatoState,
    SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};

use clvm_tools_rs::classic::clvm::sexp::proper_list;
pub mod types;

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
#[allow(dead_code)]
pub struct PotatoHandler {
    initiator: bool,
    have_potato: PotatoState,

    handshake_state: HandshakeState,

    // Waiting game starts at the peer level.
    their_start_queue: VecDeque<GameStartQueueEntry>,
    // Our outgoing game starts.
    my_start_queue: VecDeque<MyGameStartQueueEntry>,

    game_action_queue: VecDeque<GameAction>,

    next_game_id: Vec<u8>,

    channel_handler: Option<ChannelHandler>,
    channel_initiation_transaction: Option<SpendBundle>,
    channel_finished_transaction: Option<SpendBundle>,

    game_types: BTreeMap<GameType, Program>,

    private_keys: ChannelHandlerPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    waiting_to_start: bool,
    channel_timeout: Timeout,
}

fn init_game_id(private_keys: &ChannelHandlerPrivateKeys) -> Vec<u8> {
    Sha256Input::Array(vec![
        Sha256Input::Bytes(&private_keys.my_channel_coin_private_key.bytes()),
        Sha256Input::Bytes(&private_keys.my_unroll_coin_private_key.bytes()),
        Sha256Input::Bytes(&private_keys.my_referee_private_key.bytes()),
    ])
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
    pub fn new(
        have_potato: bool,
        private_keys: ChannelHandlerPrivateKeys,
        game_types: BTreeMap<GameType, Program>,
        my_contribution: Amount,
        their_contribution: Amount,
        channel_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
    ) -> PotatoHandler {
        PotatoHandler {
            initiator: have_potato,
            have_potato: if have_potato {
                PotatoState::Present
            } else {
                PotatoState::Absent
            },
            handshake_state: if have_potato {
                HandshakeState::StepA
            } else {
                HandshakeState::StepB
            },

            next_game_id: Vec::new(),
            game_types,

            their_start_queue: VecDeque::default(),
            my_start_queue: VecDeque::default(),
            game_action_queue: VecDeque::default(),

            channel_handler: None,
            channel_initiation_transaction: None,
            channel_finished_transaction: None,

            waiting_to_start: true,

            private_keys,
            my_contribution,
            their_contribution,
            channel_timeout,
            reward_puzzle_hash,
        }
    }

    pub fn amount(&self) -> Amount {
        self.my_contribution.clone() + self.their_contribution.clone()
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        if let Some(ch) = &self.channel_handler {
            Ok(ch)
        } else {
            Err(Error::StrErr("no channel handler".to_string()))
        }
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        if let Some(ch) = &mut self.channel_handler {
            Ok(ch)
        } else {
            Err(Error::StrErr("no channel handler".to_string()))
        }
    }

    pub fn handshake_finished(&self) -> bool {
        matches!(self.handshake_state, HandshakeState::Finished(_))
    }

    /// Tell whether this peer has the potato.  If it has been sent but not received yet
    /// then both will say false
    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn start<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &'a mut dyn PeerEnv<'a, G, R>,
        parent_coin: CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    {
        let (env, system_interface) = penv.env();
        let channel_public_key =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;

        debug!("Start: our channel public key {:?}", channel_public_key);

        assert!(matches!(self.handshake_state, HandshakeState::StepA));
        let my_hs_info = HandshakeA {
            parent: parent_coin.clone(),
            simple: HandshakeB {
                channel_public_key,
                unroll_public_key,
                reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                referee_puzzle_hash,
            },
        };
        self.handshake_state =
            HandshakeState::StepC(parent_coin.clone(), Box::new(my_hs_info.clone()));
        system_interface.send_message(&PeerMessage::HandshakeA(my_hs_info))?;

        Ok(())
    }

    fn update_channel_coin_after_receive<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        _spend: &ChannelCoinSpendInfo,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        self.have_potato = PotatoState::Present;

        if self.have_potato_start_game(penv)? {
            return Ok(());
        }

        if self.have_potato_move(penv)? {
            return Ok(());
        }

        Ok(())
    }

    fn pass_on_channel_handler_message<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        msg: Vec<u8>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let ch = self.channel_handler_mut()?;

        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;

        debug!("msg {msg_envelope:?}");
        match msg_envelope {
            PeerMessage::Nil(n) => {
                debug!("about to receive empty potato");
                let spend_info = {
                    let (env, _system_interface) = penv.env();
                    ch.received_empty_potato(env, &n)?
                };
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Move(game_id, m) => {
                let (spend_info, readable_move, message) = {
                    let (env, _) = penv.env();
                    ch.received_potato_move(env, &game_id, &m)?
                };
                {
                    let (_, system_interface) = penv.env();
                    system_interface
                        .opponent_moved(&game_id, ReadableMove::from_nodeptr(readable_move))?;
                    if !message.is_empty() {
                        system_interface.send_message(&PeerMessage::Message(game_id, message))?;
                    }
                }
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let (env, _) = penv.env();
                    ch.received_message(env, &game_id, &message)?
                };

                let (_, system_interface) = penv.env();
                system_interface.raw_game_message(&game_id, &message)?;
                system_interface.game_message(&game_id, decoded_message)?;
                // Does not affect potato.
            }
            PeerMessage::Accept(game_id, amount, sigs) => {
                let spend_info = {
                    let (env, system_interface) = penv.env();
                    let result = ch.received_potato_accept(env, &sigs, &game_id)?;
                    system_interface.game_finished(&game_id, amount)?;
                    Ok(result)
                }?;
                self.update_channel_coin_after_receive(penv, &spend_info)?;
            }
            _ => {
                todo!("unhandled passthrough message {msg_envelope:?}");
            }
        }

        Ok(())
    }

    pub fn try_complete_step_e<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let Some(spend) = self.channel_initiation_transaction.as_ref() {
            self.handshake_state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend: spend.clone(),
            }));

            // Outer layer already knows the launcher coin string.
            //
            // Provide the channel puzzle hash to the full node bootstrap and
            // it replies with the channel puzzle hash
            {
                let (_env, system_interface) = penv.env();
                system_interface.send_message(&PeerMessage::HandshakeE {
                    bundle: spend.clone(),
                })?;
            }
        }

        Ok(())
    }

    pub fn try_complete_step_f<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        first_player_hs_info: HandshakeA,
        second_player_hs_info: HandshakeB,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        // Haven't got the channel coin yet.
        if self.waiting_to_start {
            debug!("waiting to start");
            return Ok(());
        }

        if let Some(spend) = self.channel_finished_transaction.as_ref() {
            self.handshake_state = HandshakeState::Finished(Box::new(HandshakeStepWithSpend {
                info: HandshakeStepInfo {
                    first_player_hs_info,
                    second_player_hs_info,
                },
                spend: spend.clone(),
            }));

            // Outer layer already knows the launcher coin string.
            //
            // Provide the channel puzzle hash to the full node bootstrap and
            // it replies with the channel puzzle hash
            {
                let (_env, system_interface) = penv.env();
                system_interface.send_message(&PeerMessage::HandshakeF {
                    bundle: spend.clone(),
                })?;
            }
        }

        Ok(())
    }

    // We have the potato so we can send a message that starts a game if there are games
    // to start.
    //
    // This returns bool so that it can be put into the receive potato pipeline so we
    // can automatically send new game starts on the next potato receive.
    fn have_potato_start_game<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if let Some(desc) = self.my_start_queue.pop_front() {
            let mut dehydrated_games = Vec::new();

            let sigs = {
                let ch = self.channel_handler_mut()?;
                let (env, _) = penv.env();
                for game in desc.their_games.iter() {
                    dehydrated_games.push(game.to_serializable(env.allocator)?);
                }
                for game in desc.my_games.iter() {
                    debug!(
                        "using game {:?}",
                        PrintableGameStartInfo {
                            allocator: env.allocator.allocator(),
                            info: game
                        }
                    );
                }
                ch.send_potato_start_game(env, &desc.my_games)?
            };

            debug!("dehydrated_games {dehydrated_games:?}");
            let (_, system_interface) = penv.env();
            system_interface.send_message(&PeerMessage::StartGames(sigs, dehydrated_games))?;
            return Ok(true);
        }

        Ok(false)
    }

    fn have_potato_move<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        match self.game_action_queue.pop_front() {
            Some(GameAction::Move(game_id, readable_move, new_entropy)) => {
                let move_result = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    ch.send_potato_move(env, &game_id, &readable_move, new_entropy)?
                };

                let (_, system_interface) = penv.env();
                system_interface.self_move(&game_id, &move_result.game_move.basic.move_made)?;

                system_interface.send_message(&PeerMessage::Move(game_id, move_result))?;
                self.have_potato = PotatoState::Absent;

                Ok(true)
            }
            Some(GameAction::Accept(game_id)) => {
                let (sigs, amount) = {
                    let ch = self.channel_handler_mut()?;
                    let (env, _) = penv.env();
                    ch.send_potato_accept(env, &game_id)?
                };

                let (_, system_interface) = penv.env();
                system_interface.send_message(&PeerMessage::Accept(
                    game_id.clone(),
                    amount.clone(),
                    sigs,
                ))?;
                system_interface.game_finished(&game_id, amount)?;
                self.have_potato = PotatoState::Absent;

                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn get_games_by_start_type<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        game_start: &GameStart,
    ) -> Result<(Vec<GameStartInfo>, Vec<GameStartInfo>), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let starter = if let Some(starter) = self.game_types.get(&game_start.game_type) {
            starter
        } else {
            return Err(Error::StrErr(format!(
                "no such game {:?}",
                game_start.game_type
            )));
        };

        let (env, _) = penv.env();
        let starter_clvm = starter.to_clvm(env.allocator).into_gen()?;
        let params_clvm =
            node_from_bytes(env.allocator.allocator(), &game_start.parameters).into_gen()?;
        let program_run_args = (
            game_start.amount.clone(),
            (game_start.my_contribution.clone(), (Node(params_clvm), ())),
        )
            .to_clvm(env.allocator)
            .into_gen()?;

        let program_output = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            starter_clvm,
            program_run_args,
            0,
        )
        .into_gen()?
        .1;

        let to_list =
            |allocator: &mut Allocator, node: NodePtr, err: &str| -> Result<Vec<NodePtr>, Error> {
                if let Some(p) = proper_list(allocator, node, true) {
                    Ok(p)
                } else {
                    Err(Error::StrErr(format!("bad factory output: {err}")))
                }
            };

        // The result is two parallel lists of opposite sides of game starts.
        // Well re-glue these together into a list of pairs.
        let pair_of_output_lists = to_list(
            env.allocator.allocator(),
            program_output,
            "not a pair of lists",
        )?;

        if pair_of_output_lists.len() != 2 {
            return Err(Error::StrErr("output wasn't a list of 2 items".to_string()));
        }

        let my_info_list = to_list(
            env.allocator.allocator(),
            pair_of_output_lists[0],
            "not a list (first)",
        )?;
        let their_info_list = to_list(
            env.allocator.allocator(),
            pair_of_output_lists[1],
            "not a list (second)",
        )?;

        if their_info_list.len() != my_info_list.len() {
            return Err(Error::StrErr(
                "mismatched my and their game starts".to_string(),
            ));
        }

        let mut game_ids = Vec::new();
        for _ in my_info_list.iter() {
            game_ids.push(self.next_game_id()?);
        }

        let convert_info_list = |allocator: &mut AllocEncoder,
                                 my_turn: bool,
                                 my_info_list: &[NodePtr]|
         -> Result<Vec<GameStartInfo>, Error> {
            let mut result_start_info = Vec::new();
            for (i, node) in my_info_list.iter().enumerate() {
                let new_game = GameStartInfo::from_clvm(allocator, my_turn, *node)?;
                // Timeout and game_id are supplied here.
                result_start_info.push(GameStartInfo {
                    game_id: game_ids[i].clone(),
                    timeout: game_start.timeout.clone(),
                    ..new_game
                });
            }
            Ok(result_start_info)
        };

        let my_result_start_info = convert_info_list(env.allocator, true, &my_info_list)?;
        let their_result_start_info = convert_info_list(env.allocator, false, &their_info_list)?;

        Ok((my_result_start_info, their_result_start_info))
    }

    fn request_potato<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if matches!(self.have_potato, PotatoState::Requested) {
            return Ok(());
        }

        debug!("requesting potato");

        let (_, system_interface) = penv.env();
        system_interface.send_message(&PeerMessage::RequestPotato(()))?;
        self.have_potato = PotatoState::Requested;
        Ok(())
    }

    fn next_game_id(&mut self) -> Result<GameID, Error> {
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

    fn received_game_start<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        sigs: &PotatoSignatures,
        games: &[FlatGameStartInfo],
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        // We must have received a peer layer message indicating that we're waiting for this
        // game start.
        if self.their_start_queue.pop_front().is_none() {
            return Err(Error::StrErr("no waiting games to start".to_string()));
        };

        let ch = self.channel_handler_mut()?;
        let spend_info = {
            let (env, _system_interface) = penv.env();
            let mut rehydrated_games = Vec::new();
            for game in games.iter() {
                let new_rehydrated_game = GameStartInfo::from_serializable(env.allocator, game)?;
                let re_dehydrated = new_rehydrated_game.to_serializable(env.allocator)?;
                assert_eq!(&re_dehydrated, game);
                debug!(
                    "their game {:?}",
                    PrintableGameStartInfo {
                        allocator: env.allocator.allocator(),
                        info: &new_rehydrated_game
                    }
                );
                rehydrated_games.push(new_rehydrated_game);
            }
            ch.received_potato_start_game(env, sigs, &rehydrated_games)?
        };

        self.update_channel_coin_after_receive(penv, &spend_info)?;

        Ok(())
    }

    pub fn received_message<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        msg: Vec<u8>,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;

        let make_channel_handler_initiation =
            |parent: CoinID, start_potato, msg: &HandshakeB| ChannelHandlerInitiationData {
                launcher_coin_id: parent,
                we_start_with_potato: start_potato,
                their_channel_pubkey: msg.channel_public_key.clone(),
                their_unroll_pubkey: msg.unroll_public_key.clone(),
                their_referee_puzzle_hash: msg.referee_puzzle_hash.clone(),
                my_contribution: self.my_contribution.clone(),
                their_contribution: self.their_contribution.clone(),
            };

        match &self.handshake_state {
            // non potato progression
            HandshakeState::StepA => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                debug!(
                    "StepA: their channel public key {:?}",
                    msg.simple.channel_public_key
                );

                todo!();
            }

            HandshakeState::StepC(parent_coin, handshake_a) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeB(msg) = msg_envelope {
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
                let init_data =
                    make_channel_handler_initiation(parent_coin.to_coin_id(), false, &msg);
                let (mut channel_handler, _init_result) = {
                    let (env, _system_interface) = penv.env();
                    ChannelHandler::new(env, self.private_keys.clone(), &init_data)?
                };

                let channel_coin = channel_handler.state_channel_coin();
                let channel_puzzle_hash =
                    if let Some((_, puzzle_hash, _)) = channel_coin.coin_string().to_parts() {
                        puzzle_hash
                    } else {
                        return Err(Error::StrErr(
                            "could not understand channel coin parts".to_string(),
                        ));
                    };

                // Send the boostrap wallet interface the channel puzzle hash to use.
                // it will reply at some point with the channel offer.
                {
                    let (_env, system_interface) = penv.env();
                    system_interface.channel_puzzle_hash(&channel_puzzle_hash)?;
                    system_interface
                        .register_coin(channel_coin.coin_string(), &self.channel_timeout)?;
                };

                let channel_public_key =
                    private_to_public_key(&self.private_keys.my_channel_coin_private_key);
                let unroll_public_key =
                    private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash = {
                    let (env, _system_interface) = penv.env();
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?
                };

                let our_handshake_data = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                {
                    let (env, system_interface) = penv.env();
                    let nil_msg = channel_handler.send_empty_potato(env)?;
                    system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                }

                self.next_game_id = init_game_id(&self.private_keys);
                self.channel_handler = Some(channel_handler);

                self.handshake_state = HandshakeState::StepE(Box::new(HandshakeStepInfo {
                    first_player_hs_info: *handshake_a.clone(),
                    second_player_hs_info: our_handshake_data.clone(),
                }));
            }

            HandshakeState::StepE(info) => {
                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepE(info.clone());

                self.pass_on_channel_handler_message(penv, msg)?;

                self.try_complete_step_e(penv, first_player_hs, second_player_hs)?;
            }

            // potato progression
            HandshakeState::StepB => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let msg = if let PeerMessage::HandshakeA(msg) = msg_envelope {
                    msg
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake a message, got {msg_envelope:?}"
                    )));
                };

                let init_data =
                    make_channel_handler_initiation(msg.parent.to_coin_id(), true, &msg.simple);
                let (channel_handler, _init_result) = {
                    let (env, _system_interface) = penv.env();
                    ChannelHandler::new(env, self.private_keys.clone(), &init_data)?
                };

                let channel_public_key =
                    private_to_public_key(&channel_handler.channel_private_key());
                let unroll_public_key =
                    private_to_public_key(&channel_handler.unroll_private_key());
                let referee_public_key =
                    private_to_public_key(&self.private_keys.my_referee_private_key);
                let referee_puzzle_hash = {
                    let (env, _system_interface) = penv.env();
                    puzzle_hash_for_pk(env.allocator, &referee_public_key)?
                };

                let my_hs_info = HandshakeB {
                    channel_public_key,
                    unroll_public_key,
                    reward_puzzle_hash: self.reward_puzzle_hash.clone(),
                    referee_puzzle_hash,
                };

                self.next_game_id = init_game_id(&self.private_keys);
                self.channel_handler = Some(channel_handler);
                self.handshake_state = HandshakeState::StepD(Box::new(HandshakeStepInfo {
                    first_player_hs_info: msg.clone(),
                    second_player_hs_info: my_hs_info.clone(),
                }));

                {
                    let (_env, system_interface) = penv.env();
                    system_interface.send_message(&PeerMessage::HandshakeB(my_hs_info))?;
                }
            }

            HandshakeState::StepD(info) => {
                self.handshake_state = HandshakeState::StepF(info.clone());

                self.pass_on_channel_handler_message(penv, msg)?;

                let ch = self.channel_handler_mut()?;
                {
                    let (env, system_interface) = penv.env();
                    let nil_msg = ch.send_empty_potato(env)?;
                    system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                }
            }

            HandshakeState::StepF(info) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
                let bundle = if let PeerMessage::HandshakeE { bundle } = msg_envelope {
                    bundle
                } else {
                    return Err(Error::StrErr(format!(
                        "Expected handshake e message, got {msg_envelope:?}"
                    )));
                };

                let channel_coin = {
                    let ch = self.channel_handler()?;
                    ch.state_channel_coin()
                };

                debug!("PH: channel_coin {:?}", channel_coin.coin_string());

                {
                    let (_env, system_interface) = penv.env();
                    if bundle.spends.is_empty() {
                        return Err(Error::StrErr(
                            "No spends to draw the channel coin from".to_string(),
                        ));
                    }

                    // Ensure we're watching for this coin.
                    system_interface
                        .register_coin(channel_coin.coin_string(), &self.channel_timeout)?;

                    system_interface.received_channel_offer(&bundle)?;
                }

                let first_player_hs = info.first_player_hs_info.clone();
                let second_player_hs = info.second_player_hs_info.clone();

                self.handshake_state = HandshakeState::PostStepF(info.clone());

                self.have_potato = PotatoState::Absent;
                self.try_complete_step_f(penv, first_player_hs, second_player_hs)?;
            }

            HandshakeState::Finished(_) => {
                let msg_envelope: PeerMessage =
                    bson::from_bson(bson::Bson::Document(doc)).into_gen()?;

                debug!("running: got message {:?}", msg_envelope);

                match msg_envelope {
                    PeerMessage::HandshakeF { bundle } => {
                        self.channel_finished_transaction = Some(bundle.clone());
                        let (_, system_interface) = penv.env();
                        system_interface.received_channel_offer(&bundle)?;
                    }
                    PeerMessage::RequestPotato(_) => {
                        {
                            let (env, system_interface) = penv.env();
                            let ch = self.channel_handler_mut()?;
                            let nil_msg = ch.send_empty_potato(env)?;
                            system_interface.send_message(&PeerMessage::Nil(nil_msg))?;
                        }
                        self.have_potato = PotatoState::Absent;
                    }
                    PeerMessage::StartGames(sigs, g) => {
                        self.received_game_start(penv, &sigs, &g)?;
                    }
                    _ => {
                        self.pass_on_channel_handler_message(penv, msg)?;
                    }
                }

                return Ok(());
            }

            _ => {
                return Err(Error::StrErr(format!(
                    "should not receive message in state {:?}",
                    self.handshake_state
                )));
            }
        }

        Ok(())
    }

    fn do_game_action<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        action: GameAction,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(
                "move without finishing handshake".to_string(),
            ));
        }

        self.game_action_queue.push_back(action);

        if !matches!(self.have_potato, PotatoState::Present) {
            self.request_potato(penv)?;
            return Ok(());
        }

        self.have_potato_move(penv)?;

        Ok(())
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    FromLocalUI<G, R> for PotatoHandler
{
    fn start_games<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        R: 'a,
    {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(format!(
                "start games without finishing handshake: {:?}",
                self.handshake_state
            )));
        }

        let (my_games, their_games) = self.get_games_by_start_type(penv, game)?;

        let game_id_list = my_games.iter().map(|g| g.game_id.clone()).collect();

        // This comes to both peers before any game start happens.
        // In the didn't initiate scenario, we hang onto the game start to ensure that
        // we know what we're receiving from the remote end.
        if i_initiated {
            self.my_start_queue.push_back(MyGameStartQueueEntry {
                my_games,
                their_games,
            });

            if !matches!(self.have_potato, PotatoState::Present) {
                self.request_potato(penv)?;
                return Ok(game_id_list);
            }

            self.have_potato_start_game(penv)?;
        } else {
            // All checking needed is done by channel handler.
            self.their_start_queue.push_back(GameStartQueueEntry);
        }

        Ok(game_id_list)
    }

    fn make_move<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        self.do_game_action(
            penv,
            GameAction::Move(id.clone(), readable.clone(), new_entropy),
        )
    }

    fn accept<'a>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>, id: &GameID) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        self.do_game_action(penv, GameAction::Accept(id.clone()))
    }

    fn shut_down(&mut self) -> Result<(), Error> {
        if !matches!(self.handshake_state, HandshakeState::Finished(_)) {
            return Err(Error::StrErr(
                "shut_down without finishing handshake".to_string(),
            ));
        }

        todo!();
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    BootstrapTowardGame<G, R> for PotatoHandler
{
    fn channel_offer<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a,
    {
        self.channel_initiation_transaction = Some(bundle);

        debug!("channel offer: {:?}", self.handshake_state);
        if let HandshakeState::PostStepE(info) = &self.handshake_state {
            self.try_complete_step_e(
                penv,
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
        }

        Ok(())
    }

    fn channel_transaction_completion<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: &SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a,
    {
        self.channel_finished_transaction = Some(bundle.clone());

        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            self.try_complete_step_f(
                penv,
                info.first_player_hs_info.clone(),
                info.second_player_hs_info.clone(),
            )?;
        }

        Ok(())
    }
}

impl<G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender, R: Rng>
    SpendWalletReceiver<G, R> for PotatoHandler
{
    fn coin_created<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        // When the channel coin is created, we know we can proceed in playing the game.
        if let HandshakeState::PostStepF(info) = &self.handshake_state {
            let channel_coin_created = self
                .channel_handler()
                .ok()
                .map(|ch| ch.state_channel_coin().coin_string());

            debug!("checking created coin {coin:?} vs expected {channel_coin_created:?}");
            if let Some(_coin) = channel_coin_created {
                self.waiting_to_start = false;
                self.try_complete_step_f(
                    penv,
                    info.first_player_hs_info.clone(),
                    info.second_player_hs_info.clone(),
                )?;
            }
        }

        Ok(())
    }

    fn coin_spent<'a>(
        &mut self,
        _penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        if let Some(ch) = self.channel_handler.as_ref() {
            let channel_coin = ch.state_channel_coin();
            if coin_id == channel_coin.coin_string() {
                // Channel coin was spent so we're going on chain.
                todo!();
            }
        }

        Ok(())
    }

    fn coin_timeout_reached<'a>(
        &mut self,
        _penv: &mut dyn PeerEnv<'a, G, R>,
        _coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a,
    {
        todo!();
    }
}
