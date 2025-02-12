use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use clvm_traits::ClvmEncoder;
use rand::Rng;

use log::debug;

use crate::channel_handler::types::{
    AcceptTransactionState, CoinSpentInformation, OnChainGameState, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, IntoErr, Program,
    SpendBundle, Timeout,
};
use crate::potato_handler::types::{
    BootstrapTowardWallet, GameAction, PacketSender, PeerEnv, PotatoHandlerImpl, PotatoState,
    ToLocalUI, WalletSpendInterface,
};
use crate::referee::{RefereeOnChainTransaction, SlashOutcome, TheirTurnCoinSpentResult};
use crate::shutdown::ShutdownConditions;

pub struct OnChainPotatoHandler {
    have_potato: PotatoState,
    channel_timeout: Timeout,
    player_ch: ChannelHandler,
    game_action_queue: VecDeque<GameAction>,
    game_map: HashMap<CoinString, OnChainGameState>,
}

impl std::fmt::Debug for OnChainPotatoHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "OnChainPotatoHandler(..)")
    }
}

impl OnChainPotatoHandler {
    pub fn new(
        have_potato: PotatoState,
        channel_timeout: Timeout,
        player_ch: ChannelHandler,
        game_action_queue: VecDeque<GameAction>,
        game_map: HashMap<CoinString, OnChainGameState>,
    ) -> Self {
        OnChainPotatoHandler {
            have_potato,
            channel_timeout,
            player_ch,
            game_action_queue,
            game_map,
        }
    }

    fn no_live_games(&self) -> bool {
        self.game_map.is_empty()
            || self
                .game_map
                .values()
                .all(|g| matches!(g.accept, AcceptTransactionState::Finished))
    }
}

