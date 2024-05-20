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
use crate::common::types::{ErrToError, Error, Puzzle, Amount, Hash, CoinString, CoinID, PuzzleHash, PrivateKey, Aggsig, Node, SpecificTransactionBundle, AllocEncoder, TransactionBundle};
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

    pub fn make_spend_bundle(
        &self,
        allocator: &mut AllocEncoder,
        tx: &SpecificTransactionBundle
    ) -> PyResult<PyObject> {
        Python::with_gil(|py| {
            let spend = self.make_coin_spend(
                py,
                allocator,
                &tx.coin,
                tx.bundle.puzzle.clone(),
                tx.bundle.solution
            )?;
            let signature = self.g2_element(&tx.bundle.signature)?;
            self.spend_bundle.call1(py, ([spend], signature))
        })
    }

    pub fn push_tx(
        &self,
        allocator: &mut AllocEncoder,
        tx: &SpecificTransactionBundle
    ) -> PyResult<u32> {
        let spend_bundle = self.make_spend_bundle(allocator, tx)?;
        Python::with_gil(|py| {
            eprintln!("spend_bundle {:?}", spend_bundle);
            let spend_res: PyObject = self.async_client(
                py,
                "push_tx",
                (spend_bundle,)
            )?.extract(py)?;
            eprintln!("spend_res {:?}", spend_res);
            let (inclusion_status, err): (PyObject, PyObject) = spend_res.extract(py)?;
            eprintln!("inclusion_status {inclusion_status}");
            let status: u32 = inclusion_status.extract(py)?;
            Ok(status)
        })
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
    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");
    eprintln!("coins {coins:?}");

    let (first_coin_parent, first_coin_ph, first_coin_amt) = coins[0].to_parts().unwrap();
    assert_eq!(first_coin_ph, identity.puzzle_hash);

    let conditions = [
        (CREATE_COIN,
         (identity.puzzle_hash.clone(),
          (Amount::new(1), ())
         )
        ),
        (CREATE_COIN,
         (identity.puzzle_hash.clone(),
          (first_coin_amt - Amount::new(1), ())
         )
        )
    ].to_clvm(&mut allocator).expect("should create conditions");

    let (solution, signature) = standard_solution(
        &mut allocator,
        &private_key,
        conditions
    ).expect("should build");

    let spend =
        Python::with_gil(|py| {
            s.make_coin_spend(
                py,
                &mut allocator,
                &CoinString::from_parts(&CoinID::default(), &PuzzleHash::default(), &Amount::default()),
                identity.puzzle.clone(),
                solution
            )
        }).expect("should get a spend");

    eprintln!("spend {spend:?}");

    let specific = SpecificTransactionBundle {
        coin: coins[0].clone(),
        bundle: TransactionBundle {
            puzzle: identity.puzzle.clone(),
            solution,
            signature,
        }
    };

    let status = s.push_tx(&mut allocator, &specific).expect("should spend");

    // Do at end
    drop(s);
    assert_ne!(status, 3);
}