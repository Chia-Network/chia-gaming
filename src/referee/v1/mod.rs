pub mod my_turn;
pub mod their_turn;
pub mod types;

use std::rc::Rc;

use log::debug;

use crate::channel_handler::types::{Evidence, ReadableMove};
use crate::channel_handler::v1::game_start_info::GameStartInfo;
use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    AllocEncoder, Amount, CoinCondition, CoinString, Error, Hash, Program, Puzzle, PuzzleHash,
    Sha256Input, Sha256tree, Spend,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveStateInfo, GameMoveWireData, RefereeOnChainTransaction,
    TheirTurnCoinSpentResult, TheirTurnMoveResult,
};
use crate::referee::v1::my_turn::MyTurnReferee;
use crate::referee::v1::their_turn::TheirTurnReferee;
use crate::referee::v1::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, OnChainRefereeMoveData,
    OnChainRefereeSolution, RMFixed, RefereePuzzleArgs,
};
use crate::referee::RewindResult;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub enum RefereeByTurn {
    MyTurn(Rc<MyTurnReferee>),
    TheirTurn(Rc<TheirTurnReferee>),
}

#[allow(dead_code)]
pub type RefereePuzzleArgsRef = Rc<RefereePuzzleArgs>;

use crate::referee::RefereeInterface;

