use clvmr::allocator::NodePtr;

use pyo3::prelude::*;
use pyo3::types::{PyNone, PyBytes, PyTuple};

use indoc::indoc;

use crate::common::types::{ErrToError, Error, Puzzle, Amount, Hash, CoinString, CoinID, PuzzleHash, Aggsig, SpecificTransactionBundle};

// Allow simulator from rust.
struct Simulator {
    evloop: PyObject,
    sim: PyObject,
    client: PyObject,
    guard: PyObject,
    make_spend: PyObject,
    chia_rs_coin: PyObject,
}

#[cfg(test)]
impl ErrToError for PyErr {
    fn into_gen(self) -> Error {
        Error::StrErr(format!("{self:?}"))
    }
}

pub struct CoinSpend {
    coin: CoinString,
    puzzle_reveal: Puzzle,
    solution: NodePtr
}

pub struct SpendBundle {
    coin_spends: Vec<CoinSpend>,
    aggregated_signature: Aggsig
}

impl Drop for Simulator {
    fn drop(&mut self) {
        Python::with_gil(|py| -> PyResult<_> {
            let none = PyNone::get(py);
            let exit_task = self.guard.call_method1(py, "__aexit__", (none, none, none))?;
            self.evloop.call_method1(py, "run_until_complete", (exit_task,))?;
            Ok(())
        })
        .expect("should shutdown");
    }
}

impl Simulator {
    pub fn new() -> Self {
        Python::with_gil(|py| -> PyResult<_> {
            let module = PyModule::from_code(
                py,
                indoc! {"
               import asyncio
               import chia.clvm.spend_sim
               from chia.types.coin_spend import make_spend
               from chia_rs import Coin

               def start():
                   evloop = asyncio.new_event_loop()
                   sac_gen = chia.clvm.spend_sim.sim_and_client()
                   (sim, client) = evloop.run_until_complete(sac_gen.__aenter__())
                   return (evloop, sim, client, sac_gen, make_spend, Coin)
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

    pub fn farm_block(&self) {
        Python::with_gil(|py| -> PyResult<_> {
            self.async_call(py, "farm_block", ())?;
            Ok(())
        })
        .expect("should farm");
    }

    pub fn get_my_coins(&self) -> PyResult<Vec<CoinString>> {
        todo!();
    }

    pub fn make_coin(&self, coin_string: &CoinString) -> PyResult<PyObject> {
        let (parent_id, puzzle_hash, amount) =
            if let Some(parts) = coin_string.to_parts() {
                parts
            } else {
                todo!();
            };

        Python::with_gil(|py| -> PyResult<_> {
            let parent_parent_coin = PyBytes::new(py, &parent_id.bytes());
            let puzzle_hash_data = PyBytes::new(py, &puzzle_hash.bytes());
            let amt: u64 = amount.into();
            self.chia_rs_coin.call1(py, (parent_parent_coin, puzzle_hash_data, amt))
        })
    }

    fn make_coin_spend(
        &self,
        parent_coin: &CoinString,
        puzzle_reveal: Puzzle,
        solution: NodePtr
    ) -> PyResult<CoinSpend> {
        todo!();
    }

    pub fn perform_spend(&self, tx: &[SpecificTransactionBundle]) -> PyResult<()> {
        todo!();
    }
}

#[test]
fn test_sim() {
    let s = Simulator::new();
    s.farm_block();
    let c = s.make_coin(&CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &Amount::default()));
}
