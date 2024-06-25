use std::rc::Rc;

use clvmr::allocator::NodePtr;
use clvm_traits::{ClvmEncoder, ToClvm};

use clvm_tools_rs::classic::clvm_tools::binutils::{assemble, disassemble};
use clvm_tools_rs::classic::clvm_tools::stages::stage_0::{DefaultProgramRunner, TRunProgram};
use clvm_tools_rs::compiler::clvm::{convert_from_clvm_rs, run};
use clvm_tools_rs::compiler::compiler::DefaultCompilerOpts;
use clvm_tools_rs::compiler::comptypes::{CompilerOpts, map_m};
use clvm_tools_rs::compiler::srcloc::Srcloc;

use pyo3::prelude::*;
use pyo3::types::{PyNone, PyBytes, PyTuple};
use pyo3::exceptions::PyIndexError;
use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use indoc::indoc;

use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN, REM};
use crate::common::standard_coin::{standard_solution_partial, ChiaIdentity, agg_sig_me_message, read_hex_puzzle, solution_for_conditions, sign_agg_sig_me};
use crate::common::types::{ErrToError, Error, Puzzle, Amount, Hash, CoinString, CoinID, PuzzleHash, PrivateKey, Aggsig, Node, SpecificTransactionBundle, AllocEncoder, TransactionBundle, ToQuotedProgram, Sha256tree, Timeout, GameID, IntoErr};

use crate::channel_handler::game::Game;
use crate::channel_handler::types::{ChannelHandlerEnv, GameStartInfo, ReadableMove, ValidationProgram};
use crate::tests::channel_handler::ChannelHandlerGame;
use crate::tests::game::new_channel_handler_game;
use crate::tests::referee::{RefereeTest, make_debug_game_handler};

#[derive(Debug, Clone)]
pub struct IncludeTransactionResult {
    pub code: u32,
    pub e: Option<u32>,
    pub diagnostic: String
}

// Allow simulator from rust.
pub struct Simulator {
    evloop: PyObject,
    sim: PyObject,
    client: PyObject,
    guard: PyObject,
    make_spend: PyObject,
    chia_rs_coin: PyObject,
    program: PyObject,
    spend_bundle: PyObject,
    g2_element: PyObject,
    coin_as_list: PyObject
}

#[cfg(test)]
impl ErrToError for PyErr {
    fn into_gen(self) -> Error {
        Error::StrErr(format!("{self:?}"))
    }
}

impl Drop for Simulator {
    fn drop(&mut self) {
        Python::with_gil(|py| -> PyResult<_> {
            let none = PyNone::get(py);
            let exit_task = self.guard.call_method1(py, "__aexit__", (none, none, none))?;
            self.evloop.call_method1(py, "run_until_complete", (exit_task,))?;
            self.evloop.call_method0(py, "stop")?;
            self.evloop.call_method0(py, "close")?;

            self.evloop = none.into();
            self.sim = none.into();
            self.client = none.into();
            self.guard = none.into();
            self.make_spend = none.into();
            self.chia_rs_coin = none.into();
            self.program = none.into();
            self.spend_bundle = none.into();
            self.g2_element = none.into();
            self.coin_as_list = none.into();
            Ok(())
        })
        .expect("should shutdown");
    }
}

fn extract_code(e: &str) -> Option<u32> {
    if e == "None" {
        return None;
    }

    if let Some(p) = e.chars().position(|c| c == ':') {
        return Some(e[(p+2)..(e.len()-1)].parse::<u32>().expect("should parse"));
    }

    panic!("could not parse code");
}

fn to_spend_result(py: Python<'_>, spend_res: PyObject) -> PyResult<IncludeTransactionResult> {
    let (inclusion_status, err): (PyObject, PyObject) = spend_res.extract(py)?;
    let status: u32 = inclusion_status.extract(py)?;
    let e: String = err.call_method0(py, "__repr__")?.extract(py)?;
    Ok(IncludeTransactionResult {
        code: status,
        e: extract_code(&e),
        diagnostic: e
    })
}

