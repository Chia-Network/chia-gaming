use std::collections::HashMap;
use std::rc::Rc;

use clvm_traits::{ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::{AllocEncoder, Error, Hash, Program, ProgramRef, Sha256tree};
use serde::{Deserialize, Serialize};

/// Represents a validation program, as opposed to validation info or any of the
/// other kinds of things that are related.  Exposes the program's hash via
/// `hash()`; computing a validation *info* hash requires `ValidationInfo`.
#[derive(Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct StateUpdateProgram {
    name: String,
    state_update_program: ProgramRef,
    state_update_program_hash: Hash,
}

#[derive(Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct ValidationProgramRegistry {
    initial_hash: Hash,
    programs: HashMap<Hash, StateUpdateProgram>,
}

impl std::fmt::Debug for ValidationProgramRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        formatter
            .debug_struct("ValidationProgramRegistry")
            .field("initial_hash", &self.initial_hash)
            .field("program_count", &self.programs.len())
            .finish()
    }
}

impl std::fmt::Debug for StateUpdateProgram {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(
            formatter,
            "StateUpdateProgram\n    name={}\n    hash={:?}\n",
            self.name, self.state_update_program_hash,
        )
    }
}

impl StateUpdateProgram {
    pub fn new(
        allocator: &mut AllocEncoder,
        name: &str,
        state_update_program: Rc<Program>,
    ) -> Self {
        let state_update_program_hash = state_update_program.sha256tree(allocator).hash().clone();
        StateUpdateProgram {
            name: name.to_string(),
            state_update_program: state_update_program.into(),
            state_update_program_hash,
        }
    }

    pub fn new_hash(
        state_update_program: Rc<Program>,
        name: &str,
        state_update_program_hash: Hash,
    ) -> Self {
        StateUpdateProgram {
            name: name.to_string(),
            state_update_program: state_update_program.into(),
            state_update_program_hash,
        }
    }

    pub fn to_program(&self) -> Rc<Program> {
        self.state_update_program.p()
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.state_update_program.to_nodeptr(allocator)
    }

    pub fn hash(&self) -> &Hash {
        &self.state_update_program_hash
    }

    pub fn is_nil(&self) -> bool {
        self.to_program().is_nil()
    }
}

impl ValidationProgramRegistry {
    pub fn new(
        allocator: &mut AllocEncoder,
        programs: &[Rc<Program>],
    ) -> Result<ValidationProgramRegistry, Error> {
        let mut by_hash = HashMap::with_capacity(programs.len());
        let mut initial_hash = None;
        for (index, program) in programs.iter().enumerate() {
            if program.is_nil() {
                return Err(Error::StrErr(format!(
                    "factory validation program at index {index} is nil"
                )));
            }
            let hash = program.sha256tree(allocator).hash().clone();
            let state_update_program = StateUpdateProgram::new_hash(
                program.clone(),
                &format!("factory validator {}", hex::encode(hash.bytes())),
                hash,
            );
            if index == 0 {
                initial_hash = Some(state_update_program.hash().clone());
            }
            if by_hash
                .insert(state_update_program.hash().clone(), state_update_program)
                .is_some()
            {
                return Err(Error::StrErr(format!(
                    "duplicate factory validation program at index {index}"
                )));
            }
        }
        let initial_hash = initial_hash
            .ok_or_else(|| Error::StrErr("factory returned no validation programs".to_string()))?;
        Ok(ValidationProgramRegistry {
            initial_hash,
            programs: by_hash,
        })
    }

    pub fn initial(&self) -> StateUpdateProgram {
        self.programs[&self.initial_hash].clone()
    }

    pub fn initial_hash(&self) -> &Hash {
        &self.initial_hash
    }

    pub fn resolve(&self, hash: &Hash) -> Result<StateUpdateProgram, Error> {
        self.programs.get(hash).cloned().ok_or_else(|| {
            Error::StrErr(format!(
                "validator transition returned unregistered program hash {}",
                hex::encode(hash.bytes())
            ))
        })
    }

    pub fn len(&self) -> usize {
        self.programs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.programs.is_empty()
    }
}

impl ToClvm<AllocEncoder> for StateUpdateProgram {
    fn to_clvm(&self, encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        self.state_update_program.to_clvm(encoder)
    }
}

pub trait HasStateUpdateProgram {
    fn p(&self) -> StateUpdateProgram;
    fn name(&self) -> String {
        self.p().name.clone()
    }
}

impl HasStateUpdateProgram for StateUpdateProgram {
    fn p(&self) -> StateUpdateProgram {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_programs_and_rejects_unknown_hashes() {
        let mut allocator = AllocEncoder::new();
        let first = Rc::new(Program::from_bytes(&[0x01]).expect("quoted atom"));
        let second = Rc::new(Program::from_bytes(&[0x02]).expect("apply operator"));
        let third = Rc::new(Program::from_bytes(&[0x03]).expect("if operator"));
        let registry = ValidationProgramRegistry::new(
            &mut allocator,
            &[first.clone(), second.clone(), third.clone()],
        )
        .expect("registry");
        let reordered =
            ValidationProgramRegistry::new(&mut allocator, &[first.clone(), third, second.clone()])
                .expect("reordered registry");

        assert_eq!(registry.initial().to_program(), first);
        assert_eq!(registry, reordered);
        let second_hash = second.sha256tree(&mut allocator).hash().clone();
        assert_eq!(registry.resolve(&second_hash).unwrap().to_program(), second);
        assert!(registry.resolve(&Hash::from_bytes([0x55; 32])).is_err());
        assert!(
            ValidationProgramRegistry::new(&mut allocator, &[Rc::new(Program::nil())]).is_err()
        );
    }
}
