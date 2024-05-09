use pyo3::prelude::*;
use pyo3::types::{PyNone, PyTuple};

use indoc::indoc;

use crate::common::types::{ErrToError, Error, IntoErr};

// Allow simulator from rust.
struct Simulator {
    evloop: PyObject,
    sim: PyObject,
    client: PyObject,
    guard: PyObject,
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

               def start():
                   evloop = asyncio.new_event_loop()
                   sac_gen = chia.clvm.spend_sim.sim_and_client()
                   (sim, client) = evloop.run_until_complete(sac_gen.__aenter__())
                   return (evloop, sim, client, sac_gen)
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
            })
        })
        .expect("should work")
    }

    pub fn farm_block(&self) {
        Python::with_gil(|py| -> PyResult<_> {
            let farm_task = self.sim.call_method0(py, "farm_block")?;
            self.evloop
                .call_method1(py, "run_until_complete", (farm_task,))?;
            Ok(())
        })
        .expect("should farm");
    }
}

#[test]
fn test_sim() {
    let s = Simulator::new();
    s.farm_block();
}