impl Simulator {
    /// Given a coin in our inventory, spend the coin to the target puzzle hash.
    pub fn spend_coin_to_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
        identity: &ChiaIdentity,
        puzzle: &Puzzle,
        coin: &CoinString,
        target_coins: &[(PuzzleHash, Amount)],
    ) -> Result<Vec<CoinString>, Error> {
        let agg_sig_me_additional_data = Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA);
        let (_first_coin_parent, first_coin_ph, _first_coin_amt) = coin.to_parts().unwrap();
        assert_eq!(puzzle.sha256tree(allocator), first_coin_ph);

        let conditions_vec = map_m(|(ph, amt): &(PuzzleHash, Amount)| -> Result<Node, Error> {
            Ok(Node((CREATE_COIN, (ph.clone(), (amt.clone(), ())))
                .to_clvm(allocator).into_gen()?))
        }, target_coins)?;
        let conditions = conditions_vec.to_clvm(allocator).into_gen()?;

        let (solution, signature1) = standard_solution_partial(
            allocator,
            &identity.synthetic_private_key,
            &coin.to_coin_id(),
            conditions,
            &identity.synthetic_public_key,
            &agg_sig_me_additional_data,
            false
        ).expect("should build");

        let quoted_conds = conditions.to_quoted_program(allocator).expect("should work");
        let hashed_conds = quoted_conds.sha256tree(allocator);
        let agg_sig_me_message = agg_sig_me_message(
            &hashed_conds.bytes(),
            &coin.to_coin_id(),
            &agg_sig_me_additional_data
        );
        eprintln!("our message {agg_sig_me_message:?}");
        let signature2 = identity.synthetic_private_key.sign(&agg_sig_me_message);
        assert_eq!(signature1, signature2);

        let specific = SpecificTransactionBundle {
            coin: coin.clone(),
            bundle: TransactionBundle {
                puzzle: identity.puzzle.clone(),
                solution,
                signature: signature1,
            }
        };

        let status = self.push_tx(
            allocator,
            &[specific]
        ).expect("should spend");
        if status.code == 3 {
            return Err(Error::StrErr("failed to spend coin".to_string()));
        }

        Ok(target_coins.iter().map(|(ph, amt)| {
            CoinString::from_parts(
                &coin.to_coin_id(),
                ph,
                amt
            )
        }).collect())
    }

    pub fn new() -> Self {
        Python::with_gil(|py| -> PyResult<_> {
            let module = PyModule::from_code(
                py,
                indoc! {"
               import asyncio
               import chia.clvm.spend_sim
               from chia.types.coin_spend import make_spend
               from chia_rs import Coin, G2Element
               from chia.types.blockchain_format.program import Program
               from chia.types.spend_bundle import SpendBundle
               from chia.types.blockchain_format.coin import coin_as_list

               def start():
                   evloop = asyncio.new_event_loop()
                   sac_gen = chia.clvm.spend_sim.sim_and_client()
                   (sim, client) = evloop.run_until_complete(sac_gen.__aenter__())
                   return (evloop, sim, client, sac_gen, make_spend, Coin, Program, SpendBundle, G2Element, coin_as_list)
            "},
                "tmod.py",
                "tmod",
            )?;
            let evloop = module.call_method0("start")?;
            Ok(Simulator {
                evloop: evloop.get_item(0)?.extract()?,
                sim: evloop.get_item(1)?.extract()?,
                client: evloop.get_item(2)?.extract()?,
                guard: evloop.get_item(3)?.extract()?,
                make_spend: evloop.get_item(4)?.extract()?,
                chia_rs_coin: evloop.get_item(5)?.extract()?,
                program: evloop.get_item(6)?.extract()?,
                spend_bundle: evloop.get_item(7)?.extract()?,
                g2_element: evloop.get_item(8)?.extract()?,
                coin_as_list: evloop.get_item(9)?.extract()?,
            })
        })
        .expect("should work")
    }

    fn async_call<ArgT>(&self, py: Python<'_>, name: &str, args: ArgT) -> PyResult<PyObject>
    where
        ArgT: IntoPy<Py<PyTuple>>
    {
        let task = self.sim.call_method1(py, name, args)?;
        let res = self.evloop.call_method1(py, "run_until_complete", (task,))?;
        Ok(res.into())
    }

    fn async_client<ArgT>(&self, py: Python<'_>, name: &str, args: ArgT) -> PyResult<PyObject>
    where
        ArgT: IntoPy<Py<PyTuple>>
    {
        let task = self.client.call_method1(py, name, args)?;
        let res = self.evloop.call_method1(py, "run_until_complete", (task,))?;
        Ok(res.into())
    }

    pub fn farm_block(&self, puzzle_hash: &PuzzleHash) {
        Python::with_gil(|py| -> PyResult<_> {
            let puzzle_hash_bytes = PyBytes::new(py, &puzzle_hash.bytes());
            self.async_call(py, "farm_block", (puzzle_hash_bytes,))?;
            Ok(())
        })
        .expect("should farm");
    }

    pub fn get_my_coins(&self, puzzle_hash: &PuzzleHash) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let hash_bytes = PyBytes::new(py, &puzzle_hash.bytes());
            let coins = self.async_client(
                py,
                "get_coin_records_by_puzzle_hash",
                (hash_bytes, false)
            )?;
            let items: Vec<PyObject> = coins.extract(py)?;
            eprintln!("num coins {}", items.len());
            let mut result_coins = Vec::new();
            for i in items.iter() {
                let coin_of_item: PyObject = i.getattr(py, "coin")?.extract(py)?;
                let as_list_str: String = coin_of_item.call_method0(py, "__repr__")?.extract(py)?;
                eprintln!("as_list_str {as_list_str}");
                let as_list: Vec<PyObject> = self.coin_as_list.call1(py, (coin_of_item,))?.extract(py)?;
                let parent_coin_info: &PyBytes = as_list[0].downcast(py)?;
                let parent_coin_info_slice: &[u8] = parent_coin_info.extract()?;
                let puzzle_hash: &PyBytes = as_list[1].downcast(py)?;
                let puzzle_hash_slice: &[u8] = puzzle_hash.extract()?;
                let amount: u64 = as_list[2].extract(py)?;
                let parent_coin_hash = Hash::from_slice(parent_coin_info_slice);
                let puzzle_hash = Hash::from_slice(puzzle_hash_slice);
                result_coins.push(CoinString::from_parts(
                    &CoinID::new(parent_coin_hash),
                    &PuzzleHash::from_hash(puzzle_hash),
                    &Amount::new(amount)
                ));
            }
            Ok(result_coins)
        })
    }

    pub fn g2_element(&self, aggsig: &Aggsig) -> PyResult<PyObject> {
        Python::with_gil(|py| -> PyResult<_> {
            let bytes = PyBytes::new(py, &aggsig.bytes());
            self.g2_element.call_method1(py, "from_bytes_unchecked", (bytes,))
        })
    }

    pub fn make_coin(&self, coin_string: &CoinString) -> PyResult<PyObject> {
        let (parent_id, puzzle_hash, amount) =
            if let Some(parts) = coin_string.to_parts() {
                parts
            } else {
                panic!("coin string didn't parse");
            };

        Python::with_gil(|py| -> PyResult<_> {
            let parent_parent_coin = PyBytes::new(py, &parent_id.bytes());
            let puzzle_hash_data = PyBytes::new(py, &puzzle_hash.bytes());
            let amt: u64 = amount.into();
            self.chia_rs_coin.call1(py, (parent_parent_coin, puzzle_hash_data, amt))
        })
    }

    pub fn hex_to_program(
        &self,
        hex: &str
    ) -> PyResult<PyObject> {
        Python::with_gil(|py| -> PyResult<_> {
            self.program.call_method1(py, "fromhex", (hex,))
        })
    }

    pub fn make_coin_spend(
        &self,
        py: Python<'_>,
        allocator: &mut AllocEncoder,
        parent_coin: &CoinString,
        puzzle_reveal: Puzzle,
        solution: NodePtr
    ) -> PyResult<PyObject> {
        let coin = self.make_coin(parent_coin)?;
        eprintln!("coin = {coin:?}");
        let puzzle_hex = puzzle_reveal.to_hex(allocator);
        let puzzle_program = self.hex_to_program(&puzzle_hex)?;
        eprintln!("puzzle_program = {puzzle_program:?}");
        let solution_hex = Node(solution).to_hex(allocator);
        let solution_program = self.hex_to_program(&solution_hex)?;
        eprintln!("solution_program = {solution_program:?}");
        self.make_spend.call1(py, (coin, puzzle_program, solution_program))
    }

    pub fn make_spend_bundle(
        &self,
        allocator: &mut AllocEncoder,
        txs: &[SpecificTransactionBundle]
    ) -> PyResult<PyObject> {
        Python::with_gil(|py| {
            let mut spends = Vec::new();
            if txs.is_empty() {
                return Err(
                    PyErr::from_value(
                        PyIndexError::new_err(
                            "some type error"
                        ).value(py).into()
                    )
                );
            }

            let mut signature = txs[0].bundle.signature.clone();
            for (i, tx) in txs.iter().enumerate() {
                let spend = self.make_coin_spend(
                    py,
                    allocator,
                    &tx.coin,
                    tx.bundle.puzzle.clone(),
                    tx.bundle.solution
                )?;
                spends.push(spend);
                if i > 0 {
                    signature += tx.bundle.signature.clone();
                }
            }
            let py_signature = self.g2_element(&signature)?;
            self.spend_bundle.call1(py, (spends, py_signature))
        })
    }

    pub fn push_tx(
        &self,
        allocator: &mut AllocEncoder,
        txs: &[SpecificTransactionBundle]
    ) -> PyResult<IncludeTransactionResult> {
        let spend_bundle = self.make_spend_bundle(allocator, txs)?;
        Python::with_gil(|py| {
            eprintln!("spend_bundle {:?}", spend_bundle);
            let spend_res: PyObject = self.async_client(
                py,
                "push_tx",
                (spend_bundle,)
            )?.extract(py)?;
            to_spend_result(py, spend_res)
        })
    }

    /// Create a coin belonging to identity_target which currently belongs
    /// to identity_source.  Return change to identity_source.
    pub fn transfer_coin_amount(
        &self,
        allocator: &mut AllocEncoder,
        identity_target: &ChiaIdentity,
        identity_source: &ChiaIdentity,
        source_coin: &CoinString,
        target_amt: Amount,
    ) -> Result<(CoinString, CoinString), Error> {
        let (_parent, _, amt) =
            if let Some(p) = source_coin.to_parts() {
                p
            } else {
                return Err(Error::StrErr("failed to parse coin string".to_string()));
            };

        let change_amt = amt.clone() - target_amt.clone();
        let first_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_target.puzzle_hash,
            &target_amt
        );
        let second_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_source.puzzle_hash,
            &change_amt
        );

        let conditions =
            ((CREATE_COIN,
              (identity_target.puzzle_hash.clone(),
               (target_amt.clone(), ()),
              )
            ),
             ((CREATE_COIN,
               (identity_source.puzzle_hash.clone(),
                (change_amt, ()),
               )
             ), ())
            ).to_clvm(allocator).into_gen()?;
        let quoted_conditions = conditions.to_quoted_program(allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
        let standard_solution = solution_for_conditions(allocator, conditions)?;
        let signature = sign_agg_sig_me(
            &identity_source.synthetic_private_key,
            &quoted_conditions_hash.bytes(),
            &source_coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA)
        );
        let tx = SpecificTransactionBundle {
            bundle: TransactionBundle {
                puzzle: identity_source.puzzle.clone(),
                solution: standard_solution,
                signature,
            },
            coin: source_coin.clone(),
        };
        let included = self.push_tx(allocator, &[tx]).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend: {included:?}")));
        }
        Ok((first_coin, second_coin))
    }

    /// Combine coins, spending to a specific puzzle hash
    pub fn combine_coins(
        &self,
        allocator: &mut AllocEncoder,
        owner: &ChiaIdentity,
        target_ph: &PuzzleHash,
        coins: &[CoinString],
    ) -> Result<CoinString, Error> {
        let mut amount = Amount::default();
        let mut spends = Vec::new();
        let nil = allocator.encode_atom(&[]).into_gen()?;

        if coins.is_empty() {
            return Err(Error::StrErr("no coins".to_string()));
        }

        for (i, c) in coins.iter().enumerate() {
            let (_, _, amt) =
                if let Some(p) = c.to_parts() {
                    p
                } else {
                    return Err(Error::StrErr("improper coin string".to_string()));
                };
            amount += amt.clone();
            let conditions =
                if i == coins.len()-1 {
                    ((CREATE_COIN,
                      (target_ph.clone(),
                       (amount.clone(), ())
                      )
                    ), ()).to_clvm(allocator).into_gen()?
                } else {
                    nil
                };
            let solution = solution_for_conditions(
                allocator,
                conditions
            )?;
            let quoted_conditions = conditions.to_quoted_program(allocator)?;
            let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
            let signature = sign_agg_sig_me(
                &owner.synthetic_private_key,
                &quoted_conditions_hash.bytes(),
                &c.to_coin_id(),
                &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA)
            );
            spends.push(SpecificTransactionBundle {
                bundle: TransactionBundle {
                    puzzle: owner.puzzle.clone(),
                    solution,
                    signature
                },
                coin: c.clone()
            });
        }

        let included = self.push_tx(allocator, &spends).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend: {included:?}")));
        }

        Ok(CoinString::from_parts(&coins[coins.len()-1].to_coin_id(), &owner.puzzle_hash, &amount))
    }
}

