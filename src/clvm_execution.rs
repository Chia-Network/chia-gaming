//! Lazy diagnostics for CLVM execution.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt;
use std::rc::Rc;

use chialisp::compiler::debug_metadata::{
    format_stack_frame, ArgumentBinding, DebugMetadata, FrameMatch, StackFrameStyle,
    SymbolizedFrame,
};
use chialisp::runtime_print::run_program_with_runtime_prints;
use clvmr::allocator::{Allocator, NodePtr, SExp};
use clvmr::chia_dialect::{ChiaDialect, ClvmFlags};
use clvmr::error::EvalErr;
use clvmr::reduction::Reduction;
use clvmr::serde::{node_from_bytes, node_to_bytes_limit};
use clvmr::{run_program, run_program_with_pre_eval};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::common::types::{AllocEncoder, Error};

const MAX_CAPSULES: usize = 16;
const MAX_CAPSULE_BYTES: usize = 512 * 1024;
const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_DEBUG_METADATA_FILES: usize = 64;
pub const MAX_DEBUG_METADATA_BYTES: usize = 8 * 1024 * 1024;

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

impl DiagnosticToken {
    pub fn parse(value: &str) -> Result<Self, String> {
        let hex = value
            .strip_prefix("clvm-")
            .ok_or_else(|| "diagnostic token must start with clvm-".to_string())?;
        if hex.len() != 16 {
            return Err("diagnostic token must contain 16 hexadecimal digits".to_string());
        }
        u64::from_str_radix(hex, 16)
            .map(Self)
            .map_err(|_| "diagnostic token contains invalid hexadecimal digits".to_string())
    }
}

#[derive(Default)]
pub struct DebugMetadataCollection {
    bytes: usize,
    entries: Vec<DebugMetadata>,
}