impl PotatoHandlerImpl for OnChainPotatoHandler {
    fn channel_handler(&self) -> &ChannelHandler {
        &self.player_ch
    }

    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.player_ch.game_is_my_turn(game_id)
    }

    fn channel_handler_mut(&mut self) -> &mut ChannelHandler {
        &mut self.player_ch
    }

    fn into_channel_handler(self) -> ChannelHandler {
        self.player_ch
    }

    fn check_game_coin_spent<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        if self.game_map.contains_key(coin_id) {
            // Check how it got spent.
            let (_env, system_interface) = penv.env();
            system_interface.request_puzzle_and_solution(coin_id)?;
            return Ok(true);
        }

        Ok(false)
    }

    fn handle_game_coin_spent<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let mut unblock_queue = false;
        let initial_potato = self.player_ch.is_initial_potato();

        debug!("{initial_potato} handle game coin spent {coin_id:?}");

        let old_definition = if let Some(old_definition) = self.game_map.remove(coin_id) {
            self.have_potato = PotatoState::Present;
            debug!("{initial_potato} we have game coin {old_definition:?}");
            old_definition
        } else {
            debug!("{initial_potato} we don't have game coin!",);
            return Ok(());
        };

        // A game coin was spent and we have the puzzle and solution.
        let (env, system_interface) = penv.env();
        let conditions = CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
        let result =
            self.player_ch
                .game_coin_spent(env, &old_definition.game_id, coin_id, &conditions);
        let their_turn_result = if let Ok(result) = result {
            result
        } else {
            debug!("failed result {result:?}");
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string: None,
            })
        };

        debug!(
            "{initial_potato} game coin spent result from channel handler {their_turn_result:?}"
        );
        match their_turn_result {
            CoinSpentInformation::Expected(ph, amt) => {
                debug!("{initial_potato} got an expected spend {ph:?} {amt:?}");
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);

                // An expected their spend arrived.  We can do our next action.
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph,
                        our_turn: false,
                        ..old_definition
                    },
                );

                let (_, system_interface) = penv.env();
                system_interface.register_coin(
                    &new_coin_id,
                    &self.channel_timeout,
                    Some("coin gives their turn"),
                )?;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string,
                ..
            }) => {
                debug!("{initial_potato} timed out {my_reward_coin_string:?}");
                system_interface.game_cancelled(&old_definition.game_id)?;
                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Moved {
                new_coin_string,
                readable,
                mover_share,
                ..
            }) => {
                debug!(
                    "{initial_potato} got a their spend {new_coin_string:?} from ph {:?}",
                    old_definition.puzzle_hash
                );
                let (puzzle_hash, amt) =
                    if let Some((orig_coin_id, ph, amt)) = new_coin_string.to_parts() {
                        assert_eq!(coin_id.to_coin_id(), orig_coin_id);
                        (ph, amt)
                    } else {
                        return Err(Error::StrErr("bad coin explode".to_string()));
                    };

                let game_id = old_definition.game_id.clone();
                debug!("{initial_potato} got their coin spend with new puzzle hash {puzzle_hash:?} {amt:?}");
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_string.clone(),
                    OnChainGameState {
                        puzzle_hash,
                        our_turn: true,
                        ..old_definition
                    },
                );

                system_interface.opponent_moved(env.allocator, &game_id, readable, mover_share)?;
                system_interface.register_coin(
                    &new_coin_string,
                    &self.channel_timeout,
                    Some("coin gives my turn"),
                )?;

                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Slash(outcome)) => {
                debug!("{initial_potato} slash {outcome:?}");
                self.have_potato = PotatoState::Present;
                // XXX amount
                let amount = if let SlashOutcome::Reward {
                    my_reward_coin_string,
                    ..
                } = outcome.borrow()
                {
                    my_reward_coin_string
                        .to_parts()
                        .map(|(_, _, amt)| amt.clone())
                        .unwrap_or(Amount::default())
                } else {
                    Amount::default()
                };
                debug!("{initial_potato} setting game finished");
                system_interface.game_finished(&old_definition.game_id, amount)?;

                if let SlashOutcome::Reward { transaction, .. } = outcome.borrow() {
                    system_interface.spend_transaction_and_add_fee(&SpendBundle {
                        name: Some("slash move".to_string()),
                        spends: vec![*transaction.clone()],
                    })?;
                }
            }
            CoinSpentInformation::OurReward(_, _) => {
                // XXX notify UI if we decide we need it.
                debug!("{initial_potato} our reward coin was spent");
                unblock_queue = true;
            }
            CoinSpentInformation::OurSpend(ph, amt) => {
                debug!("{initial_potato} got an our spend {ph:?} {amt:?}");
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph,
                        our_turn: false,
                        ..old_definition
                    },
                );

                let (_, system_interface) = penv.env();
                system_interface.register_coin(
                    &new_coin_id,
                    &self.channel_timeout,
                    Some("coin gives their turn"),
                )?;

                // Do some kind of UI indication.
                unblock_queue = true;
            }
        }

        if unblock_queue {
            debug!(
                "{initial_potato} do another action, actions {:?}",
                self.game_action_queue
            );
            self.next_action(penv)?;
        }

        Ok(())
    }

    fn coin_timeout_reached<'a, G, R>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        R: Rng + 'a,
    {
        if let Some(mut game_def) = self.game_map.remove(coin_id) {
            let initial_potato = self.player_ch.is_initial_potato();
            let game_id = game_def.game_id.clone();
            let (env, system_interface) = penv.env();
            debug!("{initial_potato} timeout coin {coin_id:?}, do accept");

            if let AcceptTransactionState::Determined(tx) = &game_def.accept {
                debug!("{initial_potato} accept tx {tx:?}");
                self.have_potato = PotatoState::Present;

                system_interface.spend_transaction_and_add_fee(&SpendBundle {
                    name: Some("redo move".to_string()),
                    spends: vec![CoinSpend {
                        coin: coin_id.clone(),
                        bundle: tx.bundle.clone(),
                    }],
                })?;
            } else {
                game_def.accept = AcceptTransactionState::Finished;
                self.game_map.insert(coin_id.clone(), game_def);

                let result_transaction = if let Ok(result_transaction) = self
                    .player_ch
                    .accept_or_timeout_game_on_chain(env, &game_id, coin_id)
                {
                    result_transaction
                } else {
                    return self.next_action(penv);
                };

                self.have_potato = PotatoState::Present;
                if let Some(tx) = result_transaction {
                    debug!("{initial_potato} accept: have transaction {tx:?}");
                    self.have_potato = PotatoState::Absent;
                    system_interface.spend_transaction_and_add_fee(&SpendBundle {
                        name: Some(format!("{initial_potato} accept transaction")),
                        spends: vec![CoinSpend {
                            coin: coin_id.clone(),
                            bundle: tx.bundle.clone(),
                        }],
                    })?;
                } else {
                    debug!("{initial_potato} Accepted game when our share was zero");
                    debug!("when action queue is {:?}", self.game_action_queue);
                }
            }

            // XXX Have a notification for this.
            let nil = env.allocator.encode_atom(&[]).into_gen()?;
            let readable = ReadableMove::from_nodeptr(env.allocator, nil)?;
            let mover_share = Amount::default();

            system_interface.opponent_moved(env.allocator, &game_id, readable, mover_share)?;
            self.next_action(penv)?;
        }

        Ok(())
    }

    fn next_action<'a, G, R>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        R: Rng + 'a,
    {
        if let Some(action) = self.game_action_queue.pop_front() {
            self.do_on_chain_action(penv, action)?;
        }

        Ok(())
    }

    fn do_on_chain_move<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        current_coin: &CoinString,
        game_id: GameID,
        readable_move: ReadableMove,
        entropy: Hash,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let (initial_potato, (old_ph, new_ph, move_result, transaction)) = {
            let initial_potato = self.player_ch.is_initial_potato();
            let my_turn = self.player_ch.game_is_my_turn(&game_id);
            if my_turn != Some(true) {
                debug!(
                    "{initial_potato} trying to do game action when not my turn {readable_move:?}"
                );
                self.game_action_queue.push_front(GameAction::Move(
                    game_id,
                    readable_move,
                    entropy,
                ));
                return Ok(());
            }

            let (env, _system_interface) = penv.env();
            (
                initial_potato,
                self.player_ch.on_chain_our_move(
                    env,
                    &game_id,
                    &readable_move,
                    entropy,
                    current_coin,
                )?,
            )
        };

        debug!("{initial_potato} old_ph {old_ph:?}");
        debug!("{initial_potato} new_ph {new_ph:?}");

        if let Some((_, ph, _)) = current_coin.to_parts() {
            assert_eq!(old_ph, ph);
        }

        debug!("{initial_potato} created puzzle hash for move {new_ph:?}");
        let old_definition = if let Some(old_def) = self.game_map.remove(current_coin) {
            old_def
        } else {
            return Err(Error::StrErr("no such game".to_string()));
        };

        let new_coin =
            CoinString::from_parts(&current_coin.to_coin_id(), &new_ph, &transaction.amount);

        debug!("{initial_potato} changing game map");
        self.game_map.insert(
            new_coin.clone(),
            OnChainGameState {
                puzzle_hash: new_ph,
                our_turn: false,
                ..old_definition
            },
        );

        let (_env, system_interface) = penv.env();
        system_interface.register_coin(
            &new_coin,
            &self.channel_timeout,
            Some("game coin for my turn"),
        )?;

        system_interface.spend_transaction_and_add_fee(&SpendBundle {
            name: Some("on chain move".to_string()),
            spends: vec![CoinSpend {
                coin: current_coin.clone(),
                bundle: transaction.bundle.clone(),
            }],
        })?;
        system_interface.self_move(&game_id, &move_result.basic.move_made)?;

        Ok(())
    }

    fn do_on_chain_action<'a, G, R: Rng + 'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        action: GameAction,
    ) -> Result<(), Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
    {
        let initial_potato = self.player_ch.is_initial_potato();
        let get_current_coin = |game_id: &GameID| -> Result<CoinString, Error> {
            if let Some((current, _game)) = self.game_map.iter().find(|g| g.1.game_id == *game_id) {
                Ok(current.clone())
            } else {
                Err(Error::StrErr(format!(
                    "no matching game in {:?}",
                    self.game_map
                )))
            }
        };

        debug!("{initial_potato} do_on_chain_action {action:?}");
        debug!("{initial_potato} have collection {:?}", self.game_map);

        match action {
            GameAction::Move(game_id, readable_move, hash) => {
                let current_coin = get_current_coin(&game_id)?;
                self.do_on_chain_move(penv, &current_coin, game_id, readable_move, hash)
            }
            GameAction::RedoMove(_game_id, coin, new_ph, tx) => {
                let (_env, system_interface) = penv.env();
                self.have_potato = PotatoState::Absent;
                system_interface.spend_transaction_and_add_fee(&SpendBundle {
                    name: Some("redo move".to_string()),
                    spends: vec![CoinSpend {
                        coin: coin.clone(),
                        bundle: tx.bundle.clone(),
                    }],
                })?;
                let amt = if let Some((_, _, amt)) = coin.to_parts() {
                    amt
                } else {
                    return Err(Error::StrErr("bad coin".to_string()));
                };

                let new_coin = CoinString::from_parts(&coin.to_coin_id(), &new_ph, &amt);
                system_interface.register_coin(
                    &new_coin,
                    &self.channel_timeout,
                    Some("post redo game coin"),
                )?;
                Ok(())
            }
            GameAction::RedoAccept(_game_id, coin, _new_ph, tx) => {
                let (_env, system_interface) = penv.env();
                // Wait for timeout.
                if let Some(def) = self.game_map.get_mut(&coin) {
                    self.have_potato = PotatoState::Absent;
                    debug!("{initial_potato} redo accept: register for timeout {coin:?}");
                    let tx_borrow: &RefereeOnChainTransaction = tx.borrow();
                    def.accept = AcceptTransactionState::Determined(Box::new(tx_borrow.clone()));
                    system_interface.register_coin(
                        &coin,
                        &self.channel_timeout,
                        Some("redo accept wait"),
                    )?;
                }
                Ok(())
            }
            GameAction::Accept(game_id) => {
                let current_coin = get_current_coin(&game_id)?;
                let my_turn = self.player_ch.game_is_my_turn(&game_id);
                debug!(
                    "{initial_potato} on chain (my turn {my_turn:?}): accept game coin {current_coin:?}",
                );

                Ok(())
            }
            GameAction::Shutdown(conditions) => {
                if !self.no_live_games() {
                    debug!("Can't shut down yet, still have games");
                    self.game_action_queue
                        .push_front(GameAction::Shutdown(conditions));
                    return Ok(());
                }

                let (_env, system_interface) = penv.env();
                debug!("notify shutdown complete");
                system_interface.shutdown_complete(None)?;
                Ok(())
            }
        }
    }

    fn shut_down<'a, G, R>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<bool, Error>
    where
        G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
        R: Rng + 'a,
    {
        let (_env, system_interface) = penv.env();
        if !self.no_live_games() {
            debug!(
                "{} waiting for all games to be done",
                self.player_ch.is_initial_potato()
            );
            self.game_action_queue
                .push_back(GameAction::Shutdown(conditions));
            return Ok(false);
        }

        system_interface.shutdown_complete(None)?;

        Ok(true)
    }
}