#[derive(Debug, Clone)]
pub enum GameAction {
    /// Do a timeout
    Timeout(usize),
    /// Move (player, clvm readable move)
    Move(usize, NodePtr),
    /// Fake move:
    FakeMove(usize, NodePtr, Vec<u8>),
    /// Go on chain
    GoOnChain(usize)
}

#[derive(Debug, Clone)]
pub enum GameActionResult {
    MoveResult(NodePtr, Vec<u8>),
    MoveToOnChain,
}

#[derive(Debug, Clone)]
pub enum OnChainState {
    OffChain([CoinString; 2]),
    OnChain(Vec<CoinString>),
}

pub struct SimulatorEnvironment<'a, R: Rng> {
    pub env: ChannelHandlerEnv<'a, R>,
    pub on_chain: OnChainState,
    pub identities: [ChiaIdentity; 2],
    pub parties: ChannelHandlerGame,
    pub simulator: Simulator,
}

impl<'a, R: Rng> SimulatorEnvironment<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        game: &Game,
        contributions: &[Amount; 2]
    ) -> Result<Self, Error> {

        // Generate keys and puzzle hashes.
        let my_private_key: PrivateKey = rng.gen();
        let their_private_key: PrivateKey = rng.gen();

        let identities = [
            ChiaIdentity::new(allocator, my_private_key).expect("should generate"),
            ChiaIdentity::new(allocator, their_private_key).expect("should generate")
        ];

        let referee_coin_puzzle = read_hex_puzzle(
            allocator,
            "onchain/referee.hex"
        ).expect("should be readable");
        let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(allocator);
        let unroll_puzzle = read_hex_puzzle(
            allocator,
            "resources/unroll_puzzle_state_channel_unrolling.hex"
        ).expect("should read");
        let unroll_metapuzzle = read_hex_puzzle(
            allocator,
            "resources/unroll_meta_puzzle.hex"
        ).expect("should read");
        let mut env = ChannelHandlerEnv {
            allocator: allocator,
            rng: rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_metapuzzle,
            unroll_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
        };

        let simulator = Simulator::new();
        let (parties, coins) = new_channel_handler_game(
            &simulator,
            &mut env,
            &game,
            &identities,
            contributions.clone(),
        )?;

        Ok(SimulatorEnvironment {
            env,
            identities,
            parties,
            on_chain: OnChainState::OffChain(coins),
            simulator
        })
    }

    // Create a channel coin from the users' input coins giving the new CoinString
    // and the state number.  The result is the coin string of the new coin and
    fn create_and_spend_channel_coin(
        &mut self,
        coins: &[CoinString; 2],
        state_number: usize,
        unroll_coin_puzzle_hash: &PuzzleHash,
        my_amount: Amount,
        their_amount: Amount,
    ) -> Result<(NodePtr, CoinString), Error> {
        // Spend coin1 to person 0 creating their_amount and change (u1).
        let (u1, _) = self.simulator.transfer_coin_amount(
            self.env.allocator,
            &self.identities[0],
            &self.identities[1],
            &coins[1],
            their_amount.clone()
        )?;
        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        // Spend coin0 to person 0 creating my_amount and change (u0).
        let (u2, _) = self.simulator.transfer_coin_amount(
            self.env.allocator,
            &self.identities[0],
            &self.identities[0],
            &coins[0],
            my_amount.clone()
        )?;
        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        // Combine u1 and u0 into a single person 0 coin (state_channel).
        let state_channel = self.simulator.combine_coins(
            self.env.allocator,
            &self.identities[0],
            &self.identities[0].puzzle_hash,
            &[u1, u2],
        )?;
        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        let target_amount = my_amount.clone() + their_amount.clone();
        let target_conditions =
            ((REM, (state_number, ())),
             ((CREATE_COIN,
               (unroll_coin_puzzle_hash.clone(),
                (target_amount.clone(), ())
               )
             ), ()
             )
            ).to_clvm(self.env.allocator).into_gen()?;

        let quoted_conds = target_conditions.to_quoted_program(&mut self.env.allocator)?;
        let quoted_conds_hash = quoted_conds.sha256tree(&mut self.env.allocator);
        let signature = sign_agg_sig_me(
            &self.identities[0].synthetic_private_key,
            &quoted_conds_hash.bytes(),
            &state_channel.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA)
        );
        let state_channel_solution = solution_for_conditions(
            self.env.allocator,
            target_conditions
        )?;

        let included = self.simulator.push_tx(
            self.env.allocator,
            &[SpecificTransactionBundle {
                bundle: TransactionBundle {
                    puzzle: self.identities[0].puzzle.clone(),
                    solution: state_channel_solution,
                    signature,
                },
                coin: state_channel.clone()
            }]
        ).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr("failed to create combined coin with unroll target".to_string()));
        }

        Ok((target_conditions, CoinString::from_parts(
            &state_channel.to_coin_id(),
            &unroll_coin_puzzle_hash,
            &target_amount
        )))
    }

    fn do_off_chain_move(&mut self, player: usize, readable: NodePtr) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let move_result =
            self.parties.player(player).ch.send_potato_move(
                &mut self.env,
                &game_id,
                &ReadableMove::from_nodeptr(readable)
            )?;
        // XXX allow verification of ui result and message.
        let (ui_result, message) =
            self.parties.player(player ^ 1).ch.received_potato_move(
                &mut self.env,
                &game_id,
                &move_result
            )?;

        Ok(GameActionResult::MoveResult(ui_result, message))
    }

    fn do_unroll_spend_to_games(
        &mut self,
        player: usize,
        player_state: usize,
        unroll_coin: CoinString
    ) -> Result<Vec<CoinString>, Error> {
        let player_ch = &mut self.parties.player(player).ch;
        let pre_unroll_data =
            player_ch.get_unroll_coin_transaction(
                &mut self.env,
                player_state,
            )?;

        let srcloc = Srcloc::start("*unroll*");
        let runner: Rc<dyn TRunProgram> = Rc::new(DefaultProgramRunner::new());
        let opts: Rc<dyn CompilerOpts> = Rc::new(DefaultCompilerOpts::new("*unroll*"));

        let program = convert_from_clvm_rs(
            self.env.allocator.allocator(),
            srcloc.clone(),
            pre_unroll_data.transaction.puzzle.to_nodeptr()
        ).into_gen()?;
        let args = convert_from_clvm_rs(
            self.env.allocator.allocator(),
            srcloc.clone(),
            pre_unroll_data.transaction.solution
        ).into_gen()?;

        let puzzle_result = run(
            self.env.allocator.allocator(),
            runner,
            opts.prim_map(),
            program,
            args,
            None,
            None,
        ).into_gen()?;
        eprintln!("puzzle_result: {puzzle_result}");

        let included = self.simulator.push_tx(
            self.env.allocator,
            &[SpecificTransactionBundle {
                bundle: pre_unroll_data.transaction.clone(),
                coin: unroll_coin
            }]
        ).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("could not spend unroll coin for move: {included:?}")));
        }

        todo!();
    }

    fn do_on_chain_move(&mut self, player: usize, readable: NodePtr, game_coins: &[CoinString]) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let player_ch = &mut self.parties.player(player).ch;
        let move_result =
            player_ch.send_potato_move(
                &mut self.env,
                &game_id,
                &ReadableMove::from_nodeptr(readable)
            )?;
        let player_state = player_ch.get_state_number();
        let post_unroll_data =
            player_ch.get_unroll_coin_transaction(
                &mut self.env,
                player_state,
            )?;
        eprintln!("post_unroll_data {post_unroll_data:?}");

        todo!();
    }

    pub fn perform_action(
        &mut self,
        action: &GameAction,
    ) -> Result<GameActionResult, Error> {
        eprintln!("play move {action:?}");
        match action {
            GameAction::Move(player, readable) => {
                match &self.on_chain {
                    OnChainState::OffChain(coins) => {
                        self.do_off_chain_move(*player, *readable)
                    }
                    OnChainState::OnChain(games) => {
                        // Multiple borrow.
                        self.do_on_chain_move(*player, *readable, &games.clone())
                    }
                }
            }
            GameAction::GoOnChain(player) => {
                let (state_number, unroll_target, my_amount, their_amount) =
                    self.parties.player(*player).ch.get_unroll_target(
                    &mut self.env,
                )?;
                let (channel_coin_conditions, unroll_coin) =
                    match self.on_chain.clone() {
                        OnChainState::OffChain(coins) => {
                            self.create_and_spend_channel_coin(
                                &coins,
                                state_number,
                                &unroll_target,
                                my_amount,
                                their_amount,
                            )?
                        }
                        _ => {
                            return Err(Error::StrErr("go on chain when on chain".to_string()));
                        }
                    };

                let game_coins = self.do_unroll_spend_to_games(
                    *player,
                    state_number,
                    unroll_coin
                )?;

                eprintln!(
                    "channel coin conditions {}",
                    disassemble(
                        self.env.allocator.allocator(),
                        channel_coin_conditions,
                        None
                    )
                );

                let channel_spent_result_1 = self.parties.player(*player).ch.channel_coin_spent(
                    &mut self.env,
                    channel_coin_conditions
                )?;
                let channel_spent_result_2 = self.parties.player(*player ^ 1).ch.channel_coin_spent(
                    &mut self.env,
                    channel_coin_conditions
                )?;

                self.on_chain = OnChainState::OnChain(game_coins);
                Ok(GameActionResult::MoveToOnChain)
            }
            _ => {
                todo!();
            }
        }
    }

    pub fn play_game(
        &mut self,
        actions: &[GameAction],
    ) -> Result<Vec<GameActionResult>, Error> {
        let mut results = Vec::new();
        for a in actions.iter() {
            results.push(self.perform_action(a)?);
        }

        Ok(results)
    }
}

