pub mod service;
pub mod tests;

use std::backtrace::Backtrace;
use std::cell::RefCell;

use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::allocator::NodePtr;

use crate::utils::map_m;

use indoc::indoc;
use log::debug;

use pyo3::exceptions::PyBaseException;
use pyo3::ffi::c_str;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyNone, PyTuple};

use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN};
use crate::common::standard_coin::{
    agg_sig_me_message, sign_agg_sig_me, solution_for_conditions, standard_solution_partial,
    ChiaIdentity,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinSpend, CoinString, ErrToError, Error,
    GetCoinStringParts, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash, Sha256tree, Spend,
    ToQuotedProgram,
};

use crate::simulator::service::service_main;
use crate::simulator::tests::potato_handler_sim::test_funs as potato_handler_sim_tests;
use crate::simulator::tests::simenv::test_funs as simenv_tests;
use crate::test_support::calpoker::test_funs as calpoker_tests;

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

impl ErrToError for PyErr {
    fn into_gen(self) -> Error {
        Error::StrErr(format!("{self:?}"))
    }
}

impl From<Error> for pyo3::PyErr {
    fn from(other: Error) -> Self {
        Python::with_gil(|_py| -> pyo3::PyErr { PyBaseException::new_err(format!("{other:?}")) })
    }
}

