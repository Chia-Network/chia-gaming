use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

use crate::utils::{non_nil, proper_list};

use log::debug;

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::StateUpdateProgram;
use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Node, Program, Puzzle, Timeout,
};

struct ProposalGameSpec {
    initial_validation_program_hash: Hash,
    initial_move: Vec<u8>,
    initial_max_move_size: usize,
    initial_state: Rc<Program>,
    initial_mover_share: u64,
}

#[derive(Clone)]
pub struct GameStart {
    pub id: GameID,
    pub initial_mover_handler: GameHandler,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_validation_program: StateUpdateProgram,
    pub initial_validation_program_hash: Hash,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
}

impl GameStart {
    pub fn new(
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        template_list: &[NodePtr],
    ) -> Result<GameStart, Error> {
        if template_list.len() != 11 {
            return Err(Error::StrErr(format!(
                "calpoker template returned incorrect property list {}",
                template_list.len(),
            )));
        }

        let amount_atom = atom_from_clvm(allocator, template_list[0]);
        let is_my_turn = non_nil(allocator.allocator(), template_list[1]);
        let handler_hex_len = Node(template_list[2]).to_hex(allocator).map(|h| h.len()).unwrap_or(0);
        let vh_hex = atom_from_clvm(allocator, template_list[6]).map(|a| hex::encode(&a)).unwrap_or_default();
        debug!(
            "GameStart: amount={:?} is_my_turn={} handler_hex_len={} vh={} state={:?} move={:?} max_move_size={:?} mover_share={:?}",
            amount_atom.as_ref().map(|a| u64_from_atom(a)),
            is_my_turn,
            handler_hex_len,
            vh_hex,
            Program::from_nodeptr(allocator, template_list[7]).ok(),
            atom_from_clvm(allocator, template_list[8]).map(hex::encode),
            atom_from_clvm(allocator, template_list[9]).and_then(|a| usize_from_atom(&a)),
            atom_from_clvm(allocator, template_list[10]).and_then(|a| u64_from_atom(&a)),
        );
        let initial_mover_handler = if is_my_turn {
            GameHandler::my_handler_from_nodeptr(allocator, template_list[2])?
        } else {
            GameHandler::their_handler_from_nodeptr(allocator, template_list[2])?
        };

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, template_list[5])?);
        let initial_validation_program =
            StateUpdateProgram::new(allocator, "initial", validation_prog);
        let initial_validation_program_hash =
            if let Some(a) = atom_from_clvm(allocator, template_list[6]) {
                Hash::from_slice(&a)
            } else {
                return Err(Error::StrErr(
                    "not an atom for initial_validation_hash".to_string(),
                ));
            };
        let initial_state_node = template_list[7];
        let initial_state = Rc::new(Program::from_nodeptr(allocator, initial_state_node)?);
        let initial_move = atom_from_clvm(allocator, template_list[8]).unwrap_or_default();
        let initial_max_move_size = atom_from_clvm(allocator, template_list[9])
            .and_then(|a| usize_from_atom(&a))
            .expect("should be an atom");
        let initial_mover_share = atom_from_clvm(allocator, template_list[10])
            .and_then(|a| u64_from_atom(&a))
            .expect("should be an atom");
        Ok(GameStart {
            id: game_id.clone(),
            initial_max_move_size,
            initial_validation_program,
            initial_validation_program_hash,
            initial_state,
            initial_move,
            initial_mover_share,
            initial_mover_handler,
        })
    }

    pub fn game_start(
        &self,
        game_id: &GameID,
        amount: &Amount,
        timeout: &Timeout,
        my_contribution: &Amount,
        their_contribution: &Amount,
    ) -> GameStartInfo {
        GameStartInfo {
            game_id: game_id.clone(),
            amount: amount.clone(),
            game_handler: self.initial_mover_handler.clone(),
            timeout: timeout.clone(),
            my_contribution_this_game: my_contribution.clone(),
            their_contribution_this_game: their_contribution.clone(),
            initial_validation_program: self.initial_validation_program.clone(),
            initial_state: self.initial_state.clone().into(),
            initial_move: self.initial_move.clone(),
            initial_max_move_size: self.initial_max_move_size,
            initial_mover_share: Amount::new(self.initial_mover_share),
        }
    }
}

#[derive(Clone)]
pub struct Game {
    pub starts: Vec<GameStart>,
}

impl Game {
    /// Run calpoker_make_proposal(bet_size) and parse the result into
    /// (wire_data, handler, validator, game_spec fields).
    fn run_make_proposal(
        allocator: &mut AllocEncoder,
        proposal_program: Puzzle,
        bet_size: &Amount,
    ) -> Result<(NodePtr, GameHandler, NodePtr, ProposalGameSpec), Error> {
        let args = (bet_size.clone(), ()).to_clvm(allocator).into_gen()?;
        let proposal_clvm = proposal_program.to_clvm(allocator).into_gen()?;
        debug!("running make_proposal bet_size={bet_size:?}");
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            proposal_clvm,
            args,
            0,
        )
        .into_gen()
        .map_err(|e| Error::StrErr(format!("make_proposal failed: bet_size={bet_size:?} error={e:?}")))?
        .1;

