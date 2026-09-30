//! Lazy diagnostics for application-owned CLVM execution.
//!
//! Consensus bundle validation remains an external-library gap:
//! `chia_consensus::spendbundle_conditions::run_spendbundle` owns its allocator,
//! dialect flags, and bundle-wide cost accounting and returns an `ErrorCode`,
//! not the underlying `EvalErr` or a pre-eval callback. Re-running individual
//! spends here would not faithfully replay those consensus semantics.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt;
use std::rc::Rc;

use chialisp::compiler::debug_metadata::{
    format_stack_frame, DebugMetadata, FrameMatch, StackFrameStyle,
};
use clvmr::allocator::{Allocator, NodePtr, SExp};
use clvmr::error::EvalErr;
use clvmr::reduction::Reduction;
use clvmr::serde::{node_from_bytes, node_to_bytes_limit};
use clvmr::{run_program, run_program_with_pre_eval};
use serde::{Deserialize, Serialize};

use crate::common::types::{chia_dialect, Error};

const MAX_CAPSULES: usize = 16;
const MAX_CAPSULE_BYTES: usize = 512 * 1024;
const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DiagnosticToken(u64);

impl fmt::Debug for DiagnosticToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, formatter)
    }
}

impl fmt::Display for DiagnosticToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "clvm-{:016x}", self.0)
    }
}

#[derive(Debug)]
struct DiagnosticCapsule {
    program: Vec<u8>,
    environment: Vec<u8>,
    max_cost: u64,
    dialect: &'static str,
    original_error: String,
}

impl DiagnosticCapsule {
    fn size(&self) -> usize {
        self.program.len() + self.environment.len() + self.original_error.len() + self.dialect.len()
    }
}

#[derive(Default)]
struct DiagnosticRegistry {
    next_token: u64,
    bytes: usize,
    entries: VecDeque<(DiagnosticToken, DiagnosticCapsule)>,
}

impl DiagnosticRegistry {
    fn insert(&mut self, capsule: DiagnosticCapsule) -> Option<DiagnosticToken> {
        let size = capsule.size();
        if size > MAX_CAPSULE_BYTES {
            return None;
        }
        while self.entries.len() >= MAX_CAPSULES || self.bytes + size > MAX_REGISTRY_BYTES {
            let (_, retired) = self.entries.pop_front()?;
            self.bytes -= retired.size();
        }
        self.next_token = self.next_token.wrapping_add(1).max(1);
        let token = DiagnosticToken(self.next_token);
        self.bytes += size;
        self.entries.push_back((token, capsule));
        Some(token)
    }

    fn take(&mut self, token: DiagnosticToken) -> Option<DiagnosticCapsule> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| *candidate == token)?;
        let (_, capsule) = self.entries.remove(index)?;
        self.bytes -= capsule.size();
        Some(capsule)
    }
}