impl Drop for Simulator {
    fn drop(&mut self) {
        Python::with_gil(|py| -> PyResult<_> {
            let none: Py<PyAny> = PyNone::get(py).to_owned().unbind().into();
            let exit_task = self.guard.call_method1(
                py,
                "__aexit__",
                (none.clone_ref(py), none.clone_ref(py), none.clone_ref(py)),
            )?;
            self.evloop
                .call_method1(py, "run_until_complete", (exit_task,))?;
            self.evloop.call_method0(py, "stop")?;
            self.evloop.call_method0(py, "close")?;

            self.evloop = none.clone_ref(py);
            self.sim = none.clone_ref(py);
            self.client = none.clone_ref(py);
            self.guard = none.clone_ref(py);
            self.make_spend = none.clone_ref(py);
            self.chia_rs_coin = none.clone_ref(py);
            self.program = none.clone_ref(py);
            self.spend_bundle = none.clone_ref(py);
            self.g2_element = none.clone_ref(py);
            self.coin_as_list = none.clone_ref(py);
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

impl Default for Simulator {
    fn default() -> Self {
        // https://github.com/PyO3/pyo3/issues/1741
        #[cfg(target_os = "macos")]
        if let Ok(venv) = std::env::var("VIRTUAL_ENV") {
            Python::with_gil(|py| -> PyResult<_> {
                let version_info = py.version_info();
                let sys = py.import("sys").unwrap();
                let sys_path = sys.getattr("path").unwrap();
                sys_path
                    .call_method1(
                        "insert",
                        (
                            0,
                            format!(
                                "{}/lib/python{}.{}/site-packages",
                                venv, version_info.major, version_info.minor
                            ),
                        ),
                    )
                    .unwrap();
                Ok(())
            })
            .unwrap();
        }

        Python::with_gil(|py| -> PyResult<_> {
            let module = PyModule::from_code(
                py,
                c_str!(indoc! {"
               import asyncio
               from chia.types.coin_spend import make_spend
               from chia_rs import Coin, G2Element
               from chia.types.blockchain_format.program import Program
               from chia.wallet.wallet_spend_bundle import WalletSpendBundle as SpendBundle
               from chia.types.blockchain_format.coin import coin_as_list
               from chia._tests.util.spend_sim import sim_and_client

               def start():
                   evloop = asyncio.new_event_loop()
                   sac_gen = sim_and_client()
                   (sim, client) = evloop.run_until_complete(sac_gen.__aenter__())
                   return (evloop, sim, client, sac_gen, make_spend, Coin, Program, SpendBundle, G2Element, coin_as_list)
            "}),
                c_str!("tmod.py"),
                c_str!("tmod"),
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
        let (_first_coin_parent, first_coin_ph, _first_coin_amt) = coin.get_coin_string_parts()?;
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
            hashed_conds.bytes(),
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
                solution: coin_spend_info.solution.clone(),
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

    fn async_call<'a>(
        &self,
        py: Python<'a>,
        name: &str,
        args: Bound<'_, PyTuple>,
    ) -> PyResult<PyObject> {
        let coro = self.sim.call_method1(py, name, args)?;
        let task = self
            .evloop
            .call_method1(py, "create_task", (coro.clone_ref(py),))?;
        self.evloop
            .call_method1(py, "run_until_complete", (task.clone_ref(py),))?;
        let res = task.call_method0(py, "result")?;
        Ok(res)
    }

    fn async_client<'a>(
        &self,
        py: Python<'a>,
        name: &str,
        args: Bound<'_, PyTuple>,
    ) -> PyResult<PyObject> {
        let task = self.client.call_method1(py, name, args)?;
        let res = self
            .evloop
            .call_method1(py, "run_until_complete", (task,))?;
        Ok(res)
    }

    pub fn farm_block(&self, puzzle_hash: &PuzzleHash) {
        Python::with_gil(|py| -> PyResult<()> {
            let puzzle_hash_bytes = PyBytes::new(py, puzzle_hash.bytes());
            self.async_call(py, "farm_block", PyTuple::new(py, vec![puzzle_hash_bytes])?)?;
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
        _py: Python<'_>,
        coins: &PyObject,
    ) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let items: Vec<PyObject> = coins.extract(py)?;
            let mut result_coins = Vec::new();
            for i in items.iter() {
                let coin_of_item: PyObject = if let Ok(res) = i.getattr(py, "coin") {
                    res.extract(py)?
                } else {
                    i.extract(py)?
                };
                let as_list: Vec<PyObject> =
                    self.coin_as_list.call1(py, (coin_of_item,))?.extract(py)?;
                let parent_coin_info: &Bound<'_, PyBytes> = as_list[0].downcast_bound(py)?;
                let parent_coin_info_slice: &[u8] = parent_coin_info.extract()?;
                let puzzle_hash: &Bound<'_, PyBytes> = as_list[1].downcast_bound(py)?;
                let puzzle_hash_slice: &[u8] = puzzle_hash.extract()?;
                let amount: u64 = as_list[2].extract(py)?;
                let parent_coin_hash = Hash::from_slice(parent_coin_info_slice);
                let puzzle_hash = Hash::from_slice(puzzle_hash_slice);
                let new_coin = CoinString::from_parts(
                    &CoinID::new(parent_coin_hash),
                    &PuzzleHash::from_hash(puzzle_hash),
                    &Amount::new(amount),
                );
                result_coins.push(new_coin);
            }
            Ok(result_coins)
        })
    }

    pub fn get_all_coins(&self) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let elements: Vec<Bound<'_, PyAny>> = Vec::new();
            let coins = self.async_call(py, "all_non_reward_coins", PyTuple::new(py, elements)?)?;
            self.convert_coin_list_to_coin_strings(py, &coins)
        })
    }

    pub fn get_my_coins(&self, puzzle_hash: &PuzzleHash) -> PyResult<Vec<CoinString>> {
        Python::with_gil(|py| -> PyResult<_> {
            let hash_bytes = PyBytes::new(py, puzzle_hash.bytes());
            let hash_bytes_object: Bound<'_, PyBytes> = hash_bytes.into_pyobject(py)?;
            let false_object: Bound<'_, PyBool> = false.into_pyobject(py)?.to_owned();
            let args_any: Vec<Bound<'_, PyAny>> =
                vec![hash_bytes_object.into_any(), false_object.into_any()];
            let coins = self.async_client(
                py,
                "get_coin_records_by_puzzle_hash",
                PyTuple::new(py, args_any)?,
            )?;
            self.convert_coin_list_to_coin_strings(py, &coins)
        })
    }

    pub fn get_puzzle_and_solution(
        &self,
        coin_id: &CoinID,
    ) -> PyResult<Option<(Program, Program)>> {
        Python::with_gil(|py| -> PyResult<_> {
            let hash_bytes = PyBytes::new(py, coin_id.bytes());
            let hash_bytes_object: Bound<'_, PyBytes> = hash_bytes.into_pyobject(py)?;
            let record = self.async_client(
                py,
                "get_coin_record_by_name",
                PyTuple::new(py, vec![hash_bytes_object.clone()])?,
            )?;
            let height_of_spend =
                if let Ok(height_of_spend) = record.getattr(py, "spent_block_index") {
                    height_of_spend
                } else {
                    return Ok(None);
                };
            let height_of_spend: Bound<'_, PyAny> = height_of_spend.into_pyobject(py)?;
            let args_vec: Vec<Bound<'_, PyAny>> =
                vec![hash_bytes_object.into_any(), height_of_spend];
            let puzzle_and_solution =
                self.async_client(py, "get_puzzle_and_solution", PyTuple::new(py, args_vec)?)?;
            let puzzle_reveal: PyObject = puzzle_and_solution.getattr(py, "puzzle_reveal")?;
            let solution: PyObject = puzzle_and_solution.getattr(py, "solution")?;

            let puzzle_str: Vec<u8> = puzzle_reveal.call_method0(py, "__bytes__")?.extract(py)?;
            let solution_str: Vec<u8> = solution.call_method0(py, "__bytes__")?.extract(py)?;
            Ok(Some((
                Program::from_bytes(&puzzle_str),
                Program::from_bytes(&solution_str),
            )))
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
        let (parent_id, puzzle_hash, amount) = coin_string.get_coin_string_parts()?;

        Python::with_gil(|py| -> PyResult<_> {
            let parent_parent_coin = PyBytes::new(py, parent_id.bytes());
            let puzzle_hash_data = PyBytes::new(py, puzzle_hash.bytes());
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
        let puzzle_hex = puzzle_reveal.to_hex();
        let puzzle_program = self.hex_to_program(&puzzle_hex)?;
        let solution_hex = Node(solution)
            .to_hex(allocator)
            .map_err(|_| PyBaseException::new_err("failed hex conversion"))?;
        let solution_program = self
            .hex_to_program(&solution_hex)
            .map_err(|_| PyBaseException::new_err("failed hex conversion"))?;
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
                return Err(PyBaseException::new_err("some type error"));
            }

            let mut signature = txs[0].bundle.signature.clone();
            for (i, tx) in txs.iter().enumerate() {
                let spend_args = tx
                    .bundle
                    .solution
                    .to_clvm(allocator)
                    .map_err(|e| PyBaseException::new_err(format!("{e:?}")))?;
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
            let spend_res: PyObject = self
                .async_client(py, "push_tx", PyTuple::new(py, vec![spend_bundle])?)?
                .extract(py)?;
            to_spend_result(py, spend_res)
        })
    }

    /// Create a coin belonging to identity_target which currently belongs
    /// to identity_source.  Return change to identity_source.
    pub fn transfer_coin_amount(
        &self,
        allocator: &mut AllocEncoder,
        identity_target: &PuzzleHash,
        identity_source: &ChiaIdentity,
        source_coin: &CoinString,
        target_amt: Amount,
    ) -> Result<(CoinString, CoinString), Error> {
        let (_parent, _, amt) = source_coin.get_coin_string_parts()?;

        let change_amt = amt.clone() - target_amt.clone();
        let first_coin =
            CoinString::from_parts(&source_coin.to_coin_id(), identity_target, &target_amt);
        let second_coin = CoinString::from_parts(
            &source_coin.to_coin_id(),
            &identity_source.puzzle_hash,
            &change_amt,
        );

        let conditions = (
            (
                CREATE_COIN,
                (identity_target.clone(), (target_amt.clone(), ())),
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
            quoted_conditions_hash.bytes(),
            &source_coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            bundle: Spend {
                puzzle: identity_source.puzzle.clone(),
                solution: Program::from_nodeptr(allocator, standard_solution)?.into(),
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
        let nil = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[]))
            .into_gen()?;

        if coins.is_empty() {
            return Err(Error::StrErr("no coins".to_string()));
        }

        for (i, c) in coins.iter().enumerate() {
            let (_, _, amt) = c.get_coin_string_parts()?;
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
                quoted_conditions_hash.bytes(),
                &c.to_coin_id(),
                &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
            );
            spends.push(CoinSpend {
                bundle: Spend {
                    puzzle: owner.puzzle.clone(),
                    solution: Program::from_nodeptr(allocator, solution)?.into(),
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

#[pyfunction]
#[pyo3(signature = (choices = Vec::new()))]
fn run_simulation_tests(choices: Vec<String>) {
    std::panic::set_hook(Box::new(|_| {
        let trace = Backtrace::capture();
        eprintln!("\n    ---- Captured Backtrace from last PANIC ----\n{trace}");
    }));
    if let Err(e) = std::panic::catch_unwind(|| {
        let ref_lists = [
            &simenv_tests(),
            &calpoker_tests(),
            &potato_handler_sim_tests(),
        ];
        for test_set in ref_lists.iter() {
            for (name, f) in test_set.iter() {
                if choices.is_empty() || choices.iter().any(|choice| name.contains(choice)) {
                    eprintln!("{} ...", name);
                    f();
                    eprintln!("{} ... ok\n", name);
                }
            }
        }
    }) {
        eprintln!("panic: {e:?}");
        std::process::exit(1);
    }
}

#[pymodule]
fn chia_gaming(_py: Python, m: Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(run_simulation_tests, &m)?)?;
    m.add_function(wrap_pyfunction!(service_main, &m)?)?;
    Ok(())
}