impl DebugMetadataCollection {
    pub fn insert(&mut self, sidecar: &[u8]) -> Result<(), String> {
        if self.entries.len() >= MAX_DEBUG_METADATA_FILES {
            return Err(format!(
                "debug metadata file limit exceeded ({MAX_DEBUG_METADATA_FILES})"
            ));
        }
        let bytes = self
            .bytes
            .checked_add(sidecar.len())
            .ok_or_else(|| "debug metadata byte count overflow".to_string())?;
        if bytes > MAX_DEBUG_METADATA_BYTES {
            return Err(format!(
                "debug metadata byte limit exceeded ({MAX_DEBUG_METADATA_BYTES})"
            ));
        }
        let metadata = DebugMetadata::decode(sidecar)?;
        if self
            .entries
            .iter()
            .any(|entry| entry.program_sha256 == metadata.program_sha256)
        {
            return Err(format!(
                "duplicate debug metadata program identity {}",
                hex::encode(metadata.program_sha256)
            ));
        }
        self.bytes = bytes;
        self.entries.push(metadata);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[derive(Debug)]
struct DiagnosticCapsule {
    program: Vec<u8>,
    environment: Vec<u8>,
    max_cost: u64,
    dialect_flags: u32,
    original_error: String,
}

impl DiagnosticCapsule {
    fn size(&self) -> usize {
        self.program.len()
            + self.environment.len()
            + self.original_error.len()
            + std::mem::size_of_val(&self.dialect_flags)
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
    #[cfg(test)]
    static CAPSULE_SERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn capture_capsule(
    allocator: &Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
    dialect_flags: ClvmFlags,
    error: &EvalErr,
) -> Option<DiagnosticToken> {
    #[cfg(test)]
    CAPSULE_SERIALIZATIONS.with(|serializations| {
        serializations.set(serializations.get() + 1);
    });
    let original_error = error.to_string();
    let fixed_size = original_error.len() + std::mem::size_of::<u32>();
    let available = MAX_CAPSULE_BYTES.checked_sub(fixed_size)?;
    let program = node_to_bytes_limit(allocator, program, available).ok()?;
    let available = available.checked_sub(program.len())?;
    let environment = node_to_bytes_limit(allocator, environment, available).ok()?;
    let capsule = DiagnosticCapsule {
        program,
        environment,
        max_cost,
        dialect_flags: dialect_flags.bits(),
        original_error,
    };
    DIAGNOSTICS.with(|registry| registry.borrow_mut().insert(capsule))
}

pub(crate) fn clvm_error_with_diagnostic(
    allocator: &Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
    dialect_flags: ClvmFlags,
    error: EvalErr,
    context: Option<String>,
) -> Error {
    let diagnostic = capture_capsule(
        allocator,
        program,
        environment,
        max_cost,
        dialect_flags,
        &error,
    );
    Error::ClvmErr {
        error,
        diagnostic,
        context,
    }
}

/// Execute application-owned CLVM. Successful execution is exactly one ordinary
/// `run_program` call. Serialization and diagnostic registry work happen only
/// after an `EvalErr`.
pub fn run_clvm(
    allocator: &mut Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> Result<Reduction, Error> {
    let dialect_flags = ClvmFlags::empty();
    match run_program(
        allocator,
        &ChiaDialect::new(dialect_flags),
        program,
        environment,
        max_cost,
    ) {
        Ok(reduction) => Ok(reduction),
        Err(error) => Err(clvm_error_with_diagnostic(
            allocator,
            program,
            environment,
            max_cost,
            dialect_flags,
            error,
            None,
        )),
    }
}

/// Execute application-owned CLVM while recognizing the established Chialisp
/// and Rue runtime print encodings. Print records are retained by the
/// session-local allocator even when execution fails. Diagnostic replay uses
/// [`run_clvm`] directly and therefore cannot emit duplicate print records.
pub fn run_clvm_with_runtime_prints(
    encoder: &mut AllocEncoder,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> Result<Reduction, Error> {
    let dialect_flags = ClvmFlags::empty();
    let run = run_program_with_runtime_prints(
        encoder.allocator(),
        dialect_flags,
        program,
        environment,
        max_cost,
    );
    encoder.push_runtime_prints(run.prints);
    match run.result {
        Ok(reduction) => Ok(reduction),
        Err(error) => Err(clvm_error_with_diagnostic(
            encoder.allocator_ref(),
            program,
            environment,
            max_cost,
            dialect_flags,
            error,
            None,
        )),
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

/// Consume a one-shot diagnostic capsule and replay it against a complete,
/// validated metadata collection. A token is not consumed until metadata is
/// available. Invalid, mismatched, or divergent diagnostics never replace the
/// original execution error.
pub fn diagnose_clvm(token: DiagnosticToken, metadata: &DebugMetadataCollection) -> String {
    if metadata.is_empty() {
        return "CLVM diagnostic failed: no debug metadata loaded".to_string();
    }
    let Some(capsule) = DIAGNOSTICS.with(|registry| registry.borrow_mut().take(token)) else {
        return format!("CLVM diagnostic failed: unknown or retired token {token}");
    };
    diagnose_capsule(capsule, metadata)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn diagnose_clvm_from_sidecar_files(
    token: DiagnosticToken,
    sidecars: &[impl AsRef<std::path::Path>],
) -> String {
    let mut metadata = DebugMetadataCollection::default();
    for path in sidecars {
        let path = path.as_ref();
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                return format!(
                    "CLVM diagnostic failed: cannot read debug metadata {}: {error}",
                    path.display()
                )
            }
        };
        if let Err(error) = metadata.insert(&bytes) {
            return format!(
                "CLVM diagnostic failed: invalid debug metadata {}: {error}",
                path.display()
            );
        }
    }
    diagnose_clvm(token, &metadata)
}

fn symbolize<'a>(
    metadata: &'a DebugMetadataCollection,
    program: &[u8],
    arguments: &[Vec<u8>],
) -> Result<(&'a DebugMetadata, SymbolizedFrame), String> {
    let program_sha256: [u8; 32] = Sha256::digest(program).into();
    for entry in &metadata.entries {
        if entry.program_sha256 == program_sha256 {
            let frame = entry.symbolize_frame(program, arguments)?;
            if frame.matched == FrameMatch::Unknown {
                return Err("debug metadata program structure mismatch".to_string());
            }
            return Ok((entry, frame));
        }
    }
    if let Some((base, bound_arguments)) = peel_curry(program)? {
        let base_sha256: [u8; 32] = Sha256::digest(&base).into();
        for entry in &metadata.entries {
            if entry.program_sha256 != base_sha256 {
                continue;
            }
            entry.verify_program(&base)?;
            let mut all_arguments = bound_arguments.clone();
            all_arguments.extend_from_slice(arguments);
            let mut frame = entry.symbolize_frame(&base, &all_arguments)?;
            frame.matched = FrameMatch::Curried;
            frame.bound_arguments = bound_arguments.clone();
            frame.runtime_arguments = arguments.to_vec();
            for argument in frame.arguments.iter_mut().take(bound_arguments.len()) {
                argument.binding = ArgumentBinding::Bound;
            }
            return Ok((entry, frame));
        }
    }
    let entry = metadata
        .entries
        .first()
        .ok_or_else(|| "no debug metadata loaded".to_string())?;
    Ok((entry, entry.symbolize_frame(program, arguments)?))
}

type CurriedProgram = (Vec<u8>, Vec<Vec<u8>>);

fn peel_curry(program: &[u8]) -> Result<Option<CurriedProgram>, String> {
    fn atom_eq(allocator: &Allocator, node: NodePtr, expected: &[u8]) -> bool {
        matches!(allocator.sexp(node), SExp::Atom) && allocator.atom(node).as_ref() == expected
    }

    let mut allocator = Allocator::new();
    let mut node = node_from_bytes(&mut allocator, program)
        .map_err(|error| format!("invalid frame program: {error:?}"))?;
    let mut bound = Vec::new();
    let mut peeled = false;
    while let SExp::Pair(apply, tail) = allocator.sexp(node) {
        if !atom_eq(&allocator, apply, &[2]) {
            break;
        }
        let SExp::Pair(quoted_program, tail) = allocator.sexp(tail) else {
            break;
        };
        let SExp::Pair(quote, base) = allocator.sexp(quoted_program) else {
            break;
        };
        if !atom_eq(&allocator, quote, &[1]) {
            break;
        }
        let SExp::Pair(mut environment, end) = allocator.sexp(tail) else {
            break;
        };
        if !atom_eq(&allocator, end, &[]) {
            break;
        }
        let mut layer = Vec::new();
        loop {
            if atom_eq(&allocator, environment, &[1]) {
                break;
            }
            let SExp::Pair(cons, tail) = allocator.sexp(environment) else {
                return Ok(None);
            };
            if !atom_eq(&allocator, cons, &[4]) {
                return Ok(None);
            }
            let SExp::Pair(quoted_argument, tail) = allocator.sexp(tail) else {
                return Ok(None);
            };
            let SExp::Pair(argument_quote, argument) = allocator.sexp(quoted_argument) else {
                return Ok(None);
            };
            if !atom_eq(&allocator, argument_quote, &[1]) {
                return Ok(None);
            }
            layer.push(
                node_to_bytes_limit(&allocator, argument, MAX_CAPSULE_BYTES)
                    .map_err(|error| error.to_string())?,
            );
            let SExp::Pair(next, end) = allocator.sexp(tail) else {
                return Ok(None);
            };
            if !atom_eq(&allocator, end, &[]) {
                return Ok(None);
            }
            environment = next;
        }
        bound.extend(layer);
        node = base;
        peeled = true;
    }
    if !peeled {
        return Ok(None);
    }
    let base = node_to_bytes_limit(&allocator, node, MAX_CAPSULE_BYTES)
        .map_err(|error| error.to_string())?;
    Ok(Some((base, bound)))
}

fn diagnose_capsule(capsule: DiagnosticCapsule, metadata: &DebugMetadataCollection) -> String {
    #[cfg(test)]
    METADATA_LOADS.with(|loads| loads.set(loads.get() + 1));
    let (_, top) = match symbolize(metadata, &capsule.program, &[]) {
        Ok(frame) => frame,
        Err(error) => return diagnostic_failure(&capsule, error),
    };
    match top.matched {
        FrameMatch::Exact | FrameMatch::Curried => {}
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
        &ChiaDialect::new(ClvmFlags::from_bits_retain(capsule.dialect_flags)),
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
        let (frame_metadata, symbolized) =
            match symbolize(metadata, &frame.program, &frame.arguments) {
                Ok(symbolized) => symbolized,
                Err(error) => return diagnostic_failure(&capsule, error),
            };
        match format_stack_frame(frame_metadata, &symbolized, StackFrameStyle::Python) {
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
pub(crate) fn reset_diagnostics_for_test() {
    DIAGNOSTICS.with(|registry| *registry.borrow_mut() = DiagnosticRegistry::default());
    METADATA_LOADS.with(|loads| loads.set(0));
    CAPSULE_SERIALIZATIONS.with(|serializations| serializations.set(0));
}

#[cfg(test)]
pub(crate) fn capsule_serializations_for_test() -> usize {
    CAPSULE_SERIALIZATIONS.with(std::cell::Cell::get)
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use chialisp::classic::clvm_tools::binutils::assemble;
    use chialisp::compiler::compiler::DefaultCompilerOpts;
    use chialisp::compiler::comptypes::CompilerOpts;
    use chialisp::compiler::debug_metadata::compile_with_debug;
    use clvmr::serde::node_to_bytes;

    use super::*;

    fn reset() {
        reset_diagnostics_for_test();
    }

    fn compiled(source: &str) -> chialisp::compiler::debug_metadata::DebugCompileArtifact {
        compiled_named("diagnostic.clsp", source)
    }

    fn compiled_named(
        filename: &str,
        source: &str,
    ) -> chialisp::compiler::debug_metadata::DebugCompileArtifact {
        let opts: Rc<dyn CompilerOpts> = Rc::new(DefaultCompilerOpts::new(filename));
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

    fn metadata(sidecars: &[&[u8]]) -> DebugMetadataCollection {
        let mut collection = DebugMetadataCollection::default();
        for sidecar in sidecars {
            collection.insert(sidecar).expect("valid debug metadata");
        }
        collection
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
        CAPSULE_SERIALIZATIONS.with(|serializations| assert_eq!(serializations.get(), 0));
    }

    #[test]
    fn runtime_prints_are_ordered_and_session_local() {
        reset();
        let mut encoder = AllocEncoder::new();
        let program = assemble(
            encoder.allocator(),
            r#"(c
                (all (q . "$print$") (q . "chialisp") (q . 1))
                ("debug_print" (q . "game.rue:2:3") (q . ("rue" 2)))
            )"#,
        )
        .expect("assemble mixed print program");
        run_clvm_with_runtime_prints(&mut encoder, program, NodePtr::NIL, 1_000_000)
            .expect("mixed print program");
        assert_eq!(
            encoder.drain_runtime_prints(),
            vec![
                "[clvm-print] game.rue:2:3: (\"rue\" 2)",
                "[clvm-print] (\"chialisp\" 1)",
            ]
        );
        assert!(encoder.drain_runtime_prints().is_empty());

        let mut other_session = AllocEncoder::new();
        assert!(other_session.drain_runtime_prints().is_empty());
    }

    #[test]
    fn failed_execution_retains_print_without_diagnostic_replay_duplicate() {
        reset();
        let mut encoder = AllocEncoder::new();
        let program = assemble(
            encoder.allocator(),
            r#"(c
                ("not_an_operator")
                ("debug_print" (q . "game.rue:4:5") (q . "before error"))
            )"#,
        )
        .expect("assemble failing print program");
        let error = run_clvm_with_runtime_prints(&mut encoder, program, NodePtr::NIL, 1_000_000)
            .expect_err("program should fail after printing");
        let _ = diagnose_clvm(token(&error), &DebugMetadataCollection::default());
        assert_eq!(
            encoder.drain_runtime_prints(),
            vec!["[clvm-print] game.rue:4:5: \"before error\""]
        );
        assert!(encoder.drain_runtime_prints().is_empty());
    }

    #[test]
    fn capsule_retains_exact_dialect_flag_bits() {
        reset();
        let mut allocator = Allocator::new();
        let program = allocator.new_atom(&[0xff]).unwrap();
        let flags = ClvmFlags::NO_UNKNOWN_OPS | ClvmFlags::LIMIT_HEAP;
        let error = run_program(
            &mut allocator,
            &ChiaDialect::new(flags),
            program,
            NodePtr::NIL,
            100,
        )
        .expect_err("unknown operator");
        let captured =
            clvm_error_with_diagnostic(&allocator, program, NodePtr::NIL, 100, flags, error, None);
        let token = token(&captured);
        DIAGNOSTICS.with(|registry| {
            let registry = registry.borrow();
            let capsule = &registry
                .entries
                .iter()
                .find(|(candidate, _)| *candidate == token)
                .expect("captured capsule")
                .1;
            assert_eq!(capsule.dialect_flags, flags.bits());
        });
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

        let metadata = metadata(&[&artifact.metadata]);
        let diagnostic = diagnose_clvm(token, &metadata);
        assert!(diagnostic.contains("CLVM stack trace (most recent call last):"));
        assert!(diagnostic.contains("<main>()"), "{diagnostic}");
        assert!(diagnostic.contains("<unknown:"), "{diagnostic}");
        assert!(diagnostic.contains("diagnostic.clsp:"), "{diagnostic}");
        assert!(diagnostic.contains("original EvalErr: path into atom"));
        assert_eq!(diagnostic_registry_len(), 0);
        assert!(diagnose_clvm(token, &metadata).contains("retired token"));
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
        let artifact = compiled("(mod () (include *standard-cl-23*) ())");
        assert!(
            diagnose_clvm(first.unwrap(), &metadata(&[&artifact.metadata]))
                .contains("retired token")
        );
    }

    #[test]
    fn mismatched_sidecar_preserves_original_error() {
        reset();
        let failing = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let other = compiled("(mod (X) (include *standard-cl-23*) (+ X 1))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &failing.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let diagnostic = diagnose_clvm(token(&error), &metadata(&[&other.metadata]));
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

        let diagnostic = diagnose_clvm(token, &metadata(&[&artifact.metadata]));
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
        let curried_bytes = node_to_bytes(&allocator, curried).unwrap();

        let error = run_clvm(&mut allocator, curried, NodePtr::NIL, 1_000_000).unwrap_err();
        let mut prepared_metadata = DebugMetadata::decode(&artifact.metadata).unwrap();
        prepared_metadata.program_sha256 = Sha256::digest(&curried_bytes).into();
        let prepared_sidecar = prepared_metadata.encode().unwrap();
        let diagnostic = diagnose_clvm(token(&error), &metadata(&[&prepared_sidecar]));
        assert!(diagnostic.contains("X: unknown = 7"), "{diagnostic}");
        assert!(diagnostic.contains("# bound: X"), "{diagnostic}");
        assert!(diagnostic.contains("original EvalErr: path into atom"));
    }

    #[test]
    fn non_first_sidecar_owns_the_failure_program() {
        reset();
        let other = compiled("(mod (X) (include *standard-cl-23*) (+ X 1))");
        let failing = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &failing.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();

        let diagnostic = diagnose_clvm(
            token(&error),
            &metadata(&[&other.metadata, &failing.metadata]),
        );
        assert!(diagnostic.contains("CLVM stack trace"), "{diagnostic}");
        assert!(diagnostic.contains("diagnostic.clsp:"), "{diagnostic}");
    }

    #[test]
    fn missing_metadata_does_not_consume_token() {
        reset();
        let artifact = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);

        assert!(diagnose_clvm(token, &DebugMetadataCollection::default())
            .contains("no debug metadata loaded"));
        assert_eq!(diagnostic_registry_len(), 1);
        assert!(diagnose_clvm(token, &metadata(&[&artifact.metadata])).contains("CLVM stack trace"));
        assert_eq!(diagnostic_registry_len(), 0);
    }

    #[test]
    fn metadata_collection_rejects_duplicate_identity_and_malformed_bytes() {
        let artifact = compiled("(mod () (include *standard-cl-23*) ())");
        let mut collection = DebugMetadataCollection::default();
        collection.insert(&artifact.metadata).unwrap();
        assert!(collection
            .insert(&artifact.metadata)
            .unwrap_err()
            .contains("duplicate"));
        assert!(DebugMetadataCollection::default().insert(b"bad").is_err());
    }

    #[test]
    fn active_frames_resolve_across_multiple_sidecars() {
        reset();
        let outer = compiled_named(
            "outer.clsp",
            "(mod (PROGRAM ARGS) (include *standard-cl-23*) (a PROGRAM ARGS))",
        );
        let inner = compiled_named(
            "inner.clsp",
            "(mod (X) (include *standard-cl-23*) (defun fail (Y) (f Y)) (fail X))",
        );
        let mut allocator = Allocator::new();
        let outer_program = decode(&mut allocator, &outer.program);
        let inner_program = decode(&mut allocator, &inner.program);
        let inner_args = allocator.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
        let env_tail = allocator.new_pair(inner_args, NodePtr::NIL).unwrap();
        let environment = allocator.new_pair(inner_program, env_tail).unwrap();
        let error = run_clvm(&mut allocator, outer_program, environment, 1_000_000).unwrap_err();

        let diagnostic = diagnose_clvm(
            token(&error),
            &metadata(&[&outer.metadata, &inner.metadata]),
        );
        assert!(diagnostic.contains("outer.clsp:"), "{diagnostic}");
        assert!(diagnostic.contains("inner.clsp:"), "{diagnostic}");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_sidecar_helper_loads_only_when_explicitly_diagnosing() {
        reset();
        let artifact = compiled("(mod (X) (include *standard-cl-23*) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);
        let path = std::env::temp_dir().join(format!("{token}.debug.clvm.bin"));

        assert!(diagnose_clvm_from_sidecar_files(token, &[path.as_path()])
            .contains("cannot read debug metadata"));
        assert_eq!(diagnostic_registry_len(), 1);
        std::fs::write(&path, &artifact.metadata).unwrap();
        let diagnostic = diagnose_clvm_from_sidecar_files(token, &[path.as_path()]);
        std::fs::remove_file(path).unwrap();
        assert!(diagnostic.contains("CLVM stack trace"), "{diagnostic}");
    }
}