#[test]
fn test_sim() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    eprintln!("identity public key {:?}", identity.public_key);
    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");
    eprintln!("coin 0 {:?}", coins[0].to_parts());
    eprintln!("coin 0 id {:?}", coins[0].to_coin_id());

    let (_, _, amt) = coins[0].to_parts().unwrap();
    s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &identity,
        &identity.puzzle,
        &coins[0],
        &[(identity.puzzle_hash.clone(), amt.clone())]
    ).expect("should spend");
}

#[test]
fn test_simulator_transfer_coin() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity1 = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");

    s.farm_block(&identity1.puzzle_hash);

    let coins1 = s.get_my_coins(&identity1.puzzle_hash).expect("got coins");
    let coins2_empty = s.get_my_coins(&identity2.puzzle_hash).expect("got coin list");

    assert!(coins2_empty.is_empty());
    s.transfer_coin_amount(
        &mut allocator,
        &identity2,
        &identity1,
        &coins1[0],
        Amount::new(100)
    ).expect("should transfer");

    s.farm_block(&identity1.puzzle_hash);
    let coins2 = s.get_my_coins(&identity2.puzzle_hash).expect("got coins");
    assert_eq!(coins2.len(), 1);
}

#[test]
fn test_simulator_combine_coins() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    s.combine_coins(
        &mut allocator,
        &identity,
        &identity.puzzle_hash,
        &coins
    ).expect("should transfer");

    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");
    s.farm_block(&identity2.puzzle_hash);
    let one_coin = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    let (_, _, a1) = coins[0].to_parts().expect("should parse");
    let (_, _, a2) = coins[1].to_parts().expect("should parse");
    let (_, _, amt) = one_coin[0].to_parts().expect("should parse");

    assert_eq!(one_coin.len(), coins.len() - 1);
    assert_eq!(a1 + a2, amt);
}

