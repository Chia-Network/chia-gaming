use clvmr::allocator::NodePtr;
use clvm_traits::ToClvm;

use pyo3::prelude::*;
use pyo3::types::{PyNone, PyBytes, PyTuple};
use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use indoc::indoc;

use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::standard_solution;
use crate::common::types::{ErrToError, Error, Puzzle, Amount, Hash, CoinString, CoinID, PuzzleHash, PrivateKey, Aggsig, Node, SpecificTransactionBundle, AllocEncoder};
use crate::common::standard_coin::ChiaIdentity;

// Allow simulator from rust.
struct Simulator {
    evloop: PyObject,
    sim: PyObject,
    client: PyObject,
    guard: PyObject,
    make_spend: PyObject,
    chia_rs_coin: PyObject,
    program: PyObject,
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
               from chia.types.blockchain_format.program import Program

               def start():
                   evloop = asyncio.new_event_loop()
                   sac_gen = chia.clvm.spend_sim.sim_and_client()
                   (sim, client) = evloop.run_until_complete(sac_gen.__aenter__())
                   return (evloop, sim, client, sac_gen, make_spend, Coin, Program)
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

    pub fn farm_block(&self, private_key: &PrivateKey) {
        Python::with_gil(|py| -> PyResult<_> {
            let private_key_bytes = PyBytes::new(py, &private_key.bytes());
            self.async_call(py, "farm_block", (private_key_bytes,))?;
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

    pub fn perform_spend(&self, tx: &[SpecificTransactionBundle]) -> PyResult<()> {
        todo!();
    }
}

#[test]
fn test_sim() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::new();
    let private_key: PrivateKey = rng.gen();
    s.farm_block(&private_key);
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    let conditions = (
        (CREATE_COIN,
         (identity.puzzle_hash.clone(),
          (Amount::new(1), ())
         )
        ), ()
    ).to_clvm(&mut allocator).expect("should create conditions");
    let (solution, signature) = standard_solution(
        &mut allocator,
        &private_key,
        conditions
    ).expect("should build");
    let s =
        Python::with_gil(|py| {
            s.make_coin_spend(
                py,
                &mut allocator,
                &CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &Amount::default()),
                identity.puzzle.clone(),
                solution
            )
        }).expect("should get a spend");
    eprintln!("spend {s:?}");
}
