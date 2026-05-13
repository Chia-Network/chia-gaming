pub mod my_turn;
pub mod their_turn;
pub mod types;

use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{ReadableMove, ValidationInfo};
use crate::common::standard_coin::{sign_reward_payout, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinString, Error, Hash, Program, PublicKey,
    Puzzle, PuzzleHash, Spend, Timeout,
};
use crate::referee::my_turn::MyTurnReferee;
use crate::referee::their_turn::TheirTurnReferee;
use crate::referee::types::{
    canonical_atom_from_usize, curry_referee_puzzle, curry_referee_puzzle_hash, GameMoveDetails,
    GameMoveStateInfo, GameMoveWireData, OnChainRefereeMoveData, OnChainRefereeSolution, RMFixed,
    RefereePuzzleArgs, TheirTurnCoinSpentResult, TheirTurnMoveResult, ValidationInfoHash,
};

pub(crate) struct RefereeInitialSetup {
    pub fixed: Rc<RMFixed>,
    pub ref_puzzle_args: Rc<RefereePuzzleArgs>,
    pub puzzle_hash: PuzzleHash,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn referee_initial_setup(
    allocator: &mut AllocEncoder,
    referee_coin_puzzle: Puzzle,
    referee_coin_puzzle_hash: PuzzleHash,
    game_start_info: &Rc<GameStartInfo>,
    my_identity: ChiaIdentity,
    their_pubkey: &PublicKey,
    their_reward_puzzle_hash: &PuzzleHash,
    their_reward_payout_signature: &Aggsig,
    reward_puzzle_hash: &PuzzleHash,
    nonce: u64,
    agg_sig_me_additional_data: &Hash,
) -> Result<RefereeInitialSetup, Error> {
    let initial_move = GameMoveStateInfo {
        mover_share: game_start_info.initial_mover_share.clone(),
        move_made: game_start_info.initial_move.clone(),
        max_move_size_raw: canonical_atom_from_usize(game_start_info.initial_max_move_size),
        max_move_size: game_start_info.initial_max_move_size,
    };
    let my_turn = game_start_info.game_handler.is_my_turn();

    let fixed = Rc::new(RMFixed {
        referee_coin_puzzle,
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
    let vi_hash =
        ValidationInfo::new_state_update(allocator, ip.clone(), game_start_info.initial_state.p());
    let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
        &fixed,
        &GameMoveDetails {
            basic: initial_move,
            validation_program_hash: ValidationInfoHash::Hash(vi_hash.hash().clone()),
        },
        ValidationInfoHash::Initial,
        ip,
        my_turn,
    ));
    if my_turn {
        game_assert_eq!(
            fixed.my_identity.public_key,
            ref_puzzle_args.mover_pubkey,
            "referee_initial_setup: my_turn but mover_pubkey != my pubkey"
        );
    } else {
        game_assert_eq!(
            fixed.their_referee_pubkey,
            ref_puzzle_args.mover_pubkey,
            "referee_initial_setup: their_turn but mover_pubkey != their pubkey"
        );
    }
    let puzzle_hash =
        curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

    Ok(RefereeInitialSetup {
        fixed,
        ref_puzzle_args,
        puzzle_hash,
    })
}

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
        nonce: u64,
        agg_sig_me_additional_data: &Hash,
        state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        if game_start_info.game_handler.is_my_turn() {
            let (r, ph) = MyTurnReferee::new(
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
            Ok((Referee::MyTurn(Rc::new(r)), ph))
        } else {
            let (r, ph) = TheirTurnReferee::new(
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
            Ok((Referee::TheirTurn(Rc::new(r)), ph))
        }
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

    pub fn get_max_move_size(&self) -> usize {
        self.spend_this_coin().game_move.basic.max_move_size
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
        _coin_string: &CoinString,
        always_produce_transaction: bool,
        puzzle: Puzzle,
        args: &OnChainRefereeSolution,
        my_mover_share: Amount,
    ) -> Result<Option<Spend>, Error> {
        let as_move = matches!(args, OnChainRefereeSolution::Move(_));

        if !as_move && !always_produce_transaction && my_mover_share == Amount::default() {
            return Ok(None);
        }

        let signature = args.get_signature().unwrap_or_default();

        let transaction_solution = args.to_nodeptr(allocator, &self.fixed())?;
        Ok(Some(Spend {
            puzzle: puzzle.clone(),
            solution: Program::from_nodeptr(allocator, transaction_solution)?.into(),
            signature,
        }))
    }

    fn get_move_info(&self) -> Option<Rc<OnChainRefereeMoveData>> {
        match self {
            Referee::MyTurn(t) => t.get_move_info(),
            Referee::TheirTurn(t) => t.get_move_info(),
        }
    }

    fn get_last_move_spend(&self) -> Result<Rc<OnChainRefereeMoveData>, Error> {
        self.get_move_info().ok_or_else(|| {
            Error::StrErr("we need to be after a my turn to get a move transaction".to_string())
        })
    }

    pub fn is_my_turn(&self) -> bool {
        matches!(self, Referee::MyTurn(_))
    }

    pub fn is_game_over(&self) -> bool {
        match self {
            Referee::MyTurn(r) => r.get_game_handler().is_none(),
            Referee::TheirTurn(r) => r.get_game_handler().is_none(),
        }
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

    pub fn get_their_current_share(&self) -> Result<Amount, Error> {
        self.fixed()
            .amount
            .checked_sub(&self.get_our_current_share()?)
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
        let (replacement, result) = match self {
            Referee::MyTurn(t) => {
                t.my_turn_make_move(allocator, readable_move, new_entropy, state_number)?
            }
            Referee::TheirTurn(_) => {
                return Err(Error::Channel(
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
            Referee::MyTurn(_) => Err(Error::Channel(
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
    ) -> Result<(Option<Rc<Referee>>, TheirTurnMoveResult), Error> {
        let (new_self, result) = match self {
            Referee::MyTurn(_) => {
                return Err(Error::Channel(
                    "their_turn_move_off_chain called on MyTurn referee".to_string(),
                ));
            }
            Referee::TheirTurn(t) => {
                t.their_turn_move_off_chain(allocator, details, state_number)?
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
        if let Some((_, on_chain_ph, _)) = referee_coin_string.to_parts() {
            if let Some(CoinCondition::CreateCoin(ph, amt)) = conditions
                .iter()
                .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
            {
                let my_on_chain = self.on_chain_referee_puzzle_hash(allocator)?;
                let my_outcome = self.outcome_referee_puzzle_hash(allocator)?;

                if on_chain_ph == my_on_chain && *ph == my_outcome {
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

        let mover_share = self.get_our_current_share()?;

        if rem_conditions.is_empty() {
            let my_reward_coin_string = if mover_share > Amount::default() {
                Some(CoinString::from_parts(
                    &referee_coin_string.to_coin_id(),
                    &self.fixed().reward_puzzle_hash,
                    &mover_share,
                ))
            } else {
                None
            };

            return Ok((
                Some(Rc::new(self.clone())),
                TheirTurnCoinSpentResult::Timedout {
                    my_reward_coin_string,
                },
            ));
        }

        match self {
            Referee::MyTurn(_) => Err(Error::Channel(
                "their_turn_coin_spent called on MyTurn referee".to_string(),
            )),

            Referee::TheirTurn(t) => {
                let (new_ref, res) = t.their_turn_coin_spent(
                    allocator,
                    referee_coin_string,
                    conditions,
                    state_number,
                    &rem_conditions,
                )?;
                let new_ref_rc = new_ref.map(Rc::new);
                Ok((new_ref_rc, res))
            }
        }
    }

    pub fn get_our_current_share(&self) -> Result<Amount, Error> {
        let args = self.spend_this_coin();
        if self.is_my_turn() {
            Ok(args.game_move.basic.mover_share.clone())
        } else {
            self.fixed()
                .amount
                .checked_sub(&args.game_move.basic.mover_share)
        }
    }

    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<Spend>, Error> {
        let on_chain_ph = self.on_chain_referee_puzzle_hash(allocator)?;
        let outcome_ph = self.outcome_referee_puzzle_hash(allocator)?;
        let coin_ph = coin_string.to_parts().map(|(_, ph, _)| ph);

        let (puzzle, amount_for_timeout) =
            if coin_ph.as_ref() == Some(&outcome_ph) && coin_ph.as_ref() != Some(&on_chain_ph) {
                (
                    self.outcome_referee_puzzle(allocator)?,
                    self.fixed().amount.clone(),
                )
            } else {
                (
                    self.on_chain_referee_puzzle(allocator)?,
                    self.fixed().amount.clone(),
                )
            };

        let args =
            if coin_ph.as_ref() == Some(&outcome_ph) && coin_ph.as_ref() != Some(&on_chain_ph) {
                self.spend_this_coin()
            } else {
                self.args_for_this_coin()
            };
        let mover_share = args.game_move.basic.mover_share.clone();
        let waiter_share = self.fixed().amount.checked_sub(&mover_share)?;

        let i_am_mover = args.mover_pubkey == self.fixed().my_identity.public_key;
        let (my_ph, their_ph) = if i_am_mover {
            (
                self.fixed().reward_puzzle_hash.clone(),
                self.fixed().their_reward_puzzle_hash.clone(),
            )
        } else {
            (
                self.fixed().their_reward_puzzle_hash.clone(),
                self.fixed().reward_puzzle_hash.clone(),
            )
        };

        let (my_share, their_share) = if i_am_mover {
            (mover_share.clone(), waiter_share.clone())
        } else {
            (waiter_share.clone(), mover_share.clone())
        };

        let mover_payout_ph = if mover_share > Amount::default() {
            Some(my_ph)
        } else {
            None
        };
        let waiter_payout_ph = if waiter_share > Amount::default() {
            Some(their_ph)
        } else {
            None
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
    ) -> Result<Spend, Error> {
        let my_turn_spend = self.get_last_move_spend()?;
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
            self.get_our_current_share()?,
        )? {
            Ok(transaction)
        } else {
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }
}