#[test]
fn test_referee_can_slash_on_chain() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate");

    let their_private_key: PrivateKey = rng.gen();
    let their_identity = ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate");

    let amount = Amount::new(100);
    let timeout = Timeout::new(10);

    let debug_game = make_debug_game_handler(
        &mut allocator,
        &my_identity,
        &amount,
        &timeout
    );
    let init_state =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");
    let initial_validation_program = ValidationProgram::new(
        &mut allocator,
        debug_game.my_validation_program,
    );

    let amount = Amount::new(100);
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game.my_turn_handler,
        timeout: timeout.clone(),
        my_contribution_this_game: Amount::new(50),
        their_contribution_this_game: Amount::new(50),
        initial_validation_program,
        initial_state: init_state,
        initial_move: vec![],
        initial_max_move_size: 100,
        initial_mover_share: Amount::default(),
    };

    let mut reftest = RefereeTest::new(
        &mut allocator,
        my_identity,
        their_identity,
        debug_game.their_turn_handler,
        &game_start_info,
    );

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(0));

    // Make simulator and create referee coin.
    let s = Simulator::new();
    s.farm_block(&reftest.my_identity.puzzle_hash);

    let coins = s.get_my_coins(
        &reftest.my_identity.puzzle_hash
    ).expect("got coins");
    assert!(coins.len() > 0);

    let readable_move = assemble(allocator.allocator(), "(100 . 0)").expect("should assemble");
    let _my_move_wire_data = reftest.my_referee
        .my_turn_make_move(
            &mut rng,
            &mut allocator,
            &ReadableMove::from_nodeptr(readable_move),
        )
        .expect("should move");

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));

    let (_, _, amt) = coins[0].to_parts().unwrap();
    let spend_to_referee = reftest.my_referee.curried_referee_puzzle_for_validator(
        &mut allocator,
    ).expect("should work");
    let referee_puzzle_hash = spend_to_referee.sha256tree(&mut allocator);

    let referee_coins = s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &reftest.my_identity,
        &reftest.my_identity.puzzle,
        &coins[0],
        &[(referee_puzzle_hash.clone(), amt.clone())]
    ).expect("should create referee coin");

    // Farm 20 blocks to get past the time limit.
    for _ in 0..20 {
        s.farm_block(&reftest.my_identity.puzzle_hash);
    }

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));
    let timeout_transaction = reftest.my_referee.get_transaction_for_timeout(
        &mut allocator,
        &referee_coins[0],
    ).expect("should work").unwrap();

    let disassembled_puzzle_in_transaction = disassemble(
        allocator.allocator(),
        timeout_transaction.bundle.puzzle.to_nodeptr(),
        None
    );
    assert_eq!(
        disassemble(
            allocator.allocator(),
            spend_to_referee.to_nodeptr(),
            None
        ),
        disassembled_puzzle_in_transaction
    );

    eprintln!("timeout_transaction {timeout_transaction:?}");
    eprintln!("referee puzzle curried {}", disassemble(
        allocator.allocator(),
        timeout_transaction.bundle.puzzle.to_nodeptr(),
        None
    ));

    let specific = SpecificTransactionBundle {
        coin: referee_coins[0].clone(),
        bundle: timeout_transaction.bundle.clone()
    };

    let included = s.push_tx(&mut allocator, &[specific]).expect("should work");
    assert_eq!(included.code, 1);
}

