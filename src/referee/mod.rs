pub mod my_turn;
pub mod their_turn;
pub mod types;

use std::rc::Rc;

use clvm_traits::ToClvm;

use log::debug;

use crate::channel_handler::types::{GameStartInfo, ReadableMove, StateUpdateProgram};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{standard_solution_partial, ChiaIdentity};
use crate::common::types::{
    AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinString, Error, Hash, IntoErr,
    Program, Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend,
};
use crate::referee::my_turn::MyTurnReferee;
use crate::referee::their_turn::TheirTurnReferee;
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, GameMoveDetails, GameMoveStateInfo,
    GameMoveWireData, IdentityCoinAndSolution, OnChainRefereeMove, OnChainRefereeSolution, RMFixed,
    RefereeOnChainTransaction, RefereePuzzleArgs, SlashOutcome, TheirTurnCoinSpentResult,
    TheirTurnMoveResult,
};

#[derive(Clone, Debug)]
pub enum RefereeByTurn {
    MyTurn(Rc<MyTurnReferee>),
    TheirTurn(Rc<TheirTurnReferee>),
}

pub type StateUpdateProgramRef = Rc<RefereePuzzleArgs<StateUpdateProgram>>;

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
                    mover_share: Amount::default(),
                    ..initial_move.clone()
                },
                validation_info_hash: vi_hash.clone(),
            },
            game_start_info.initial_max_move_size,
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

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs<StateUpdateProgram>> {
        match self {
            RefereeByTurn::MyTurn(t) => Rc::new(t.args_for_this_coin().neutralize()),
            RefereeByTurn::TheirTurn(t) => Rc::new(t.args_for_this_coin().neutralize()),
        }
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs<StateUpdateProgram>> {
        match self {
            RefereeByTurn::MyTurn(t) => Rc::new(t.spend_this_coin().neutralize()),
            RefereeByTurn::TheirTurn(t) => Rc::new(t.spend_this_coin().neutralize()),
        }
    }

    pub fn is_my_turn(&self) -> bool {
        matches!(self, RefereeByTurn::MyTurn(_))
    }

    pub fn processing_my_turn(&self) -> bool {
        matches!(self, RefereeByTurn::TheirTurn(_))
    }

    pub fn state_number(&self) -> usize {
        match self {
            RefereeByTurn::MyTurn(t) => t.state_number(),
            RefereeByTurn::TheirTurn(t) => t.state_number(),
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed().amount.clone()
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed().amount.clone() - self.get_our_current_share()
    }

    pub fn fixed(&self) -> Rc<RMFixed> {
        match self {
            RefereeByTurn::MyTurn(t) => t.fixed.clone(),
            RefereeByTurn::TheirTurn(t) => t.fixed.clone(),
        }
    }

    pub fn enable_cheating(&self, make_move: &[u8]) -> Option<RefereeByTurn> {
        if let RefereeByTurn::MyTurn(t) = self {
            return Some(RefereeByTurn::MyTurn(Rc::new(t.enable_cheating(make_move))));
        }

        None
    }

    pub fn stored_versions(&self) -> Vec<(StateUpdateProgramRef, StateUpdateProgramRef, usize)> {
        let mut alist = vec![];
        self.generate_ancestor_list(&mut alist);
        alist
            .into_iter()
            .rev()
            .map(|a| {
                (
                    Rc::new(a.args_for_this_coin().neutralize()),
                    Rc::new(a.spend_this_coin().neutralize()),
                    a.state_number(),
                )
            })
            .collect()
    }

    pub fn my_turn_make_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<(RefereeByTurn, GameMoveWireData), Error> {
        let (replacement, result) = match self {
            RefereeByTurn::MyTurn(t) => {
                t.my_turn_make_move(allocator, readable_move, new_entropy, state_number)?
            }
            RefereeByTurn::TheirTurn(_) => {
                todo!();
            }
        };
        Ok((replacement, result))
    }

    pub fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        match self {
            RefereeByTurn::MyTurn(_t) => todo!(),
            RefereeByTurn::TheirTurn(t) => t.receive_readable(allocator, message),
        }
    }

    pub fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<(Option<RefereeByTurn>, TheirTurnMoveResult), Error> {
        let (new_self, result) = match self {
            RefereeByTurn::MyTurn(_) => {
                todo!();
            }
            RefereeByTurn::TheirTurn(t) => {
                t.their_turn_move_off_chain(allocator, details, state_number, coin)?
            }
        };

        Ok((new_self.map(Rc::new).map(RefereeByTurn::MyTurn), result))
    }

    pub fn their_turn_coin_spent(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<(Option<RefereeByTurn>, TheirTurnCoinSpentResult), Error> {
        match self {
            // We could be called on to fast forward the most recent transaction
            // we ourselves took.  check_their_turn_coin_spent will return an
            // error if it was asked to do a non-fast-forward their turn spend.
            RefereeByTurn::MyTurn(_t) => {
                let after_puzzle_hash = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed().referee_coin_puzzle_hash,
                    &self.spend_this_coin(),
                )?;

                // XXX Revisit this in conjuction with rewind.  There is a better way to do this.
                let repeat = if let Some(CoinCondition::CreateCoin(ph, _amt)) = conditions
                    .iter()
                    .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
                {
                    after_puzzle_hash == *ph
                } else {
                    false
                };

                if repeat {
                    debug!("repeat spend {after_puzzle_hash:?}");
                    return Ok((
                        None,
                        TheirTurnCoinSpentResult::Slash(Box::new(SlashOutcome::NoReward)),
                    ));
                }

                todo!();
            }
            RefereeByTurn::TheirTurn(t) => {
                t.their_turn_coin_spent(t.clone(), allocator, coin_string, conditions, state_number)
            }
        }
    }

    pub fn generate_ancestor_list(&self, ref_list: &mut Vec<RefereeByTurn>) {
        match self {
            RefereeByTurn::MyTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let their_turn = RefereeByTurn::TheirTurn(p.clone());
                    ref_list.push(their_turn.clone());
                    their_turn.generate_ancestor_list(ref_list);
                }
            }
            RefereeByTurn::TheirTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let my_turn = RefereeByTurn::MyTurn(p.clone());
                    ref_list.push(my_turn.clone());
                    my_turn.generate_ancestor_list(ref_list);
                }
            }
        }
    }

    pub fn rewind(
        &self,
        allocator: &mut AllocEncoder,
        puzzle_hash: &PuzzleHash,
    ) -> Result<Option<(RefereeByTurn, usize)>, Error> {
        let mut ancestors = vec![];
        self.generate_ancestor_list(&mut ancestors);

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
        for old_referee in ancestors.iter().rev().skip(1) {
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
            let have_puzzle_hash = curry_referee_puzzle_hash(
                allocator,
                &old_referee.fixed().referee_coin_puzzle_hash,
                &old_referee.args_for_this_coin(),
            )?;
            debug!(
                "referee rewind: {} my turn {} try state {have_puzzle_hash:?} want {puzzle_hash:?}",
                old_referee.state_number(),
                old_referee.is_my_turn(),
            );
            if *puzzle_hash == have_puzzle_hash && old_referee.is_my_turn() {
                let state_number = old_referee.state_number();
                return Ok(Some((old_referee.clone(), state_number)));
            }
        }

        debug!("referee rewind: no matching state");
        debug!("still in state {:?}", self.state_number());
        Ok(None)
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed().amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
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

        let targs = self.spend_this_coin();
        let puzzle = curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &targs)?;

        self.get_transaction(
            allocator,
            coin_string,
            false,
            puzzle,
            &targs.neutralize(),
            &OnChainRefereeSolution::Timeout,
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

    // Ensure this returns
    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        always_produce_transaction: bool,
        puzzle: Puzzle,
        targs: &RefereePuzzleArgs<StateUpdateProgram>,
        args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let our_move = self.is_my_turn();

        let my_mover_share = if our_move {
            targs.game_move.basic.mover_share.clone()
        } else {
            self.fixed().amount.clone() - targs.game_move.basic.mover_share.clone()
        };

        if always_produce_transaction || my_mover_share != Amount::default() {
            let signature = args.get_signature().unwrap_or_default();

            // The transaction solution is not the same as the solution for the
            // inner puzzle as we take additional move or slash data.
            //
            // OnChainRefereeSolution encodes this properly.
            let transaction_solution = args.to_clvm(allocator).into_gen()?;
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
            return Ok(Some(RefereeOnChainTransaction {
                bundle: transaction_bundle,
                amount: self.fixed().amount.clone(),
                coin: output_coin_string,
            }));
        }

        // Zero mover share case.
        Ok(None)
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
    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // We can only do a move to replicate our turn.
        let target_args = self.spend_this_coin();
        let spend_puzzle = self.on_chain_referee_puzzle(allocator)?;

        // Get the puzzle hash for the next referee state.
        // This reflects a "their turn" state with the updated state from the
        // game handler returned by consuming our move.  This is assumed to
        // have been done by consuming the move in a different method call.

        // Get the current state of the referee on chain.  This reflects the
        // current state at the time the move was made.
        // The current referee uses the previous state since we have already
        // taken the move.
        //
        debug!("get_transaction_for_move: previous curry");
        let args = self.args_for_this_coin();

        //debug!("transaction for move: state {:?}", self.state);
        debug!("get_transaction_for_move: source curry {args:?}");
        debug!("get_transaction_for_move: target curry {target_args:?}");

        if let Some((_, ph, _)) = coin_string.to_parts() {
            if on_chain {
                let start_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed().referee_coin_puzzle_hash,
                    &args,
                )?;
                let end_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed().referee_coin_puzzle_hash,
                    &target_args,
                )?;
                debug!("spend puzzle hash {ph:?}");
                debug!("this coin start {start_ph:?}");
                debug!("this coin end   {end_ph:?}");
                // assert_eq!(ph, start_ph);
            }
        }

        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            target_args.previous_validation_info_hash.as_ref()
        );
        // debug!(
        //     "transaction for move: from {:?} to {target_args:?}",
        //     self.args_for_this_coin()
        // );
        let target_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed().referee_coin_puzzle_hash,
            &target_args,
        )?;
        let target_referee_puzzle =
            curry_referee_puzzle(allocator, &self.fixed().referee_coin_puzzle, &target_args)?;
        assert_eq!(
            target_referee_puzzle.sha256tree(allocator),
            target_referee_puzzle_hash
        );

        let inner_conditions = [(
            CREATE_COIN,
            (
                target_referee_puzzle_hash.clone(),
                (self.fixed().amount.clone(), ()),
            ),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        // Generalize this once the test is working.  Move out the assumption that
        // referee private key is my_identity.synthetic_private_key.
        debug!("referee spend with parent coin {coin_string:?}");
        debug!(
            "signing coin with synthetic public key {:?} for public key {:?}",
            self.fixed().my_identity.synthetic_public_key,
            self.fixed().my_identity.public_key
        );
        let referee_spend = standard_solution_partial(
            allocator,
            &self.fixed().my_identity.synthetic_private_key,
            &coin_string.to_coin_id(),
            inner_conditions,
            &self.fixed().my_identity.synthetic_public_key,
            &self.fixed().agg_sig_me_additional_data,
            false,
        )?;

        let args_list = OnChainRefereeSolution::Move(OnChainRefereeMove {
            details: target_args.game_move.clone(),
            max_move_size: target_args.max_move_size,
            mover_coin: IdentityCoinAndSolution {
                mover_coin_puzzle: self.fixed().my_identity.puzzle.clone(),
                mover_coin_spend_solution: referee_spend.solution.p(),
                mover_coin_spend_signature: referee_spend.signature.clone(),
            },
        });

        if let Some(transaction) = self.get_transaction(
            allocator,
            coin_string,
            true,
            spend_puzzle,
            &target_args.neutralize(),
            &args_list,
        )? {
            Ok(transaction)
        } else {
            // Return err
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }
}

pub type RefereeMaker = RefereeByTurn;
