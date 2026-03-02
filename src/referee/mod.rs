pub mod my_turn;
pub mod their_turn;
pub mod types;

use std::rc::Rc;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{ReadableMove, ValidationInfo};
use crate::common::standard_coin::{sign_reward_payout, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinString, Error, Hash, Program, PublicKey,
    Puzzle, PuzzleHash, Sha256tree, Spend, Timeout,
};
use crate::referee::my_turn::MyTurnReferee;
use crate::referee::their_turn::TheirTurnReferee;
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, GameMoveDetails, GameMoveStateInfo,
    GameMoveWireData, OnChainRefereeMoveData, OnChainRefereeSolution, RMFixed,
    RefereeOnChainTransaction, RefereePuzzleArgs, TheirTurnCoinSpentResult, TheirTurnMoveResult,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Referee {
    MyTurn(Rc<MyTurnReferee>),
    TheirTurn(Rc<TheirTurnReferee>),
}

impl Referee {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &Rc<GameStartInfo>,
        my_identity: ChiaIdentity,
        their_pubkey: &PublicKey,
        their_reward_puzzle_hash: &PuzzleHash,
        their_reward_payout_signature: &Aggsig,
        reward_puzzle_hash: &PuzzleHash,
        nonce: usize,
        agg_sig_me_additional_data: &Hash,
        state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
            max_move_size: 0,
        };
        let my_turn = game_start_info.game_handler.is_my_turn();

        let fixed_info = Rc::new(RMFixed {
            referee_coin_puzzle: referee_coin_puzzle.clone(),
            referee_coin_puzzle_hash: referee_coin_puzzle_hash.clone(),
            their_referee_pubkey: their_pubkey.clone(),
            their_reward_payout_signature: their_reward_payout_signature.clone(),
            my_reward_payout_signature: sign_reward_payout(
                &my_identity.private_key,
                reward_puzzle_hash,
            ),
            reward_puzzle_hash: reward_puzzle_hash.clone(),
            their_reward_puzzle_hash: their_reward_puzzle_hash.clone(),
            my_identity: my_identity.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce,
            agg_sig_me_additional_data: agg_sig_me_additional_data.clone(),
        });

        let ip = game_start_info.initial_validation_program.clone();
        let vi_hash = ValidationInfo::new_state_update(
            allocator,
            ip.clone(),
            game_start_info.initial_state.p(),
        );
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &fixed_info,
            &GameMoveDetails {
                basic: GameMoveStateInfo {
                    mover_share: game_start_info.initial_mover_share.clone(),
                    max_move_size: game_start_info.initial_max_move_size,
                    ..initial_move.clone()
                },
                validation_info_hash: vi_hash.hash().clone(),
            },
            None,
            ip.clone(),
            my_turn,
        ));
        if my_turn {
            assert_eq!(
                fixed_info.my_identity.public_key,
                ref_puzzle_args.mover_pubkey
            );
        } else {
            assert_eq!(
                fixed_info.their_referee_pubkey,
                ref_puzzle_args.mover_pubkey
            );
        }
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        let (turn, _t_ph) = if my_turn {
            let tr = MyTurnReferee::new(
                allocator,
                referee_coin_puzzle.clone(),
                referee_coin_puzzle_hash.clone(),
                game_start_info,
                my_identity.clone(),
                their_pubkey,
                their_reward_puzzle_hash,
                their_reward_payout_signature,
                reward_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (Referee::MyTurn(Rc::new(tr.0)), tr.1)
        } else {
            let tr = TheirTurnReferee::new(
                allocator,
                referee_coin_puzzle,
                referee_coin_puzzle_hash,
                game_start_info,
                my_identity,
                their_pubkey,
                their_reward_puzzle_hash,
                their_reward_payout_signature,
                reward_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (Referee::TheirTurn(Rc::new(tr.0)), tr.1)
        };
        Ok((turn, puzzle_hash))
    }

    fn fixed(&self) -> Rc<RMFixed> {
        match self {
            Referee::MyTurn(t) => t.fixed.clone(),
            Referee::TheirTurn(t) => t.fixed.clone(),
        }
    }

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            Referee::MyTurn(t) => t.args_for_this_coin(),
            Referee::TheirTurn(t) => t.args_for_this_coin(),
        }
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            Referee::MyTurn(t) => t.spend_this_coin(),
            Referee::TheirTurn(t) => t.spend_this_coin(),
        }
    }

    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        always_produce_transaction: bool,
        puzzle: Puzzle,
        args: &OnChainRefereeSolution,
        my_mover_share: Amount,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let as_move = matches!(args, OnChainRefereeSolution::Move(_));

        if !as_move && !always_produce_transaction && my_mover_share == Amount::default() {
            return Ok(None);
        }

        let signature = args.get_signature().unwrap_or_default();

        let transaction_solution = args.to_nodeptr(allocator, &self.fixed())?;
        let transaction_bundle = Spend {
            puzzle: puzzle.clone(),
            solution: Program::from_nodeptr(allocator, transaction_solution)?.into(),
            signature,
        };
        let output_coin_string = CoinString::from_parts(
            &coin_string.to_coin_id(),
            &puzzle.sha256tree(allocator),
            &my_mover_share,
        );

        Ok(Some(RefereeOnChainTransaction {
            bundle: transaction_bundle,
            amount: self.fixed().amount.clone(),
            coin: output_coin_string,
        }))
    }

    fn get_my_turn_move_spend(&self) -> Result<Rc<OnChainRefereeMoveData>, Error> {
        let move_spend = match self {
            Referee::TheirTurn(t) => {
                debug!("get_my_turn_move_spend: right phase");
                t.get_move_info()
            }
            Referee::MyTurn(t) => {
                debug!("get_my_turn_move_spend: wrong phase");
                t.get_move_info()
            }
        };

        if let Some(s) = move_spend {
            Ok(s.clone())
        } else {
            Err(Error::StrErr(
                "we need to be after a my turn to get a move transaction".to_string(),
            ))
        }
    }

    pub fn is_my_turn(&self) -> bool {
        matches!(self, Referee::MyTurn(_))
    }

    pub fn processing_my_turn(&self) -> bool {
        matches!(self, Referee::TheirTurn(_))
    }

    pub fn state_number(&self) -> usize {
        match self {
            Referee::MyTurn(t) => t.state_number(),
            Referee::TheirTurn(t) => t.state_number(),
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed().amount.clone()
    }

    pub fn get_game_timeout(&self) -> Timeout {
        self.fixed().timeout.clone()
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed().amount.clone() - self.get_our_current_share()
    }

    pub fn enable_cheating(&self, make_move: &[u8], mover_share: Amount) -> Option<Rc<Referee>> {
        if let Referee::MyTurn(t) = self {
            return Some(Rc::new(Referee::MyTurn(Rc::new(
                t.enable_cheating(make_move, mover_share),
            ))));
        }

        None
    }

    pub fn my_turn_make_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<(Rc<Referee>, GameMoveWireData), Error> {
        debug!("my_turn_make_move: state={}", state_number);
        let (replacement, result) = match self {
            Referee::MyTurn(t) => {
                t.my_turn_make_move(allocator, readable_move, new_entropy, state_number)?
            }
            Referee::TheirTurn(_) => {
                return Err(Error::StrErr(
                    "my_turn_make_move called on TheirTurn referee".to_string(),
                ));
            }
        };
        Ok((Rc::new(replacement), result))
    }

    pub fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        match self {
            Referee::MyTurn(_) => Err(Error::StrErr(
                "receive_readable called on MyTurn referee".to_string(),
            )),
            Referee::TheirTurn(t) => t.receive_readable(allocator, message),
        }
    }

    pub fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<(Option<Rc<Referee>>, TheirTurnMoveResult), Error> {
        debug!("their_turn_move_off_chain: state={}", state_number);
        let (new_self, result) = match self {
            Referee::MyTurn(_) => {
                return Err(Error::StrErr(
                    "their_turn_move_off_chain called on MyTurn referee".to_string(),
                ));
            }
            Referee::TheirTurn(t) => {
                t.their_turn_move_off_chain(allocator, details, state_number, coin)?
            }
        };

        Ok((
            new_self.map(|r| Rc::new(Referee::MyTurn(Rc::new(r)))),
            result,
        ))
    }

    pub fn their_turn_coin_spent(
        &self,
        allocator: &mut AllocEncoder,
        referee_coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<(Option<Rc<Referee>>, TheirTurnCoinSpentResult), Error> {
        debug!("their_turn_coin_spent: state={}", state_number);

        if let Some((_, on_chain_ph, _)) = referee_coin_string.to_parts() {
            if let Some(CoinCondition::CreateCoin(ph, amt)) = conditions
                .iter()
                .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
            {
                let my_on_chain = self.on_chain_referee_puzzle_hash(allocator)?;
                let my_outcome = self.outcome_referee_puzzle_hash(allocator)?;

                if on_chain_ph == my_on_chain && *ph == my_outcome {
                    debug!("repeat: my turn {:?}", self.is_my_turn());

                    return Ok((
                        Some(Rc::new(self.clone())),
                        TheirTurnCoinSpentResult::Expected(
                            self.state_number(),
                            ph.clone(),
                            amt.clone(),
                            None,
                        ),
                    ));
                }
            }
        }

        let rem_conditions = if let Some(CoinCondition::Rem(rem_condition)) = conditions
            .iter()
            .find(|cond| matches!(cond, CoinCondition::Rem(_)))
        {
            rem_condition.to_vec()
        } else {
            Vec::default()
        };

        let mover_share = self.get_our_current_share();

        if rem_conditions.is_empty() {
            let my_reward_coin_string = CoinString::from_parts(
                &referee_coin_string.to_coin_id(),
                &self.fixed().reward_puzzle_hash,
                &mover_share,
            );

            return Ok((
                Some(Rc::new(self.clone())),
                TheirTurnCoinSpentResult::Timedout {
                    my_reward_coin_string: Some(my_reward_coin_string),
                },
            ));
        }

        match self {
            Referee::MyTurn(_) => {
                Err(Error::StrErr(
                    "their_turn_coin_spent called on MyTurn referee".to_string(),
                ))
            }

            Referee::TheirTurn(t) => {
                let (new_ref, res) = t.their_turn_coin_spent(
                    allocator,
                    referee_coin_string,
                    conditions,
                    state_number,
                    &rem_conditions,
                )?;
                let new_ref_rc = new_ref.map(|r| Rc::new(r));
                Ok((new_ref_rc, res))
            }
        }
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.is_my_turn() {
            args.game_move.basic.mover_share.clone()
        } else {
            self.fixed().amount.clone() - args.game_move.basic.mover_share.clone()
        }
    }

    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        debug!("get_transaction_for_timeout turn {}", self.is_my_turn());

        let on_chain_ph = self.on_chain_referee_puzzle_hash(allocator)?;
        let outcome_ph = self.outcome_referee_puzzle_hash(allocator)?;
        let coin_ph = coin_string.to_parts().map(|(_, ph, _)| ph);

        let (puzzle, amount_for_timeout) =
            if coin_ph.as_ref() == Some(&outcome_ph) && coin_ph.as_ref() != Some(&on_chain_ph) {
                debug!(
                    "TIMEOUT: coin matches outcome_ph {:?}, using spend_this_coin args",
                    outcome_ph
                );
                (self.outcome_referee_puzzle(allocator)?, self.fixed().amount.clone())
            } else {
                debug!(
                    "TIMEOUT: coin matches on_chain_ph {:?} (or fallback)",
                    on_chain_ph
                );
                (self.on_chain_referee_puzzle(allocator)?, self.fixed().amount.clone())
            };

        let args = if coin_ph.as_ref() == Some(&outcome_ph) && coin_ph.as_ref() != Some(&on_chain_ph) {
            self.spend_this_coin()
        } else {
            self.args_for_this_coin()
        };
        let mover_share = args.game_move.basic.mover_share.clone();
        let waiter_share = Amount::new(
            self.fixed().amount.to_u64().saturating_sub(mover_share.to_u64()),
        );

        let i_am_mover = args.mover_pubkey == self.fixed().my_identity.public_key;
        let (mover_payout_ph, waiter_payout_ph) = if i_am_mover {
            (self.fixed().reward_puzzle_hash.clone(), self.fixed().their_reward_puzzle_hash.clone())
        } else {
            (self.fixed().their_reward_puzzle_hash.clone(), self.fixed().reward_puzzle_hash.clone())
        };

        let (my_share, their_share) = if i_am_mover {
            (mover_share.clone(), waiter_share.clone())
        } else {
            (waiter_share.clone(), mover_share.clone())
        };

        let mut aggregate_signature = Aggsig::default();
        if my_share > Amount::default() {
            aggregate_signature += self.fixed().my_reward_payout_signature.clone();
        }
        if their_share > Amount::default() {
            aggregate_signature += self.fixed().their_reward_payout_signature.clone();
        }

        self.get_transaction(
            allocator,
            coin_string,
            false,
            puzzle,
            &OnChainRefereeSolution::Timeout {
                mover_payout_ph,
                waiter_payout_ph,
                aggregate_signature,
            },
            amount_for_timeout,
        )
    }

    pub fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)
    }

    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)
    }

    pub fn on_chain_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed().referee_coin_puzzle_hash, &args)
    }

    pub fn outcome_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed().referee_coin_puzzle_hash, &args)
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        _on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        let my_turn_spend = self.get_my_turn_move_spend()?;
        let args = my_turn_spend.before_args.clone();
        let spend_puzzle =
            curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)?;

        let args_list = OnChainRefereeSolution::Move(Rc::new(my_turn_spend.to_move(
            allocator,
            &self.fixed(),
            coin_string,
        )?));

        if let Some(transaction) = self.get_transaction(
            allocator,
            coin_string,
            true,
            spend_puzzle,
            &args_list,
            self.get_our_current_share(),
        )? {
            Ok(transaction)
        } else {
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }
}
