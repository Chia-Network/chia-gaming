use crate::common::types::Timeout;
use lazy_static::lazy_static;

lazy_static! {
    pub static ref DEFAULT_UNROLL_TIME_LOCK: Timeout = Timeout::new(15);
}

#[cfg(test)]
use crate::channel_state::types::ReadableMove;

// In unit tests (without the `sim-tests` feature), we only need `Timeout` and `Move`.
#[cfg(all(test, not(feature = "sim-tests")))]
#[derive(Clone)]
pub enum SimScriptAction {
    /// Do a timeout
    Timeout(usize),
    /// Move (player, game_id, clvm readable move, was received)
    Move(usize, crate::common::types::GameID, ReadableMove, bool),
}

#[cfg(all(test, not(feature = "sim-tests")))]
impl std::fmt::Debug for SimScriptAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            SimScriptAction::Timeout(t) => write!(formatter, "Timeout({t})"),
            SimScriptAction::Move(p, g, n, r) => write!(formatter, "Move({p},{g:?},{n:?},{r})"),
        }
    }
}

#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::channel_state::game::FactoryGame;
    use crate::channel_state::game_start_info::GameStartInfo;
    use crate::channel_state::runner::ChannelHandlerParty;
    use crate::channel_state::types::{
        ChannelCoinSpendInfo, ChannelEnv, ChannelPrivateKeys, HandshakeResult,
    };
    use crate::common::standard_coin::{
        private_to_public_key, puzzle_for_pk, puzzle_hash_for_synthetic_public_key,
        sign_reward_payout, ChiaIdentity,
    };
    use crate::common::types::{
        Aggsig, Amount, CoinID, CoinString, Error, GameID, Hash, Program, PublicKey, Puzzle,
        PuzzleHash, Sha256tree,
    };
    use crate::simulator::Simulator;

    use rand::prelude::*;
    use std::rc::Rc;

    pub struct ChannelHandlerGame {
        pub game_id: GameID,
        pub players: [ChannelHandlerParty; 2],
        pub handshake_result: [Option<HandshakeResult>; 2],
    }

    impl ChannelHandlerGame {
        pub fn new<R: Rng>(
            rng: &mut R,
            env: &mut ChannelEnv<'_>,
            game_id: GameID,
            launcher_coin_id: &CoinID,
            contributions: &[Amount; 2],
            unroll_advance_timeout: Timeout,
        ) -> Result<ChannelHandlerGame, Error> {
            let private_keys: [ChannelPrivateKeys; 2] = rng.random();

            let make_ref_info =
                |env: &mut ChannelEnv<'_>,
                 id: usize|
                 -> Result<(Rc<Puzzle>, PuzzleHash, PublicKey, Aggsig), Error> {
                    let ref_key = private_to_public_key(&private_keys[id].my_referee_private_key);
                    let referee = puzzle_for_pk(env.allocator, &ref_key)?;
                    let ref_puzzle_hash = referee.sha256tree(env.allocator);
                    let reward_sig = sign_reward_payout(
                        &private_keys[id].my_referee_private_key,
                        &ref_puzzle_hash,
                    );
                    Ok((Rc::new(referee), ref_puzzle_hash, ref_key, reward_sig))
                };

            let ref1 = make_ref_info(env, 0)?;
            let ref2 = make_ref_info(env, 1)?;
            let referees = [ref1, ref2];

            let make_party =
                |env: &mut ChannelEnv<'_>, id: usize| -> Result<ChannelHandlerParty, Error> {
                    ChannelHandlerParty::new(
                        env,
                        private_keys[id].clone(),
                        referees[id].0.clone(),
                        referees[id].1.clone(),
                        launcher_coin_id.clone(),
                        id == 1,
                        private_to_public_key(&private_keys[id ^ 1].my_channel_coin_private_key),
                        private_to_public_key(&private_keys[id ^ 1].my_unroll_coin_private_key),
                        referees[id ^ 1].2.clone(),
                        referees[id ^ 1].1.clone(),
                        referees[id ^ 1].3.clone(),
                        contributions[id].clone(),
                        contributions[id ^ 1].clone(),
                        unroll_advance_timeout.clone(),
                        referees[id].1.clone(),
                    )
                };

            let player1 = make_party(env, 0)?;
            let player2 = make_party(env, 1)?;

            Ok(ChannelHandlerGame {
                game_id,
                players: [player1, player2],
                handshake_result: [None, None],
            })
        }

        pub fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
            &mut self.players[who]
        }

        pub fn finish_handshake(
            &mut self,
            env: &mut ChannelEnv<'_>,
            who: usize,
        ) -> Result<(), Error> {
            let channel_coin_0_aggsig = self.players[who ^ 1]
                .init_data
                .my_initial_channel_half_signature_peer
                .clone();
            let handshake_result = self.players[who]
                .ch
                .finish_handshake(env, &channel_coin_0_aggsig)?;
            self.handshake_result[0] = Some(handshake_result.clone());
            self.handshake_result[1] = Some(handshake_result);
            Ok(())
        }

        pub fn update_channel_coin_after_receive(
            &mut self,
            player: usize,
            spend: &ChannelCoinSpendInfo,
        ) -> Result<(), Error> {
            if let Some(r) = &mut self.handshake_result[player] {
                r.spend = spend.clone();
                return Ok(());
            }

            Err(Error::StrErr("not fully running".to_string()))
        }

        pub fn get_channel_coin_spend(&self, who: usize) -> Result<HandshakeResult, Error> {
            if let Some(r) = &self.handshake_result[who] {
                return Ok(r.clone());
            }

            Err(Error::StrErr(
                "get channel handler spend when not able to unroll".to_string(),
            ))
        }
    }

    /// What event a ProposeNewGame action waits for before firing.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum ProposeTrigger {
        /// Wait for the channel to be created (handshake complete).
        Channel,
        /// Wait for a specific game (by GameID) to finish.
        AfterGame(GameID),
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum ActionReadiness {
        Immediate,
        GameCanMove { player: usize, game_id: GameID },
        AcceptProposal { player: usize, game_id: GameID },
        ChannelReady { player: usize },
        AfterGame { game_id: GameID },
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum PostActionDrain {
        None,
        OnChain,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct ActionSchedule {
        pub readiness: ActionReadiness,
        pub post_action_drain: PostActionDrain,
        pub expects_on_chain_transition: bool,
    }

    #[derive(Clone, Debug)]
    pub enum SimAssertion {
        GameCoinPublished(usize, GameID),
        GameCoinTimeoutRegistered(usize, GameID),
    }

    #[derive(Clone)]
    pub enum SimScriptAction {
        /// Do a timeout
        Timeout(usize),
        /// Move (player, game_id, clvm readable move, was received)
        Move(usize, GameID, ReadableMove, bool),
        /// Fake move (player, game_id, readable, sabotage bytes).
        FakeMove(usize, GameID, ReadableMove, Vec<u8>),
        /// Make a normal move, but tamper the outbound batch signatures.
        BadSignatureMove(usize, GameID, ReadableMove),
        /// Make a normal move, but invert the peer wire terminal flag.
        TerminalMismatchMove(usize, GameID, ReadableMove),
        /// Cheat (player, game_id, mover_share).
        Cheat(usize, GameID, Amount),
        /// Force-destroy a game coin (player, game_id).
        ForceDestroyCoin(usize, GameID),
        /// Nerf (silently drop) all outbound transactions for a player.
        NerfTransactions(usize),
        /// Stop nerfing transactions. If true, replay the backlog to the
        /// simulator; if false, discard it.
        UnNerfTransactions(bool),
        /// Stop reporting watched coin state changes for a player.
        BlockCoinReports(usize),
        /// Resume coin reports. If true, replay the backlog to the player.
        UnblockCoinReports(bool),
        /// Propose a new game from the specified player.
        /// The trigger specifies what event to wait for before proposing.
        ProposeNewGame(usize, ProposeTrigger),
        /// Propose a new game from the specified player with a custom game timeout.
        ProposeNewGameWithTimeout(usize, ProposeTrigger, u64),
        /// Like ProposeNewGame but with my_turn=false so the receiver moves first.
        ProposeNewGameTheirTurn(usize, ProposeTrigger),
        /// Propose the two asymmetric games that make up one Krunk hand.
        ProposeKrunkGroup(usize, ProposeTrigger),
        /// Go on chain
        GoOnChain(usize),
        /// Wait a number of blocks
        WaitBlocks(usize, usize),
        /// Accept timeout (player, game_id)
        AcceptSettlement(usize, GameID),
        /// Shut down
        CleanShutdown(usize),
        /// Corrupt a player's state_number for testing edge cases.
        /// (player, new_state_number)
        CorruptStateNumber(usize, usize),
        Assert(SimAssertion),
        /// Force-submit an unroll transaction for a player, bypassing
        /// handshake state checks.  Simulates a malicious peer who submits
        /// an old-state unroll even after agreeing to clean shutdown.
        ForceUnroll(usize),
        /// Stop nerfing transactions for a single player, leaving any other
        /// nerfed players (and the shared backlog) untouched.  Used to let one
        /// side win an on-chain race while the other stays nerfed, since
        /// `UnNerfTransactions` clears the nerf for everyone at once.
        UnNerfTransactionsFor(usize),
        /// Nerf (silently drop) all outbound messages for a player.
        NerfMessages(usize),
        /// Stop nerfing messages.
        UnNerfMessages,
        /// Accept a proposed game. (player, game_id)
        AcceptProposal(usize, GameID),
        /// Accept locally by one member but replace the wire canonical group ID.
        MalformedAcceptProposalGroup(usize, GameID, GameID),
        /// Cancel a proposed game (player, game_id).
        CancelProposal(usize, GameID),
        /// Snapshot the current unroll spend info for later stale unroll.
        SaveUnrollSnapshot(usize),
        /// Force-submit a stale unroll using a previously saved snapshot.
        ForceStaleUnroll(usize),
        /// Inject raw bytes into a player's inbound message queue.
        /// Used for testing message validation (e.g. oversized messages).
        InjectRawMessage(usize, Vec<u8>),
        /// Force a self-accept: bypass local parity check and send
        /// AcceptProposal for our own game_id (SEC-975). (player, game_id)
        SelfAcceptProposal(usize, GameID),
        /// Propose a game but tamper the outbound message to use a game_id
        /// with the wrong parity. Tests receiver-side parity rejection.
        WrongParityProposal(usize),
        /// Propose a game but tamper the outbound proposal parameters to nil.
        /// Tests game-specific parser rejection of invalid peer terms.
        InvalidProposalParameters(usize),
        /// Propose a game but tamper an argument generated by the sender's factory.
        /// Tests receiver-side regeneration and exact comparison.
        InvalidProposalArguments(usize),
        /// Propose a game but tamper its initial validation-info commitment.
        InvalidProposalValidationInfoHash(usize),
        /// Propose a game but tamper the outbound proposal timeout to zero.
        InvalidProposalTimeout(usize),
    }

    impl std::fmt::Debug for SimScriptAction {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
            match self {
                SimScriptAction::Timeout(t) => write!(formatter, "Timeout({t})"),
                SimScriptAction::Move(p, g, n, r) => write!(formatter, "Move({p},{g:?},{n:?},{r})"),
                SimScriptAction::FakeMove(p, g, n, v) => {
                    write!(formatter, "FakeMove({p},{g:?},{n:?},{v:?})")
                }
                SimScriptAction::BadSignatureMove(p, g, n) => {
                    write!(formatter, "BadSignatureMove({p},{g:?},{n:?})")
                }
                SimScriptAction::TerminalMismatchMove(p, g, n) => {
                    write!(formatter, "TerminalMismatchMove({p},{g:?},{n:?})")
                }
                SimScriptAction::Cheat(p, g, ms) => write!(formatter, "Cheat({p},{g:?},{ms:?})"),
                SimScriptAction::ForceDestroyCoin(p, g) => {
                    write!(formatter, "ForceDestroyCoin({p},{g:?})")
                }
                SimScriptAction::NerfTransactions(p) => write!(formatter, "NerfTransactions({p})"),
                SimScriptAction::UnNerfTransactions(r) => {
                    write!(formatter, "UnNerfTransactions({r})")
                }
                SimScriptAction::UnNerfTransactionsFor(p) => {
                    write!(formatter, "UnNerfTransactionsFor({p})")
                }
                SimScriptAction::BlockCoinReports(p) => write!(formatter, "BlockCoinReports({p})"),
                SimScriptAction::UnblockCoinReports(r) => {
                    write!(formatter, "UnblockCoinReports({r})")
                }
                SimScriptAction::ProposeNewGame(p, t) => {
                    write!(formatter, "ProposeNewGame({p},{t:?})")
                }
                SimScriptAction::ProposeNewGameWithTimeout(p, t, timeout) => {
                    write!(formatter, "ProposeNewGameWithTimeout({p},{t:?},{timeout})")
                }
                SimScriptAction::ProposeNewGameTheirTurn(p, t) => {
                    write!(formatter, "ProposeNewGameTheirTurn({p},{t:?})")
                }
                SimScriptAction::ProposeKrunkGroup(p, t) => {
                    write!(formatter, "ProposeKrunkGroup({p},{t:?})")
                }
                SimScriptAction::GoOnChain(p) => write!(formatter, "GoOnChain({p})"),
                SimScriptAction::AcceptSettlement(p, g) => {
                    write!(formatter, "AcceptSettlement({p},{g:?})")
                }
                SimScriptAction::WaitBlocks(n, p) => write!(formatter, "WaitBlocks({n},{p})"),
                SimScriptAction::CleanShutdown(p) => write!(formatter, "CleanShutdown({p})"),
                SimScriptAction::CorruptStateNumber(p, sn) => {
                    write!(formatter, "CorruptStateNumber({p},{sn})")
                }
                SimScriptAction::Assert(assertion) => write!(formatter, "Assert({assertion:?})"),
                SimScriptAction::ForceUnroll(p) => write!(formatter, "ForceUnroll({p})"),
                SimScriptAction::NerfMessages(p) => write!(formatter, "NerfMessages({p})"),
                SimScriptAction::UnNerfMessages => write!(formatter, "UnNerfMessages"),
                SimScriptAction::AcceptProposal(p, g) => {
                    write!(formatter, "AcceptProposal({p},{g:?})")
                }
                SimScriptAction::MalformedAcceptProposalGroup(p, local, wire) => {
                    write!(
                        formatter,
                        "MalformedAcceptProposalGroup({p},{local:?},{wire:?})"
                    )
                }
                SimScriptAction::CancelProposal(p, g) => {
                    write!(formatter, "CancelProposal({p},{g:?})")
                }
                SimScriptAction::SaveUnrollSnapshot(p) => {
                    write!(formatter, "SaveUnrollSnapshot({p})")
                }
                SimScriptAction::ForceStaleUnroll(p) => write!(formatter, "ForceStaleUnroll({p})"),
                SimScriptAction::InjectRawMessage(p, data) => {
                    write!(formatter, "InjectRawMessage({p}, {} bytes)", data.len())
                }
                SimScriptAction::SelfAcceptProposal(p, g) => {
                    write!(formatter, "SelfAcceptProposal({p},{g:?})")
                }
                SimScriptAction::WrongParityProposal(p) => {
                    write!(formatter, "WrongParityProposal({p})")
                }
                SimScriptAction::InvalidProposalParameters(p) => {
                    write!(formatter, "InvalidProposalParameters({p})")
                }
                SimScriptAction::InvalidProposalArguments(p) => {
                    write!(formatter, "InvalidProposalArguments({p})")
                }
                SimScriptAction::InvalidProposalValidationInfoHash(p) => {
                    write!(formatter, "InvalidProposalValidationInfoHash({p})")
                }
                SimScriptAction::InvalidProposalTimeout(p) => {
                    write!(formatter, "InvalidProposalTimeout({p})")
                }
            }
        }
    }

    impl SimScriptAction {
        pub fn schedule(&self) -> ActionSchedule {
            match self {
                Self::Move(player, game_id, _, _)
                | Self::FakeMove(player, game_id, _, _)
                | Self::BadSignatureMove(player, game_id, _)
                | Self::TerminalMismatchMove(player, game_id, _) => ActionSchedule {
                    readiness: ActionReadiness::GameCanMove {
                        player: *player,
                        game_id: *game_id,
                    },
                    post_action_drain: PostActionDrain::OnChain,
                    expects_on_chain_transition: false,
                },
                Self::AcceptProposal(player, game_id)
                | Self::MalformedAcceptProposalGroup(player, game_id, _) => ActionSchedule {
                    readiness: ActionReadiness::AcceptProposal {
                        player: *player,
                        game_id: *game_id,
                    },
                    post_action_drain: PostActionDrain::OnChain,
                    expects_on_chain_transition: false,
                },
                Self::ProposeNewGame(player, trigger)
                | Self::ProposeNewGameWithTimeout(player, trigger, _)
                | Self::ProposeNewGameTheirTurn(player, trigger)
                | Self::ProposeKrunkGroup(player, trigger) => ActionSchedule {
                    readiness: match trigger {
                        ProposeTrigger::Channel => {
                            ActionReadiness::ChannelReady { player: *player }
                        }
                        ProposeTrigger::AfterGame(game_id) => {
                            ActionReadiness::AfterGame { game_id: *game_id }
                        }
                    },
                    post_action_drain: PostActionDrain::OnChain,
                    expects_on_chain_transition: false,
                },
                Self::GoOnChain(_) => ActionSchedule {
                    readiness: ActionReadiness::Immediate,
                    post_action_drain: PostActionDrain::OnChain,
                    expects_on_chain_transition: true,
                },
                Self::Cheat(_, _, _)
                | Self::AcceptSettlement(_, _)
                | Self::CleanShutdown(_)
                | Self::CancelProposal(_, _)
                | Self::InjectRawMessage(_, _)
                | Self::SelfAcceptProposal(_, _)
                | Self::WrongParityProposal(_)
                | Self::InvalidProposalParameters(_)
                | Self::InvalidProposalArguments(_)
                | Self::InvalidProposalValidationInfoHash(_)
                | Self::InvalidProposalTimeout(_) => ActionSchedule {
                    readiness: ActionReadiness::Immediate,
                    post_action_drain: PostActionDrain::OnChain,
                    expects_on_chain_transition: false,
                },
                Self::ForceUnroll(_) | Self::ForceStaleUnroll(_) => ActionSchedule {
                    readiness: ActionReadiness::Immediate,
                    post_action_drain: PostActionDrain::None,
                    expects_on_chain_transition: true,
                },
                Self::Timeout(_)
                | Self::ForceDestroyCoin(_, _)
                | Self::NerfTransactions(_)
                | Self::UnNerfTransactions(_)
                | Self::BlockCoinReports(_)
                | Self::UnblockCoinReports(_)
                | Self::WaitBlocks(_, _)
                | Self::CorruptStateNumber(_, _)
                | Self::Assert(_)
                | Self::UnNerfTransactionsFor(_)
                | Self::NerfMessages(_)
                | Self::UnNerfMessages
                | Self::SaveUnrollSnapshot(_) => ActionSchedule {
                    readiness: ActionReadiness::Immediate,
                    post_action_drain: PostActionDrain::None,
                    expects_on_chain_transition: false,
                },
            }
        }

        pub fn lose(&self) -> SimScriptAction {
            if let SimScriptAction::Move(p, g, m, _r) = self {
                return SimScriptAction::Move(*p, *g, m.clone(), false);
            }

            self.clone()
        }
    }

    #[derive(Debug, Clone)]
    pub enum SimScriptActionResult {
        MoveResult(ReadableMove, Vec<u8>, Option<ReadableMove>, Hash),
        BrokenMove,
        MoveToOnChain,
        AcceptedTimeout,
        Shutdown,
    }

    pub fn new_channel_handler_game<R: Rng>(
        simulator: &Simulator,
        rng: &mut R,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
        factory_game: &FactoryGame,
        identities: &[ChiaIdentity; 2],
        contributions: [Amount; 2],
    ) -> Result<(ChannelHandlerGame, CoinString), Error> {
        // Get at least one coin for the first identity
        simulator.farm_block(&identities[0].puzzle_hash);
        // Get at least one coin for the second identity
        simulator.farm_block(&identities[1].puzzle_hash);

        let get_sufficient_coins = |i: usize| -> Result<Vec<CoinString>, Error> {
            Ok(simulator
                .get_my_coins(&identities[i].puzzle_hash)?
                .into_iter()
                .filter(|c| {
                    if let Some((_, _, amt)) = c.to_parts() {
                        return amt >= contributions[i].clone();
                    }
                    false
                })
                .collect())
        };
        let coins: [Vec<CoinString>; 2] = [get_sufficient_coins(0)?, get_sufficient_coins(1)?];

        // Make state channel coin.
        // Spend coin1 to person 0 creating their_amount and change (u1).
        let (u1, _) = simulator.transfer_coin_amount(
            env.allocator,
            &identities[0].puzzle_hash,
            &identities[1],
            &coins[1][0],
            contributions[1].clone(),
        )?;
        simulator.farm_block(&identities[0].puzzle_hash);

        // Spend coin0 to person 0 creating my_amount and change (u0).
        let (u2, _) = simulator.transfer_coin_amount(
            env.allocator,
            &identities[0].puzzle_hash,
            &identities[0],
            &coins[0][0],
            contributions[0].clone(),
        )?;
        simulator.farm_block(&identities[0].puzzle_hash);

        let mut party = ChannelHandlerGame::new(
            rng,
            env,
            game_id.clone(),
            &u2.to_coin_id(),
            &contributions.clone(),
            (*DEFAULT_UNROLL_TIME_LOCK).clone(),
        )
        .expect("should work");

        // Combine u1 and u0 into a single person aggregate key coin.
        let aggregate_public_key = private_to_public_key(&party.player(0).ch.channel_private_key())
            + private_to_public_key(&party.player(1).ch.channel_private_key());

        let _cc_ph = puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_public_key)?;

        let channel_coin = simulator.combine_coins(
            env.allocator,
            &identities[0],
            &party.players[0].init_data.channel_puzzle_hash_up,
            &[u1, u2],
        )?;
        simulator.farm_block(&identities[0].puzzle_hash);

        party
            .finish_handshake(env, 1)
            .expect("should finish handshake");
        party
            .finish_handshake(env, 0)
            .expect("should finish handshake");

        let timeout = Timeout::new(15);

        let our_game_start = factory_game.game_start(game_id, &timeout, true);
        let their_game_start = factory_game.game_start(game_id, &timeout, false);

        let our_start: Rc<GameStartInfo> = Rc::new(our_game_start);
        let their_start: Rc<GameStartInfo> = Rc::new(their_game_start);

        let propose_sigs = party.player(0).ch.propose_game(env, &our_start)?;
        party
            .player(1)
            .ch
            .apply_received_proposal(env, &their_start, their_start.game_id)?;
        let recv_propose = party
            .player(1)
            .ch
            .verify_received_batch_signatures(env, &propose_sigs)?;
        party.update_channel_coin_after_receive(1, &recv_propose)?;

        party.player(1).ch.send_accept_proposal(&game_id)?;
        let accept_sigs = party.player(1).ch.update_cached_unroll_state(env)?;
        party
            .player(0)
            .ch
            .apply_received_accept_proposal(&game_id)?;
        let recv_accept = party
            .player(0)
            .ch
            .verify_received_batch_signatures(env, &accept_sigs)?;
        party.update_channel_coin_after_receive(0, &recv_accept)?;

        Ok((party, channel_coin))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn readable() -> ReadableMove {
            ReadableMove::from_program(Rc::new(Program::from_hex("80").expect("nil")))
        }

        fn schedule(
            readiness: ActionReadiness,
            post_action_drain: PostActionDrain,
            expects_on_chain_transition: bool,
        ) -> ActionSchedule {
            ActionSchedule {
                readiness,
                post_action_drain,
                expects_on_chain_transition,
            }
        }

        #[test]
        fn every_script_action_has_an_exhaustive_data_bearing_schedule() {
            let gid = GameID(7);
            let immediate_drain =
                schedule(ActionReadiness::Immediate, PostActionDrain::OnChain, false);
            let immediate_no_drain =
                schedule(ActionReadiness::Immediate, PostActionDrain::None, false);
            let transition_drain =
                schedule(ActionReadiness::Immediate, PostActionDrain::OnChain, true);
            let transition_no_drain =
                schedule(ActionReadiness::Immediate, PostActionDrain::None, true);
            let can_move = schedule(
                ActionReadiness::GameCanMove {
                    player: 1,
                    game_id: gid,
                },
                PostActionDrain::OnChain,
                false,
            );
            let accept = schedule(
                ActionReadiness::AcceptProposal {
                    player: 1,
                    game_id: gid,
                },
                PostActionDrain::OnChain,
                false,
            );
            let channel = schedule(
                ActionReadiness::ChannelReady { player: 1 },
                PostActionDrain::OnChain,
                false,
            );
            let after_game = schedule(
                ActionReadiness::AfterGame { game_id: gid },
                PostActionDrain::OnChain,
                false,
            );
            let cases = vec![
                (SimScriptAction::Timeout(1), immediate_no_drain),
                (SimScriptAction::Move(1, gid, readable(), true), can_move),
                (
                    SimScriptAction::FakeMove(1, gid, readable(), vec![1]),
                    can_move,
                ),
                (
                    SimScriptAction::BadSignatureMove(1, gid, readable()),
                    can_move,
                ),
                (
                    SimScriptAction::Cheat(1, gid, Amount::new(10)),
                    immediate_drain,
                ),
                (
                    SimScriptAction::ForceDestroyCoin(1, gid),
                    immediate_no_drain,
                ),
                (SimScriptAction::NerfTransactions(1), immediate_no_drain),
                (
                    SimScriptAction::UnNerfTransactions(true),
                    immediate_no_drain,
                ),
                (SimScriptAction::BlockCoinReports(1), immediate_no_drain),
                (
                    SimScriptAction::UnblockCoinReports(true),
                    immediate_no_drain,
                ),
                (
                    SimScriptAction::ProposeNewGame(1, ProposeTrigger::Channel),
                    channel,
                ),
                (
                    SimScriptAction::ProposeNewGame(1, ProposeTrigger::AfterGame(gid)),
                    after_game,
                ),
                (
                    SimScriptAction::ProposeNewGameWithTimeout(1, ProposeTrigger::Channel, 20),
                    channel,
                ),
                (
                    SimScriptAction::ProposeNewGameWithTimeout(
                        1,
                        ProposeTrigger::AfterGame(gid),
                        20,
                    ),
                    after_game,
                ),
                (
                    SimScriptAction::ProposeNewGameTheirTurn(1, ProposeTrigger::Channel),
                    channel,
                ),
                (
                    SimScriptAction::ProposeNewGameTheirTurn(1, ProposeTrigger::AfterGame(gid)),
                    after_game,
                ),
                (
                    SimScriptAction::ProposeKrunkGroup(1, ProposeTrigger::Channel),
                    channel,
                ),
                (
                    SimScriptAction::ProposeKrunkGroup(1, ProposeTrigger::AfterGame(gid)),
                    after_game,
                ),
                (SimScriptAction::GoOnChain(1), transition_drain),
                (SimScriptAction::WaitBlocks(3, 1), immediate_no_drain),
                (SimScriptAction::AcceptSettlement(1, gid), immediate_drain),
                (SimScriptAction::CleanShutdown(1), immediate_drain),
                (
                    SimScriptAction::CorruptStateNumber(1, 9),
                    immediate_no_drain,
                ),
                (
                    SimScriptAction::Assert(SimAssertion::GameCoinPublished(1, gid)),
                    immediate_no_drain,
                ),
                (
                    SimScriptAction::Assert(SimAssertion::GameCoinTimeoutRegistered(1, gid)),
                    immediate_no_drain,
                ),
                (SimScriptAction::ForceUnroll(1), transition_no_drain),
                (
                    SimScriptAction::UnNerfTransactionsFor(1),
                    immediate_no_drain,
                ),
                (SimScriptAction::NerfMessages(1), immediate_no_drain),
                (SimScriptAction::UnNerfMessages, immediate_no_drain),
                (SimScriptAction::AcceptProposal(1, gid), accept),
                (SimScriptAction::CancelProposal(1, gid), immediate_drain),
                (SimScriptAction::SaveUnrollSnapshot(1), immediate_no_drain),
                (SimScriptAction::ForceStaleUnroll(1), transition_no_drain),
                (
                    SimScriptAction::InjectRawMessage(1, vec![1]),
                    immediate_drain,
                ),
                (SimScriptAction::SelfAcceptProposal(1, gid), immediate_drain),
                (SimScriptAction::WrongParityProposal(1), immediate_drain),
                (
                    SimScriptAction::InvalidProposalParameters(1),
                    immediate_drain,
                ),
                (
                    SimScriptAction::InvalidProposalArguments(1),
                    immediate_drain,
                ),
                (
                    SimScriptAction::InvalidProposalValidationInfoHash(1),
                    immediate_drain,
                ),
                (SimScriptAction::InvalidProposalTimeout(1), immediate_drain),
            ];

            for (action, expected) in cases {
                assert_eq!(action.schedule(), expected, "{action:?}");
            }
        }
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::{
    new_channel_handler_game, ActionReadiness, ActionSchedule, ChannelHandlerGame, PostActionDrain,
    ProposeTrigger, SimAssertion, SimScriptAction, SimScriptActionResult,
};