thread_local! {
    static DIAGNOSTICS: RefCell<DiagnosticRegistry> = RefCell::new(DiagnosticRegistry::default());
    #[cfg(test)]
    static METADATA_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn capture_capsule(
    allocator: &Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
    error: &EvalErr,
) -> Option<DiagnosticToken> {
    let original_error = error.to_string();
    let fixed_size = original_error.len() + "ChiaDialect::default".len();
    let available = MAX_CAPSULE_BYTES.checked_sub(fixed_size)?;
    let program = node_to_bytes_limit(allocator, program, available).ok()?;
    let available = available.checked_sub(program.len())?;
    let environment = node_to_bytes_limit(allocator, environment, available).ok()?;
    let capsule = DiagnosticCapsule {
        program,
        environment,
        max_cost,
        dialect: "ChiaDialect::default",
        original_error,
    };
    DIAGNOSTICS.with(|registry| registry.borrow_mut().insert(capsule))
}

/// Execute application-owned CLVM. The successful path is exactly one ordinary
/// `run_program` call; diagnostic state is created only after an `EvalErr`.
pub fn run_clvm(
    allocator: &mut Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> Result<Reduction, Error> {
    match run_program(allocator, &chia_dialect(), program, environment, max_cost) {
        Ok(reduction) => Ok(reduction),
        Err(error) => {
            let diagnostic = capture_capsule(allocator, program, environment, max_cost, &error);
            Err(Error::ClvmErr {
                error,
                diagnostic,
                context: None,
            })
        }
    }
}

#[derive(Clone, Debug)]
struct ActiveFrame {
    id: usize,
    program: Vec<u8>,
    arguments: Vec<Vec<u8>>,
}

fn serialized_arguments(
    allocator: &Allocator,
    mut environment: NodePtr,
) -> Result<Vec<Vec<u8>>, EvalErr> {
    let mut arguments = Vec::new();
    loop {
        match allocator.sexp(environment) {
            SExp::Pair(first, rest) => {
                arguments.push(node_to_bytes_limit(allocator, first, MAX_CAPSULE_BYTES)?);
                environment = rest;
            }
            SExp::Atom if allocator.atom(environment).is_empty() => return Ok(arguments),
            SExp::Atom => {
                arguments.push(node_to_bytes_limit(
                    allocator,
                    environment,
                    MAX_CAPSULE_BYTES,
                )?);
                return Ok(arguments);
            }
        }
    }
}

fn diagnostic_failure(capsule: &DiagnosticCapsule, reason: impl fmt::Display) -> String {
    format!(
        "CLVM diagnostic failed: {reason}\noriginal EvalErr: {}",
        capsule.original_error
    )
}

/// Consume a one-shot diagnostic capsule and replay it against loaded debug
/// metadata. Invalid, mismatched, or divergent diagnostics never replace the
/// original execution error.
pub fn diagnose_clvm(token: DiagnosticToken, sidecar: &[u8]) -> String {
    let Some(capsule) = DIAGNOSTICS.with(|registry| registry.borrow_mut().take(token)) else {
        return format!("CLVM diagnostic failed: unknown or retired token {token}");
    };
    diagnose_capsule(capsule, sidecar)
}

fn diagnose_capsule(capsule: DiagnosticCapsule, sidecar: &[u8]) -> String {
    #[cfg(test)]
    METADATA_LOADS.with(|loads| loads.set(loads.get() + 1));
    let metadata = match DebugMetadata::decode(sidecar) {
        Ok(metadata) => metadata,
        Err(error) => return diagnostic_failure(&capsule, error),
    };
    let top = match metadata.symbolize_frame(&capsule.program, &[]) {
        Ok(frame) => frame,
        Err(error) => return diagnostic_failure(&capsule, error),
    };
    match top.matched {
        FrameMatch::Exact => {
            if let Err(error) = metadata.verify_program(&capsule.program) {
                return diagnostic_failure(&capsule, error);
            }
        }
        FrameMatch::Curried => {}
        FrameMatch::Unknown => {
            return diagnostic_failure(&capsule, "debug metadata program identity mismatch");
        }
    }

    let mut allocator = Allocator::new();
    let program = match node_from_bytes(&mut allocator, &capsule.program) {
        Ok(program) => program,
        Err(error) => return diagnostic_failure(&capsule, format!("{error:?}")),
    };
    let environment = match node_from_bytes(&mut allocator, &capsule.environment) {
        Ok(environment) => environment,
        Err(error) => return diagnostic_failure(&capsule, format!("{error:?}")),
    };
    let active = Rc::new(RefCell::new(Vec::<ActiveFrame>::new()));
    let next_id = Rc::new(RefCell::new(0usize));
    let pre_active = active.clone();
    let pre_next_id = next_id.clone();
    let pre_eval = Box::new(move |allocator: &mut Allocator, program, environment| {
        let id = {
            let mut next = pre_next_id.borrow_mut();
            let id = *next;
            *next += 1;
            id
        };
        pre_active.borrow_mut().push(ActiveFrame {
            id,
            program: node_to_bytes_limit(allocator, program, MAX_CAPSULE_BYTES)?,
            arguments: serialized_arguments(allocator, environment)?,
        });
        let post_active = pre_active.clone();
        Ok(Some(Box::new(
            move |_allocator: &mut Allocator, _outcome: Option<NodePtr>| {
                let mut frames = post_active.borrow_mut();
                if let Some(index) = frames.iter().position(|frame| frame.id == id) {
                    frames.remove(index);
                }
            },
        ) as Box<clvmr::run_program::PostEval>))
    });
    let replay = run_program_with_pre_eval(
        &mut allocator,
        &chia_dialect(),
        program,
        environment,
        capsule.max_cost,
        Some(pre_eval),
    );
    let replay_error = match replay {
        Ok(_) => return diagnostic_failure(&capsule, "replay unexpectedly succeeded"),
        Err(error) => error,
    };
    if replay_error.to_string() != capsule.original_error {
        return diagnostic_failure(
            &capsule,
            format!(
                "replay diverged with {replay_error}; expected {}",
                capsule.original_error
            ),
        );
    }

    let frames = active.borrow();
    let mut rendered = Vec::with_capacity(frames.len());
    for frame in frames.iter() {
        let symbolized = match metadata.symbolize_frame(&frame.program, &frame.arguments) {
            Ok(symbolized) => symbolized,
            Err(error) => return diagnostic_failure(&capsule, error),
        };
        match format_stack_frame(&metadata, &symbolized, StackFrameStyle::Python) {
            Ok(frame) => rendered.push(frame),
            Err(error) => return diagnostic_failure(&capsule, error),
        }
    }
    let stack = if rendered.is_empty() {
        "  <no active frames>".to_string()
    } else {
        rendered
            .into_iter()
            .map(|frame| {
                frame
                    .lines()
                    .map(|line| format!("  {line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "CLVM stack trace (most recent call last):\n{stack}\noriginal EvalErr: {}",
        capsule.original_error
    )
}

#[cfg(test)]
pub(crate) fn diagnostic_registry_len() -> usize {
    DIAGNOSTICS.with(|registry| registry.borrow().entries.len())
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use chialisp::compiler::compiler::DefaultCompilerOpts;
    use chialisp::compiler::comptypes::CompilerOpts;
    use chialisp::compiler::debug_metadata::compile_with_debug;
    use clvmr::serde::node_to_bytes;

    use super::*;

    fn reset() {
        DIAGNOSTICS.with(|registry| *registry.borrow_mut() = DiagnosticRegistry::default());
        METADATA_LOADS.with(|loads| loads.set(0));
    }

    fn compiled(source: &str) -> chialisp::compiler::debug_metadata::DebugCompileArtifact {
        let opts: Rc<dyn CompilerOpts> = Rc::new(DefaultCompilerOpts::new("diagnostic.clsp"));
        compile_with_debug(opts, source)
            .expect("compile diagnostic fixture")
            .remove(0)
    }

    fn decode(allocator: &mut Allocator, bytes: &[u8]) -> NodePtr {
        node_from_bytes(allocator, bytes).expect("decode fixture")
    }

    fn token(error: &Error) -> DiagnosticToken {
        error
            .diagnostic_token()
            .expect("EvalErr should capture a diagnostic token")
    }

    #[test]
    fn successful_execution_has_no_diagnostic_work() {
        reset();
        let mut allocator = Allocator::new();
        let program = allocator.one();
        let result = run_clvm(&mut allocator, program, NodePtr::NIL, 100).unwrap();
        assert_eq!(result.1, NodePtr::NIL);
        assert_eq!(diagnostic_registry_len(), 0);
        METADATA_LOADS.with(|loads| assert_eq!(loads.get(), 0));
    }

    #[test]
    fn nested_path_into_atom_is_lazy_one_shot_and_symbolized() {
        reset();
        let artifact =
            compiled("(mod (X) (include *standard-cl-23*) (defun fail (Y) (f Y)) (fail X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(serialized.contains(&token.to_string()), "{serialized}");
        assert_eq!(diagnostic_registry_len(), 1);
        METADATA_LOADS.with(|loads| assert_eq!(loads.get(), 0));

        let diagnostic = diagnose_clvm(token, &artifact.metadata);
        assert!(diagnostic.contains("CLVM stack trace (most recent call last):"));
        assert!(diagnostic.contains("<main>()"), "{diagnostic}");
        assert!(diagnostic.contains("<unknown:"), "{diagnostic}");
        assert!(diagnostic.contains("diagnostic.clsp:"), "{diagnostic}");
        assert!(diagnostic.contains("original EvalErr: path into atom"));
        assert_eq!(diagnostic_registry_len(), 0);
        assert!(diagnose_clvm(token, &artifact.metadata).contains("retired token"));
    }

    #[test]
    fn registry_is_bounded_and_retires_oldest_tokens() {
        reset();
        let mut first = None;
        for _ in 0..(MAX_CAPSULES + 3) {
            let mut allocator = Allocator::new();
            let program = allocator.new_atom(&[2]).unwrap();
            let error = run_clvm(&mut allocator, program, NodePtr::NIL, 100).unwrap_err();
            first.get_or_insert_with(|| token(&error));
        }
        assert_eq!(diagnostic_registry_len(), MAX_CAPSULES);
        assert!(diagnose_clvm(first.unwrap(), b"bad").contains("retired token"));
    }

    #[test]
    fn mismatched_sidecar_preserves_original_error() {
        reset();
        let failing = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let other = compiled("(mod (X) (include *standard-cl-23*) (+ X 1))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &failing.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let diagnostic = diagnose_clvm(token(&error), &other.metadata);
        assert!(diagnostic.contains("CLVM diagnostic failed:"));
        assert!(diagnostic.contains("original EvalErr: path into atom"));
    }

    #[test]
    fn replay_divergence_preserves_original_error() {
        reset();
        let artifact = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);

        let pair = allocator.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
        let environment = allocator.new_pair(pair, NodePtr::NIL).unwrap();
        let bytes = node_to_bytes(&allocator, environment).unwrap();
        DIAGNOSTICS.with(|registry| {
            let mut registry = registry.borrow_mut();
            let index = registry
                .entries
                .iter()
                .position(|(candidate, _)| *candidate == token)
                .unwrap();
            let old_size = registry.entries[index].1.size();
            registry.entries[index].1.environment = bytes;
            let new_size = registry.entries[index].1.size();
            registry.bytes = registry.bytes - old_size + new_size;
        });

        let diagnostic = diagnose_clvm(token, &artifact.metadata);
        assert!(
            diagnostic.contains("replay unexpectedly succeeded"),
            "{diagnostic}"
        );
        assert!(diagnostic.contains("original EvalErr: path into atom"));
    }

    #[test]
    fn canonical_curry_reports_bound_named_typed_argument() {
        reset();
        let artifact = compiled("(mod (X Y) (include *standard-cl-23*) (f Y))");
        let mut allocator = Allocator::new();
        let base = decode(&mut allocator, &artifact.program);
        let quote = allocator.one();
        let apply = allocator.new_atom(&[2]).unwrap();
        let cons = allocator.new_atom(&[4]).unwrap();
        let bound = allocator.new_atom(&[7]).unwrap();
        let quoted_bound = allocator.new_pair(quote, bound).unwrap();
        let path_one = allocator.one();
        let curry_tail = allocator.new_pair(path_one, NodePtr::NIL).unwrap();
        let curry_middle = allocator.new_pair(quoted_bound, curry_tail).unwrap();
        let curry_environment = allocator.new_pair(cons, curry_middle).unwrap();
        let quoted_base = allocator.new_pair(quote, base).unwrap();
        let apply_tail = allocator.new_pair(curry_environment, NodePtr::NIL).unwrap();
        let apply_middle = allocator.new_pair(quoted_base, apply_tail).unwrap();
        let curried = allocator.new_pair(apply, apply_middle).unwrap();

        let error = run_clvm(&mut allocator, curried, NodePtr::NIL, 1_000_000).unwrap_err();
        let diagnostic = diagnose_clvm(token(&error), &artifact.metadata);
        assert!(diagnostic.contains("X: unknown = 7"), "{diagnostic}");
        assert!(diagnostic.contains("# bound: X"), "{diagnostic}");
        assert!(diagnostic.contains("original EvalErr: path into atom"));
    }
}
