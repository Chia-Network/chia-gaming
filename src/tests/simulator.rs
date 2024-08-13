use std::cell::RefCell;

use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::allocator::NodePtr;

use clvm_tools_rs::compiler::comptypes::map_m;

use indoc::indoc;
use log::debug;

use pyo3::exceptions::PyIndexError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyNone, PyTuple};

use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN};
use crate::common::standard_coin::{
    agg_sig_me_message, sign_agg_sig_me, solution_for_conditions, standard_solution_partial,
    ChiaIdentity,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, ErrToError, Error, Hash, IntoErr,
    Node, Program, Puzzle, PuzzleHash, Sha256tree, Spend, ToQuotedProgram,
};

#[derive(Debug, Clone)]
pub struct IncludeTransactionResult {
    pub code: u32,
    #[allow(dead_code)]
    pub e: Option<u32>,
    #[allow(dead_code)]
    pub diagnostic: String,
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
    coin_as_list: PyObject,
    height: RefCell<usize>,
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
            let exit_task = self
                .guard
                .call_method1(py, "__aexit__", (none, none, none))?;
            self.evloop
                .call_method1(py, "run_until_complete", (exit_task,))?;
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
        return Some(
            e[(p + 2)..(e.len() - 1)]
                .parse::<u32>()
                .expect("should parse"),
        );
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
        diagnostic: e,
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

        let conditions_vec = map_m(
            |(ph, amt): &(PuzzleHash, Amount)| -> Result<Node, Error> {
                Ok(Node(
                    (CREATE_COIN, (ph.clone(), (amt.clone(), ())))
                        .to_clvm(allocator)
                        .into_gen()?,
                ))
            },
            target_coins,
        )?;
        let conditions = conditions_vec.to_clvm(allocator).into_gen()?;

        let coin_spend_info = standard_solution_partial(
            allocator,
            &identity.synthetic_private_key,
            &coin.to_coin_id(),
            conditions,
            &identity.synthetic_public_key,
            &agg_sig_me_additional_data,
            false,
        )
        .expect("should build");

        let quoted_conds = conditions
            .to_quoted_program(allocator)
            .expect("should work");
        let hashed_conds = quoted_conds.sha256tree(allocator);
        let agg_sig_me_message = agg_sig_me_message(
            &hashed_conds.bytes(),
            &coin.to_coin_id(),
            &agg_sig_me_additional_data,
        );
        debug!("our message {agg_sig_me_message:?}");
        let signature2 = identity.synthetic_private_key.sign(&agg_sig_me_message);
        assert_eq!(coin_spend_info.signature, signature2);