        // Result is (wire_data local_data)
        // wire_data = (bet_size bet_size ((amount we_go_first vh im mms is ms)))
        // local_data = ((handler validator))
        let result_list = proper_list(allocator.allocator(), result, true)
            .ok_or_else(|| Error::StrErr("make_proposal didn't return a list".to_string()))?;
        if result_list.len() < 2 {
            return Err(Error::StrErr(format!(
                "make_proposal returned {} elements, expected 2",
                result_list.len()
            )));
        }
        let wire_data = result_list[0];
        let local_data = result_list[1];

        // Parse wire_data to extract game_spec: (bet bet ((amount we_go_first vh im mms is ms)))
        let wire_list = proper_list(allocator.allocator(), wire_data, true)
            .ok_or_else(|| Error::StrErr("wire_data not a list".to_string()))?;
        if wire_list.len() < 3 {
            return Err(Error::StrErr("wire_data too short".to_string()));
        }
        let game_spec_wrapper = proper_list(allocator.allocator(), wire_list[2], true)
            .ok_or_else(|| Error::StrErr("wire_data[2] not a list".to_string()))?;
        if game_spec_wrapper.is_empty() {
            return Err(Error::StrErr("game_spec wrapper is empty".to_string()));
        }
        let game_spec_list = proper_list(allocator.allocator(), game_spec_wrapper[0], true)
            .ok_or_else(|| Error::StrErr("game_spec not a list".to_string()))?;
        if game_spec_list.len() < 7 {
            return Err(Error::StrErr(format!(
                "game_spec has {} elements, expected 7",
                game_spec_list.len()
            )));
        }

        let spec = ProposalGameSpec {
            // game_spec_list[0] is amount (= 2 * bet_size), game_spec_list[1] is we_go_first
            initial_validation_program_hash: Hash::from_nodeptr(allocator, game_spec_list[2])?,
            initial_move: atom_from_clvm(allocator, game_spec_list[3]).unwrap_or_default(),
            initial_max_move_size: atom_from_clvm(allocator, game_spec_list[4])
                .and_then(|a| usize_from_atom(&a))
                .ok_or_else(|| Error::StrErr("bad max_move_size in game_spec".to_string()))?,
            initial_state: Rc::new(Program::from_nodeptr(allocator, game_spec_list[5])?),
            initial_mover_share: atom_from_clvm(allocator, game_spec_list[6])
                .and_then(|a| u64_from_atom(&a))
                .ok_or_else(|| Error::StrErr("bad mover_share in game_spec".to_string()))?,
        };

        // Parse local_data = ((handler validator))
        let local_list = proper_list(allocator.allocator(), local_data, true)
            .ok_or_else(|| Error::StrErr("local_data not a list".to_string()))?;
        if local_list.is_empty() {
            return Err(Error::StrErr("local_data is empty".to_string()));
        }
        let handler_info = proper_list(allocator.allocator(), local_list[0], true)
            .ok_or_else(|| Error::StrErr("handler_info not a list".to_string()))?;
        if handler_info.len() < 2 {
            return Err(Error::StrErr("handler_info too short".to_string()));
        }
        let handler = GameHandler::my_handler_from_nodeptr(allocator, handler_info[0])?;
        let validator_node = handler_info[1];

        debug!(
            "make_proposal: vh={} max_move_size={} mover_share={}",
            hex::encode(spec.initial_validation_program_hash.bytes()),
            spec.initial_max_move_size,
            spec.initial_mover_share,
        );