#[allow(dead_code)]
impl RefereeByTurn {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize,
        agg_sig_me_additional_data: &Hash,
        state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        //debug!("referee maker: game start {:?}", game_start_info);
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
            max_move_size: 0, // unused in v1
        };
        let my_turn = game_start_info.game_handler.is_my_turn();
        //debug!("referee maker: my_turn {my_turn}");

        let fixed_info = Rc::new(RMFixed {
            referee_coin_puzzle: referee_coin_puzzle.clone(),
            referee_coin_puzzle_hash: referee_coin_puzzle_hash.clone(),
            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_identity: my_identity.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce,
            agg_sig_me_additional_data: agg_sig_me_additional_data.clone(),
        });

        // TODO: Revisit how we create initial_move
        let is_hash = game_start_info
            .initial_state
            .sha256tree(allocator)
            .hash()
            .clone();
        let ip_hash = game_start_info
            .initial_validation_program
            .sha256tree(allocator)
            .hash()
            .clone();
        let vi_hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&is_hash),
            Sha256Input::Hash(&ip_hash),
        ])
        .hash();
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &fixed_info,
            &GameMoveDetails {
                basic: GameMoveStateInfo {
                    mover_share: game_start_info.initial_mover_share.clone(),
                    max_move_size: game_start_info.initial_max_move_size,
                    ..initial_move.clone()
                },
                validation_info_hash: vi_hash.clone(),
            },
            None,
            game_start_info.initial_validation_program.clone(),
            my_turn,
        ));
        // If this reflects my turn, then we will spend the next parameter set.
        if my_turn {
            assert_eq!(
                fixed_info.my_identity.puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
            );
        } else {
            assert_eq!(
                fixed_info.their_referee_puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
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
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (RefereeByTurn::MyTurn(Rc::new(tr.0)), tr.1)
        } else {
            let tr = TheirTurnReferee::new(
                allocator,
                referee_coin_puzzle,
                referee_coin_puzzle_hash,
                game_start_info,
                my_identity,
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (RefereeByTurn::TheirTurn(Rc::new(tr.0)), tr.1)
        };
        Ok((turn, puzzle_hash))
    }

    fn fixed(&self) -> Rc<RMFixed> {
        match self {
            RefereeByTurn::MyTurn(t) => t.fixed.clone(),
            RefereeByTurn::TheirTurn(t) => t.fixed.clone(),
        }
    }

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeByTurn::MyTurn(t) => t.args_for_this_coin(),
            RefereeByTurn::TheirTurn(t) => t.args_for_this_coin(),
        }
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeByTurn::MyTurn(t) => t.spend_this_coin(),
            RefereeByTurn::TheirTurn(t) => t.spend_this_coin(),
        }
    }

    /// Get transaction can do a couple of things which are very different now.in the
    /// as_move=true case, the returned transaction makes the move that leads to the
    /// spend_this_coin puzzle hash, so the mover puzzle hash is ours and the waiter puzzle
    /// hash is theirs.  The move data is the move data that was originally generated by our
    /// my turn driver.  Thus, we must be a their turn referee.
    ///
    /// In the slash case (as_move=false), the move is ours (mover puzzle hash = my puzzle hash
    /// but it's "about" the their turn that has the opposite orientation (due to having been
    /// a their turn, so we'll need to synthesize an our turn referee puzzle args that contains
    /// their turn.
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

        // The transaction solution is not the same as the solution for the
        // inner puzzle as we take additional move or slash data.
        //
        // OnChainRefereeSolution encodes this properly.
        let transaction_solution = args.to_nodeptr(allocator, &self.fixed())?;
        debug!("transaction solution inputs {args:?}");
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

    fn generate_ancestor_list(&self, ref_list: &mut Vec<Rc<RefereeByTurn>>) {
        match self {
            RefereeByTurn::MyTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let their_turn = RefereeByTurn::TheirTurn(p.clone());
                    ref_list.push(Rc::new(their_turn.clone()));
                    their_turn.generate_ancestor_list(ref_list);
                }
            }
            RefereeByTurn::TheirTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let my_turn = RefereeByTurn::MyTurn(p.clone());
                    ref_list.push(Rc::new(my_turn.clone()));
                    my_turn.generate_ancestor_list(ref_list);
                }
            }
        }
    }

    fn get_my_turn_move_spend(&self) -> Result<Rc<OnChainRefereeMoveData>, Error> {
        let move_spend = match self {
            RefereeByTurn::TheirTurn(t) => {
                debug!("get_my_turn_move_spend: right phase");
                t.get_move_info()
            }
            RefereeByTurn::MyTurn(t) => {
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
}

impl RefereeInterface for RefereeByTurn {
    fn version(&self) -> usize {
        1
    }
    fn is_my_turn(&self) -> bool {
        matches!(self, RefereeByTurn::MyTurn(_))
    }

    fn processing_my_turn(&self) -> bool {
        matches!(self, RefereeByTurn::TheirTurn(_))
    }

    fn state_number(&self) -> usize {
        match self {
            RefereeByTurn::MyTurn(t) => t.state_number(),
            RefereeByTurn::TheirTurn(t) => t.state_number(),
        }
    }

    fn get_amount(&self) -> Amount {
        self.fixed().amount.clone()
    }

    fn get_their_current_share(&self) -> Amount {
        self.fixed().amount.clone() - self.get_our_current_share()
    }

    fn suitable_redo(
        &self,
        _allocator: &mut AllocEncoder,
        _coin: &CoinString,
        _ph: &PuzzleHash,
    ) -> Result<bool, Error> {
        Ok(!self.is_my_turn())
    }

    fn enable_cheating(&self, make_move: &[u8]) -> Option<Rc<dyn RefereeInterface>> {
        if let RefereeByTurn::MyTurn(t) = self {
            return Some(Rc::new(RefereeByTurn::MyTurn(Rc::new(
                t.enable_cheating(make_move),
            ))));
        }

        None
    }

    fn my_turn_make_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, GameMoveWireData), Error> {
        debug!("my_turn_make_move: state={}", state_number);
        let (replacement, result) = match self {
            RefereeByTurn::MyTurn(t) => {
                t.my_turn_make_move(allocator, readable_move, new_entropy, state_number)?
            }
            RefereeByTurn::TheirTurn(_) => {
                todo!();
            }
        };
        Ok((Rc::new(replacement), result))
    }

    fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        match self {
            RefereeByTurn::MyTurn(_t) => todo!(),
            RefereeByTurn::TheirTurn(t) => t.receive_readable(allocator, message),
        }
    }

    fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnMoveResult), Error> {
        debug!("their_turn_move_off_chain: state={}", state_number);
        let (new_self, result) = match self {
            RefereeByTurn::MyTurn(_) => {
                todo!();
            }
            RefereeByTurn::TheirTurn(t) => {
                t.their_turn_move_off_chain(allocator, details, state_number, coin)?
            }
        };

        Ok((
            new_self.map(|r| {
                let rc: Rc<dyn RefereeInterface> = Rc::new(RefereeByTurn::MyTurn(Rc::new(r)));
                rc
            }),
            result,
        ))
    }

    fn their_turn_coin_spent(
        &self,
        allocator: &mut AllocEncoder,
        referee_coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnCoinSpentResult), Error> {
        debug!("their_turn_coin_spent: state={}", state_number);
        debug!("on chain coin {:?}", referee_coin_string.to_parts());

        // XXX Revisit this in conjuction with rewind.  There is a better way to do this.
        if let Some((_, on_chain_ph, _)) = referee_coin_string.to_parts() {
            if let Some(CoinCondition::CreateCoin(ph, amt)) = conditions
                .iter()
                .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
            {
                debug!("on chain puzzle hash {ph:?}");
                let my_on_chain = self.on_chain_referee_puzzle_hash(allocator)?;
                debug!("{} my on chain {my_on_chain:?}", self.is_my_turn());
                let my_outcome = self.outcome_referee_puzzle_hash(allocator)?;
                debug!("{} my outcome {my_outcome:?}", self.is_my_turn());

                if on_chain_ph == my_on_chain {
                    debug!("repeat: my turn {:?}", self.is_my_turn());
                    assert_eq!(*ph, my_outcome);

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
        };

        debug!("rems in spend {conditions:?}");

        // Read parameters off conditions
        let rem_conditions = if let Some(CoinCondition::Rem(rem_condition)) = conditions
            .iter()
            .find(|cond| matches!(cond, CoinCondition::Rem(_)))
        {
            // Got rem condition
            rem_condition.to_vec()
        } else {
            Vec::default()
        };

        let mover_share = self.get_our_current_share();

        // Check properties of conditions
        if rem_conditions.is_empty() {
            // Timeout case
            // Return enum timeout and we give the coin string of our reward
            // coin if any.
            let my_reward_coin_string = CoinString::from_parts(
                &referee_coin_string.to_coin_id(),
                &self.fixed().my_identity.puzzle_hash,
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
            // We could be called on to fast forward the most recent transaction
            // we ourselves took.  check_their_turn_coin_spent will return an
            // error if it was asked to do a non-fast-forward their turn spend.
            RefereeByTurn::MyTurn(_t) => {
                todo!();
            }

            RefereeByTurn::TheirTurn(t) => {
                let (new_ref, res) = t.their_turn_coin_spent(
                    allocator,
                    referee_coin_string,
                    conditions,
                    state_number,
                    &rem_conditions,
                )?;
                let new_ref_rc = new_ref.map(|r| {
                    let rc: Rc<dyn RefereeInterface> = Rc::new(r);
                    rc
                });
                Ok((new_ref_rc, res))
            }
        }
    }

    fn rewind(
        &self,
        allocator: &mut AllocEncoder,
        _myself: Rc<dyn RefereeInterface>,
        coin: &CoinString,
        puzzle_hash: &PuzzleHash,
    ) -> Result<RewindResult, Error> {
        let mut ancestors = vec![];
        self.generate_ancestor_list(&mut ancestors);

        if *puzzle_hash == self.outcome_referee_puzzle_hash(allocator)? {
            debug!("my outcome");
            todo!();
        }

        if *puzzle_hash == self.on_chain_referee_puzzle_hash(allocator)? {
            debug!("my on chain");
            todo!();
        }

        for old_referee in ancestors.iter() {
            let start_args = old_referee.args_for_this_coin();
            let end_args = old_referee.spend_this_coin();
            debug!(
                "end   puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &old_referee.fixed().referee_coin_puzzle_hash,
                    &end_args
                )
            );
            debug!(
                "state {} is_my_turn {}",
                old_referee.state_number(),
                old_referee.is_my_turn()
            );
            debug!("game move at end {:?}", end_args.game_move.basic.move_made);
            debug!(
                "game move at start {:?}",
                start_args.game_move.basic.move_made
            );
            debug!(
                "start puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &old_referee.fixed().referee_coin_puzzle_hash,
                    &start_args
                )
            );
        }

        let mut old_end = None;
        // Check whether our ancestors have consistent hashes stored.
        // The first to second move transition should have the same start hash but
        // end in a different hash and each other start should have the same hash
        // as the previous end.
        for old_referee in ancestors.iter().rev() {
            let start_args = old_referee.args_for_this_coin();
            let end_args = old_referee.spend_this_coin();
            let start_hash = curry_referee_puzzle_hash(
                allocator,
                &old_referee.fixed().referee_coin_puzzle_hash,
                &start_args,
            )?;
            let end_hash = curry_referee_puzzle_hash(
                allocator,
                &old_referee.fixed().referee_coin_puzzle_hash,
                &end_args,
            )?;
            debug!("have old end {old_end:?} checking {start_hash:?}:{end_hash:?}");
            if let Some(e) = &old_end {
                assert_eq!(start_hash, *e);
            }
            old_end = Some(end_hash.clone());
        }

        for old_referee in ancestors.iter() {
            let origin_puzzle_hash = old_referee.on_chain_referee_puzzle_hash(allocator)?;
            let destination_puzzle_hash = old_referee.outcome_referee_puzzle_hash(allocator)?;

            debug!(
                "referee rewind: {} my turn {} try state {origin_puzzle_hash:?} => {destination_puzzle_hash:?} want {puzzle_hash:?}",
                old_referee.state_number(),
                old_referee.is_my_turn(),
            );
            if *puzzle_hash == origin_puzzle_hash {
                // One farther down so we're in a their turn after the turn we took.
                let to_use = old_referee.clone();
                let transaction = if !old_referee.is_my_turn() {
                    debug!("will redo: {}", to_use.state_number());
                    Some(to_use.get_transaction_for_move(allocator, coin, true)?)
                } else {
                    None
                };
                let to_return = old_referee.clone();
                return Ok(RewindResult {
                    outcome_puzzle_hash: to_return.outcome_referee_puzzle_hash(allocator)?,
                    state_number: Some(to_return.state_number()),
                    new_referee: Some(to_return),
                    version: 1,
                    transaction: transaction,
                });
            }
        }

        debug!("referee rewind: no matching state");
        debug!("still in state {:?}", self.state_number());

        Ok(RewindResult {
            new_referee: None,
            version: 1,
            state_number: Some(self.state_number()),
            transaction: None,
            outcome_puzzle_hash: self.outcome_referee_puzzle_hash(allocator)?,
        })
    }

    fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.is_my_turn() {
            args.game_move.basic.mover_share.clone()
        } else {
            self.fixed().amount.clone() - args.game_move.basic.mover_share.clone()
        }
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    fn get_transaction_for_timeout(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        debug!("get_transaction_for_timeout turn {}", self.is_my_turn());
        debug!(
            "mover share at start of action   {:?}",
            self.args_for_this_coin().game_move.basic.mover_share
        );
        debug!(
            "mover share at end   of action   {:?}",
            self.spend_this_coin().game_move.basic.mover_share
        );

        let puzzle = self.on_chain_referee_puzzle(allocator)?;

        self.get_transaction(
            allocator,
            coin_string,
            false,
            puzzle,
            &OnChainRefereeSolution::Timeout,
            self.fixed().amount.clone(),
        )
    }

    fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)
    }

    fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)
    }

    fn on_chain_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed().referee_coin_puzzle_hash, &args)
    }

    fn outcome_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed().referee_coin_puzzle_hash, &args)
    }

    /// The move transaction works like this:
    ///
    /// The referee puzzle has the hash of the puzzle of another locking coin,
    /// possibly the standard coin, and uses that to secure against another person
    /// commanding it.  This isn't the be confused with the coin that serves as the
    /// parent of the referee coin which is also assumed to be a standard puzzle
    /// coin.
    ///
    /// The inner coin, assuming it is a standard coin, takes the puzzle reveal
    /// for the above puzzle and the solution for that inner puzzle as the last two
    /// arguments to the move case of how it's invoked.
    ///
    /// The output conditions to step it are therefore built into those conditions
    /// which needs to include the puzzle hash of the target state of the referee
    /// (their move, the state precipitated by our move set as the current game
    /// state).
    ///
    /// We do the spend of the inner puzzle to that puzzle hash to progress the
    /// referee coin.
    ///
    /// One consequence of this is that we must sign it with the synthetic private
    /// key as the standard puzzle embeds a synthetic public key based on it.
    ///
    /// In all cases, we're spending a referee coin that already exists.  The use
    /// of the mover coin here is purely to take advantage of its puzzle to provide
    /// a signature requirement.
    fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // We can only do a move to replicate our turn.
        let my_turn_spend = self.get_my_turn_move_spend()?;
        let args = my_turn_spend.before_args.clone();
        let spend_puzzle =
            curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &args)?;

        // Get the puzzle hash for the next referee state.
        // This reflects a "their turn" state with the updated state from the
        // game handler returned by consuming our move.  This is assumed to
        // have been done by consuming the move in a different method call.

        // Get the current state of the referee on chain.  This reflects the
        // current state at the time the move was made.
        // The current referee uses the previous state since we have already
        // taken the move.
        if let Some((_, ph, _)) = coin_string.to_parts() {
            if on_chain {
                let start_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed().referee_coin_puzzle_hash,
                    &args,
                )?;
                debug!("spend puzzle hash {ph:?}");
                debug!("this coin start {start_ph:?}");
                // assert_eq!(ph, start_ph);
            }
        }

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
            // Return err
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }

    fn check_their_turn_for_slash(
        &self,
        _allocator: &mut AllocEncoder,
        _evidence: Evidence,
        _coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        // Will need to route this.
        todo!();
    }
}

#[allow(dead_code)]
pub type RefereeMaker = RefereeByTurn;