        let specific = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(allocator, coin_spend_info.solution)?,
                signature: coin_spend_info.signature,
            },
        };

        let status = self.push_tx(allocator, &[specific]).expect("should spend");
        if status.code == 3 {
            return Err(Error::StrErr("failed to spend coin".to_string()));
        }

        Ok(target_coins
            .iter()
            .map(|(ph, amt)| CoinString::from_parts(&coin.to_coin_id(), ph, amt))
            .collect())
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
                height: RefCell::new(0),
            })
        })
        .expect("should work")
    }

    fn async_call<ArgT>(&self, py: Python<'_>, name: &str, args: ArgT) -> PyResult<PyObject>
    where
        ArgT: IntoPy<Py<PyTuple>>,
    {
        let coro = self.sim.call_method1(py, name, args)?;
        let task = self
            .evloop
            .call_method1(py, "create_task", (coro.clone(),))?;
        self.evloop
            .call_method1(py, "run_until_complete", (task.clone(),))?;
        let res = task.call_method0(py, "result")?;
        Ok(res.into())
    }

    fn async_client<ArgT>(&self, py: Python<'_>, name: &str, args: ArgT) -> PyResult<PyObject>
    where
        ArgT: IntoPy<Py<PyTuple>>,
    {
        let task = self.client.call_method1(py, name, args)?;
        let res = self
            .evloop
            .call_method1(py, "run_until_complete", (task,))?;
        Ok(res.into())
    }

    pub fn farm_block(&self, puzzle_hash: &PuzzleHash) {
        Python::with_gil(|py| -> PyResult<()> {
            let puzzle_hash_bytes = PyBytes::new(py, &puzzle_hash.bytes());
            self.async_call(py, "farm_block", (puzzle_hash_bytes,))?;
            let old_height = *self.height.borrow();
            self.height.replace(old_height + 1);
            Ok(())
        })
        .expect("should farm")
    }

    pub fn get_current_height(&self) -> usize {
        *self.height.borrow()
    }

    fn convert_coin_list_to_coin_strings(
        &self,
        py: Python<'_>,
        coins: &PyObject,
    ) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let items: Vec<PyObject> = coins.extract(py)?;
            debug!("num coins {}", items.len());
            let mut result_coins = Vec::new();
            for i in items.iter() {
                let coin_of_item: PyObject = if let Ok(res) = i.getattr(py, "coin") {
                    res.extract(py)?
                } else {
                    i.extract(py)?
                };
                let as_list_str: String = coin_of_item.call_method0(py, "__repr__")?.extract(py)?;
                debug!("as_list_str {as_list_str}");
                let as_list: Vec<PyObject> =
                    self.coin_as_list.call1(py, (coin_of_item,))?.extract(py)?;
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
                    &Amount::new(amount),
                ));
            }
            Ok(result_coins)
        })
    }

    pub fn get_all_coins(&self) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let coins = self.async_call(py, "all_non_reward_coins", ())?;
            self.convert_coin_list_to_coin_strings(py, &coins)
        })
    }

    pub fn get_my_coins(&self, puzzle_hash: &PuzzleHash) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let hash_bytes = PyBytes::new(py, &puzzle_hash.bytes());
            let coins =
                self.async_client(py, "get_coin_records_by_puzzle_hash", (hash_bytes, false))?;
            self.convert_coin_list_to_coin_strings(py, &coins)
        })
    }

    pub fn g2_element(&self, aggsig: &Aggsig) -> PyResult<PyObject> {
        Python::with_gil(|py| -> PyResult<_> {
            let bytes = PyBytes::new(py, &aggsig.bytes());
            self.g2_element
                .call_method1(py, "from_bytes_unchecked", (bytes,))
        })
    }

    pub fn make_coin(&self, coin_string: &CoinString) -> PyResult<PyObject> {
        let (parent_id, puzzle_hash, amount) = if let Some(parts) = coin_string.to_parts() {
            parts
        } else {
            panic!("coin string didn't parse");
        };

        Python::with_gil(|py| -> PyResult<_> {
            let parent_parent_coin = PyBytes::new(py, &parent_id.bytes());
            let puzzle_hash_data = PyBytes::new(py, &puzzle_hash.bytes());
            let amt: u64 = amount.into();
            self.chia_rs_coin
                .call1(py, (parent_parent_coin, puzzle_hash_data, amt))
        })
    }

    pub fn hex_to_program(&self, hex: &str) -> PyResult<PyObject> {
        Python::with_gil(|py| -> PyResult<_> { self.program.call_method1(py, "fromhex", (hex,)) })
    }

    pub fn make_coin_spend(
        &self,
        py: Python<'_>,
        allocator: &mut AllocEncoder,
        parent_coin: &CoinString,
        puzzle_reveal: Puzzle,
        solution: NodePtr,
    ) -> PyResult<PyObject> {
        let coin = self.make_coin(parent_coin)?;
        debug!("coin = {coin:?}");
        let puzzle_hex = puzzle_reveal.to_hex();
        let puzzle_program = self.hex_to_program(&puzzle_hex)?;
        debug!("puzzle_program = {puzzle_program:?}");
        let solution_hex = Node(solution).to_hex(allocator);
        let solution_program = self.hex_to_program(&solution_hex)?;
        debug!("solution_program = {solution_program:?}");
        self.make_spend
            .call1(py, (coin, puzzle_program, solution_program))
    }

    pub fn make_spend_bundle(
        &self,
        allocator: &mut AllocEncoder,
        txs: &[CoinSpend],
    ) -> PyResult<PyObject> {
        Python::with_gil(|py| {
            let mut spends = Vec::new();
            if txs.is_empty() {
                return Err(PyErr::from_value(
                    PyIndexError::new_err("some type error").value(py).into(),
                ));
            }

            let mut signature = txs[0].bundle.signature.clone();
            for (i, tx) in txs.iter().enumerate() {
                let spend_args = tx.bundle.solution.to_clvm(allocator).map_err(|e| {
                    PyErr::from_value(PyIndexError::new_err(format!("{e:?}")).value(py).into())
                })?;
                let spend = self.make_coin_spend(
                    py,
                    allocator,
                    &tx.coin,
                    tx.bundle.puzzle.clone(),
                    spend_args,
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
        txs: &[CoinSpend],
    ) -> PyResult<IncludeTransactionResult> {
        let spend_bundle = self.make_spend_bundle(allocator, txs)?;
        Python::with_gil(|py| {
            debug!("spend_bundle {:?}", spend_bundle);
            let spend_res: PyObject = self
                .async_client(py, "push_tx", (spend_bundle,))?
                .extract(py)?;
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
        let (_parent, _, amt) = if let Some(p) = source_coin.to_parts() {
            p
        } else {
            return Err(Error::StrErr("failed to parse coin string".to_string()));
        };

        let change_amt = amt.clone() - target_amt.clone();
        let first_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_target.puzzle_hash,
            &target_amt,
        );
        let second_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_source.puzzle_hash,
            &change_amt,
        );

        let conditions = (
            (
                CREATE_COIN,
                (
                    identity_target.puzzle_hash.clone(),
                    (target_amt.clone(), ()),
                ),
            ),
            (
                (
                    CREATE_COIN,
                    (identity_source.puzzle_hash.clone(), (change_amt, ())),
                ),
                (),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;
        let quoted_conditions = conditions.to_quoted_program(allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
        let standard_solution = solution_for_conditions(allocator, conditions)?;
        let signature = sign_agg_sig_me(
            &identity_source.synthetic_private_key,
            &quoted_conditions_hash.bytes(),
            &source_coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            bundle: Spend {
                puzzle: identity_source.puzzle.clone(),
                solution: Program::from_nodeptr(allocator, standard_solution)?,
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
            let (_, _, amt) = if let Some(p) = c.to_parts() {
                p
            } else {
                return Err(Error::StrErr("improper coin string".to_string()));
            };
            amount += amt.clone();
            let conditions = if i == coins.len() - 1 {
                ((CREATE_COIN, (target_ph.clone(), (amount.clone(), ()))), ())
                    .to_clvm(allocator)
                    .into_gen()?
            } else {
                nil
            };
            let solution = solution_for_conditions(allocator, conditions)?;
            let quoted_conditions = conditions.to_quoted_program(allocator)?;
            let quoted_conditions_hash = quoted_conditions.sha256tree(allocator);
            let signature = sign_agg_sig_me(
                &owner.synthetic_private_key,
                &quoted_conditions_hash.bytes(),
                &c.to_coin_id(),
                &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
            );
            spends.push(CoinSpend {
                bundle: Spend {
                    puzzle: owner.puzzle.clone(),
                    solution: Program::from_nodeptr(allocator, solution)?,
                    signature,
                },
                coin: c.clone(),
            });
        }

        let included = self.push_tx(allocator, &spends).into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!("failed to spend: {included:?}")));
        }

        Ok(CoinString::from_parts(
            &coins[coins.len() - 1].to_coin_id(),
            target_ph,
            &amount,
        ))
    }
}