        Ok((wire_data, handler, validator_node, spec))
    }

    /// Run calpoker_parser(wire_data) and extract handler + validator.
    fn run_parser(
        allocator: &mut AllocEncoder,
        parser_program: Puzzle,
        wire_data: NodePtr,
    ) -> Result<(GameHandler, NodePtr), Error> {
        let parser_clvm = parser_program.to_clvm(allocator).into_gen()?;
        debug!("running parser");
        // Parser expects wire_data as its environment (spread args)
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            parser_clvm,
            wire_data,
            0,
        )
        .into_gen()
        .map_err(|e| Error::StrErr(format!("parser failed: error={e:?}")))?
        .1;

        // Result is (readable ((validator handler)))
        let result_list = proper_list(allocator.allocator(), result, true)
            .ok_or_else(|| Error::StrErr("parser didn't return a list".to_string()))?;
        if result_list.len() < 2 {
            return Err(Error::StrErr(format!(
                "parser returned {} elements, expected 2",
                result_list.len()
            )));
        }
        let handler_wrapper = proper_list(allocator.allocator(), result_list[1], true)
            .ok_or_else(|| Error::StrErr("parser handler_wrapper not a list".to_string()))?;
        if handler_wrapper.is_empty() {
            return Err(Error::StrErr("parser handler_wrapper is empty".to_string()));
        }
        let handler_info = proper_list(allocator.allocator(), handler_wrapper[0], true)
            .ok_or_else(|| Error::StrErr("parser handler_info not a list".to_string()))?;
        if handler_info.len() < 2 {
            return Err(Error::StrErr("parser handler_info too short".to_string()));
        }
        // Parser returns (validator handler) in handler_info
        let validator_node = handler_info[0];
        let handler = GameHandler::their_handler_from_nodeptr(allocator, handler_info[1])?;

        debug!("parser: got handler and validator");

        Ok((handler, validator_node))
    }

    pub fn new_from_proposal(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        proposal_program: Puzzle,
        parser_program: Option<Puzzle>,
        my_contribution: &Amount,
    ) -> Result<Game, Error> {
        let (wire_data, alice_handler, alice_validator_node, spec) =
            Self::run_make_proposal(allocator, proposal_program, my_contribution)?;

        let (handler, validator_node) = if as_alice {
            (alice_handler, alice_validator_node)
        } else {
            let parser = parser_program
                .ok_or_else(|| Error::StrErr("no parser program for responder".to_string()))?;
            Self::run_parser(allocator, parser, wire_data)?
        };

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, validator_node)?);
        let initial_validation_program =
            StateUpdateProgram::new_hash(validation_prog, "initial", spec.initial_validation_program_hash.clone());

        let start = GameStart {
            id: game_id.clone(),
            initial_mover_handler: handler,
            initial_validation_program,
            initial_validation_program_hash: spec.initial_validation_program_hash,
            initial_state: spec.initial_state,
            initial_move: spec.initial_move,
            initial_max_move_size: spec.initial_max_move_size,
            initial_mover_share: spec.initial_mover_share,
        };

        Ok(Game { starts: vec![start] })
    }

    pub fn new_program(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        poker_generator: Puzzle,
        args_program: Rc<Program>,
    ) -> Result<Game, Error> {
        let mut starts = Vec::new();

        let args = (as_alice, args_program.clone())
            .to_clvm(allocator)
            .into_gen()?;

        let poker_generator_clvm = poker_generator.to_clvm(allocator).into_gen()?;
        debug!(
            "running factory as_alice={as_alice} args={args_program:?}"
        );
        let template_clvm = match run_program(
            allocator.allocator(),
            &chia_dialect(),
            poker_generator_clvm,
            args,
            0,
        )
        .into_gen()
        {
            Ok(r) => r.1,
            Err(e) => {
                return Err(Error::StrErr(format!(
                    "factory run failed: as_alice={as_alice} args={args_program:?} error={e:?}"
                )));
            }
        };
        let template_list = if let Some(lst) = proper_list(allocator.allocator(), template_clvm, true) {
            lst
        } else {
            return Err(Error::StrErr(
                "poker program didn't return a list".to_string(),
            ));
        };
        debug!(
            "factory returned as_alice={as_alice} num_games={} first_game_len={}",
            template_list.len(),
            template_list.first()
                .and_then(|g| proper_list(allocator.allocator(), *g, true))
                .map(|l| l.len())
                .unwrap_or(0),
        );
        if template_list.is_empty() {
            return Err(Error::StrErr("not even one game returned".to_string()));
        }

        for game in template_list.iter() {
            let game_fields = if let Some(lst) = proper_list(allocator.allocator(), *game, true) {
                lst
            } else {
                return Err(Error::StrErr("bad template list".to_string()));
            };

            starts.push(GameStart::new(allocator, game_id, &game_fields)?);
        }

        Ok(Game { starts })
    }

    pub fn new(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        game_hex_file: &str,
        args: Rc<Program>,
    ) -> Result<Game, Error> {
        let poker_generator = read_hex_puzzle(allocator, game_hex_file)?;
        Game::new_program(allocator, as_alice, game_id, poker_generator.clone(), args)
    }

    /// Return a pair of GameStartInfo which can be used as the starts for two
    /// players in a game.
    pub fn game_start(
        &self,
        game_id: &GameID,
        our_contribution: &Amount,
        their_contribution: &Amount,
        timeout: &Timeout,
    ) -> GameStartInfo {
        let amount = our_contribution.clone() + their_contribution.clone();
        self.starts[0].game_start(
            game_id,
            &amount,
            timeout,
            our_contribution,
            their_contribution,
        )
    }
}