#[test]
fn test_referee_can_move_on_chain() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let agg_sig_me_additional_data = Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA);

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate");

    let their_private_key: PrivateKey = rng.gen();
    let their_identity = ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate");

    let amount = Amount::new(100);
    let timeout = Timeout::new(10);
    let max_move_size = 100;

    let debug_game = make_debug_game_handler(
        &mut allocator,
        &my_identity,
        &amount,
        &timeout
    );
    let init_state =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");

    let my_validation_program = ValidationProgram::new(
        &mut allocator,
        debug_game.my_validation_program,
    );

    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game.my_turn_handler,
        timeout: timeout.clone(),
        my_contribution_this_game: Amount::new(50),
        their_contribution_this_game: Amount::new(50),
        initial_validation_program: my_validation_program,
        initial_state: init_state,
        initial_move: vec![],
        initial_max_move_size: max_move_size,
        initial_mover_share: Amount::default(),
    };

    let _their_validation_program_hash =
        Node(debug_game.their_validation_program).sha256tree(&mut allocator);

    let mut reftest = RefereeTest::new(
        &mut allocator,
        my_identity,
        their_identity,
        debug_game.their_turn_handler,
        &game_start_info,
    );

    let readable_move = assemble(allocator.allocator(), "(100 . 0)").expect("should assemble");
    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(0));

    // Make our first move.
    let _my_move_wire_data = reftest.my_referee
        .my_turn_make_move(
            &mut rng,
            &mut allocator,
            &ReadableMove::from_nodeptr(readable_move),
        )
        .expect("should move");

    assert_eq!(reftest.my_referee.get_our_current_share(), Amount::new(100));

    // Make simulator and create referee coin.
    let s = Simulator::new();
    s.farm_block(&reftest.my_identity.puzzle_hash);

    let coins = s.get_my_coins(
        &reftest.my_identity.puzzle_hash
    ).expect("got coins");
    assert!(coins.len() > 0);

    // Create the referee coin.
    let (_, _, amt) = coins[0].to_parts().unwrap();
    eprintln!("state at start of referee object");
    let spend_to_referee = reftest.my_referee.curried_referee_puzzle_for_validator(
        &mut allocator,
    ).expect("should work");
    let referee_puzzle_hash = spend_to_referee.sha256tree(&mut allocator);
    eprintln!(
        "referee start state {}",
        disassemble(allocator.allocator(), spend_to_referee.to_nodeptr(), None)
    );
    let referee_coins = s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &reftest.my_identity,
        &reftest.my_identity.puzzle,
        &coins[0],
        &[(referee_puzzle_hash.clone(), amt.clone())]
    ).expect("should create referee coin");
    s.farm_block(&reftest.my_identity.puzzle_hash);

    // Make our move on chain.
    let move_transaction = reftest.my_referee.get_transaction_for_move(
        &mut allocator,
        &referee_coins[0],
        &agg_sig_me_additional_data
    ).expect("should work");

    eprintln!("move_transaction {move_transaction:?}");
    let specific = SpecificTransactionBundle {
        coin: referee_coins[0].clone(),
        bundle: move_transaction.bundle.clone()
    };

    let included = s.push_tx(&mut allocator, &[specific]).expect("should work");
    eprintln!("included {included:?}");
    assert_eq!(included.code, 1);
}
