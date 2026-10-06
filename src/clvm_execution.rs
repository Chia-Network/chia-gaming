//! Lazy diagnostics for CLVM execution.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt;

use chialisp::compiler::debug_metadata::{
    DebugMetadataCollection as ChialispDebugMetadataCollection, SerializedFrame, StackFrameStyle,
};
use chialisp::runtime_print::RuntimePrintDialect;
use clvmr::allocator::{Allocator, NodePtr};
use clvmr::chia_dialect::{ChiaDialect, ClvmFlags};
use clvmr::reduction::Reduction;
use clvmr::run_program::EvalFailure;
use clvmr::serde::node_to_bytes_limit;
use clvmr::{run_program, run_program_with_diagnostics};
use serde::{Deserialize, Serialize};

use crate::common::types::{AllocEncoder, Error};

const MAX_DIAGNOSTICS: usize = 16;
const MAX_DIAGNOSTIC_BYTES: usize = 512 * 1024;
const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_CAPTURED_FRAMES: usize = 64;
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
    inner: ChialispDebugMetadataCollection,
}

impl DebugMetadataCollection {
    pub fn insert(&mut self, sidecar: &[u8]) -> Result<(), String> {
        if self.inner.len() >= MAX_DEBUG_METADATA_FILES {
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
        self.inner.insert(sidecar)?;
        self.bytes = bytes;
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

#[derive(Debug)]
struct DiagnosticRecord {
    frames: Vec<SerializedFrame>,
    truncated: usize,
    original_error: String,
}

impl DiagnosticRecord {
    fn size(&self) -> usize {
        self.frames
            .iter()
            .map(|frame| frame.program.len() + frame.environment.len())
            .sum::<usize>()
            + self.original_error.len()
            + std::mem::size_of_val(&self.truncated)
    }
}

#[derive(Default)]
struct DiagnosticRegistry {
    next_token: u64,
    bytes: usize,
    entries: VecDeque<(DiagnosticToken, DiagnosticRecord)>,
}

impl DiagnosticRegistry {
    fn insert(&mut self, record: DiagnosticRecord) -> Option<DiagnosticToken> {
        let size = record.size();
        if size > MAX_DIAGNOSTIC_BYTES {
            return None;
        }
        while self.entries.len() >= MAX_DIAGNOSTICS || self.bytes + size > MAX_REGISTRY_BYTES {
            let (_, retired) = self.entries.pop_front()?;
            self.bytes -= retired.size();
        }
        self.next_token = self.next_token.wrapping_add(1).max(1);
        let token = DiagnosticToken(self.next_token);
        self.bytes += size;
        self.entries.push_back((token, record));
        Some(token)
    }

    fn take(&mut self, token: DiagnosticToken) -> Option<DiagnosticRecord> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| *candidate == token)?;
        let (_, record) = self.entries.remove(index)?;
        self.bytes -= record.size();
        Some(record)
    }
}

thread_local! {
    static DIAGNOSTICS: RefCell<DiagnosticRegistry> = RefCell::new(DiagnosticRegistry::default());
    #[cfg(test)]
    static METADATA_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    #[cfg(test)]
    static FRAME_SERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn capture_failure(allocator: &Allocator, failure: &EvalFailure) -> Option<DiagnosticToken> {
    #[cfg(test)]
    FRAME_SERIALIZATIONS.with(|serializations| {
        serializations.set(serializations.get() + 1);
    });
    let original_error = failure.error.to_string();
    let mut available =
        MAX_DIAGNOSTIC_BYTES.checked_sub(original_error.len() + std::mem::size_of::<usize>())?;
    let mut frames = Vec::with_capacity(failure.frames.len());
    let mut truncated = failure.truncated;
    for (index, frame) in failure.frames.iter().enumerate().rev() {
        let Ok(program) = node_to_bytes_limit(allocator, frame.program, available) else {
            truncated += index + 1;
            break;
        };
        available = available.checked_sub(program.len())?;
        let Ok(environment) = node_to_bytes_limit(allocator, frame.environment, available) else {
            truncated += index + 1;
            break;
        };
        available = available.checked_sub(environment.len())?;
        frames.push(SerializedFrame {
            program,
            environment,
        });
    }
    frames.reverse();
    let record = DiagnosticRecord {
        frames,
        truncated,
        original_error,
    };
    DIAGNOSTICS.with(|registry| registry.borrow_mut().insert(record))
}

pub(crate) fn clvm_error_from_failure(
    allocator: &Allocator,
    failure: EvalFailure,
    context: Option<String>,
) -> Error {
    let diagnostic = capture_failure(allocator, &failure);
    Error::ClvmErr {
        error: failure.error,
        diagnostic,
        context,
    }
}

/// Execute application-owned CLVM. Frame bookkeeping is selected at this call
/// boundary; frame serialization and registry work still happen only on error.
pub fn run_clvm(
    allocator: &mut Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> Result<Reduction, Error> {
    run_clvm_with_capture(allocator, program, environment, max_cost, true)
}

fn run_clvm_with_capture(
    allocator: &mut Allocator,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
    capture_failure_frames: bool,
) -> Result<Reduction, Error> {
    let dialect = ChiaDialect::new(ClvmFlags::empty());
    if capture_failure_frames {
        match run_program_with_diagnostics(
            allocator,
            &dialect,
            program,
            environment,
            max_cost,
            MAX_CAPTURED_FRAMES,
        ) {
            Ok(reduction) => Ok(reduction),
            Err(failure) => Err(clvm_error_from_failure(allocator, failure, None)),
        }
    } else {
        run_program(allocator, &dialect, program, environment, max_cost).map_err(|error| {
            Error::ClvmErr {
                error,
                diagnostic: None,
                context: None,
            }
        })
    }
}

/// Execute application-owned CLVM while recognizing the established Chialisp
/// and Rue runtime print encodings. Print records are retained by the
/// session-local allocator even when execution fails.
pub fn run_clvm_with_runtime_prints(
    encoder: &mut AllocEncoder,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> Result<Reduction, Error> {
    run_clvm_with_runtime_prints_and_capture(encoder, program, environment, max_cost, true)
}

fn run_clvm_with_runtime_prints_and_capture(
    encoder: &mut AllocEncoder,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
    capture_failure_frames: bool,
) -> Result<Reduction, Error> {
    let dialect = RuntimePrintDialect::new(ClvmFlags::empty());
    if capture_failure_frames {
        let result = run_program_with_diagnostics(
            encoder.allocator(),
            &dialect,
            program,
            environment,
            max_cost,
            MAX_CAPTURED_FRAMES,
        );
        encoder.push_runtime_prints(dialect.take_prints());
        match result {
            Ok(reduction) => Ok(reduction),
            Err(failure) => Err(clvm_error_from_failure(
                encoder.allocator_ref(),
                failure,
                None,
            )),
        }
    } else {
        let result = run_program(
            encoder.allocator(),
            &dialect,
            program,
            environment,
            max_cost,
        );
        encoder.push_runtime_prints(dialect.take_prints());
        result.map_err(|error| Error::ClvmErr {
            error,
            diagnostic: None,
            context: None,
        })
    }
}

/// Execute a CLVM probe whose failure is an expected negative result. Failed
/// probes retain their diagnostic token so the host can render a nonfatal
/// stack trace after lazily loading metadata.
pub(crate) fn run_clvm_probe_with_runtime_prints(
    encoder: &mut AllocEncoder,
    program: NodePtr,
    environment: NodePtr,
    max_cost: u64,
) -> bool {
    match run_clvm_with_runtime_prints(encoder, program, environment, max_cost) {
        Ok(_) => true,
        Err(error) => {
            if let Some(token) = error.diagnostic_token() {
                encoder.push_clvm_diagnostic(token);
            }
            false
        }
    }
}

fn diagnostic_failure(record: &DiagnosticRecord, reason: impl fmt::Display) -> String {
    format!(
        "CLVM error: {}\nCLVM diagnostic failed: {reason}",
        record.original_error
    )
}

/// Consume a one-shot captured failure and symbolize it against a complete,
/// validated metadata collection. This path never executes CLVM.
pub fn diagnose_clvm(token: DiagnosticToken, metadata: &DebugMetadataCollection) -> String {
    if metadata.is_empty() {
        return "CLVM diagnostic failed: no debug metadata loaded".to_string();
    }
    let Some(record) = DIAGNOSTICS.with(|registry| registry.borrow_mut().take(token)) else {
        return format!("CLVM diagnostic failed: unknown or retired token {token}");
    };
    diagnose_record(record, metadata)
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

fn diagnose_record(record: DiagnosticRecord, metadata: &DebugMetadataCollection) -> String {
    #[cfg(test)]
    METADATA_LOADS.with(|loads| loads.set(loads.get() + 1));
    let rendered = match metadata.inner.format_captured_stack(
        &record.frames,
        record.truncated,
        StackFrameStyle::Python,
    ) {
        Ok(rendered) => rendered,
        Err(error) => return diagnostic_failure(&record, error),
    };
    let stack = if rendered.is_empty() {
        "  <no active frames>".to_string()
    } else {
        rendered
            .lines()
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("CLVM error: {}\n{stack}", record.original_error)
}

#[cfg(test)]
pub(crate) fn diagnostic_registry_len() -> usize {
    DIAGNOSTICS.with(|registry| registry.borrow().entries.len())
}

#[cfg(test)]
pub(crate) fn reset_diagnostics_for_test() {
    DIAGNOSTICS.with(|registry| *registry.borrow_mut() = DiagnosticRegistry::default());
    METADATA_LOADS.with(|loads| loads.set(0));
    FRAME_SERIALIZATIONS.with(|serializations| serializations.set(0));
}

#[cfg(test)]
pub(crate) fn frame_serializations_for_test() -> usize {
    FRAME_SERIALIZATIONS.with(std::cell::Cell::get)
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use chialisp::classic::clvm_tools::binutils::assemble;
    use chialisp::compiler::compiler::DefaultCompilerOpts;
    use chialisp::compiler::comptypes::CompilerOpts;
    use chialisp::compiler::debug_metadata::compile_with_debug;
    use clvmr::run_program::EvalFrame;
    use clvmr::serde::{node_from_bytes, node_to_bytes};

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
        let opts: Rc<dyn CompilerOpts> = DefaultCompilerOpts::new(filename)
            .set_search_paths(&[concat!(env!("CARGO_MANIFEST_DIR"), "/clsp").to_string()]);
        compile_with_debug(opts, source)
            .expect("compile diagnostic fixture")
            .into_iter()
            .find(|artifact| artifact.export_name.as_deref() == Some("program"))
            .expect("CL26 program export")
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
        FRAME_SERIALIZATIONS.with(|serializations| assert_eq!(serializations.get(), 0));
    }

    #[test]
    fn disabled_capture_uses_ordinary_evaluator_without_diagnostic_work() {
        reset();
        let mut allocator = Allocator::new();
        let program = allocator.new_atom(&[2]).unwrap();
        let error =
            run_clvm_with_capture(&mut allocator, program, NodePtr::NIL, 100, false).unwrap_err();
        assert!(error.diagnostic_token().is_none());
        assert_eq!(diagnostic_registry_len(), 0);
        assert_eq!(frame_serializations_for_test(), 0);
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
    fn failed_execution_retains_each_runtime_print_once() {
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
    fn failed_probe_retains_nonfatal_diagnostic_token() {
        reset();
        let artifact =
            compiled("(include *standard-cl-26*) (defun fail (Y) (f Y)) (export (X) (fail X))");
        let mut encoder = AllocEncoder::new();
        let program = decode(encoder.allocator(), &artifact.program);

        assert!(!run_clvm_probe_with_runtime_prints(
            &mut encoder,
            program,
            NodePtr::NIL,
            1_000_000,
        ));
        let tokens = encoder.drain_clvm_diagnostics().collect::<Vec<_>>();
        assert_eq!(tokens.len(), 1);
        assert!(diagnose_clvm(tokens[0], &metadata(&[&artifact.metadata])).contains("CLVM error:"));
    }

    #[test]
    fn nested_path_into_atom_is_lazy_one_shot_and_symbolized() {
        reset();
        let artifact =
            compiled("(include *standard-cl-26*) (defun fail (Y) (f Y)) (export (X) (fail X))");
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
        assert!(diagnostic.contains("CLVM error:"));
        assert!(diagnostic.contains("in <main>"), "{diagnostic}");
        assert!(diagnostic.contains("<unknown:"), "{diagnostic}");
        assert!(
            diagnostic.contains("File \"diagnostic.clsp\", line "),
            "{diagnostic}"
        );
        assert!(diagnostic.starts_with("CLVM error: path into atom\n  "));
        assert_eq!(diagnostic_registry_len(), 0);
        assert!(diagnose_clvm(token, &metadata).contains("retired token"));
    }

    #[test]
    fn registry_is_bounded_and_retires_oldest_tokens() {
        reset();
        let mut first = None;
        for _ in 0..(MAX_DIAGNOSTICS + 3) {
            let mut allocator = Allocator::new();
            let program = allocator.new_atom(&[2]).unwrap();
            let error = run_clvm(&mut allocator, program, NodePtr::NIL, 100).unwrap_err();
            first.get_or_insert_with(|| token(&error));
        }
        assert_eq!(diagnostic_registry_len(), MAX_DIAGNOSTICS);
        let artifact = compiled("(include *standard-cl-26*) (export () ())");
        assert!(
            diagnose_clvm(first.unwrap(), &metadata(&[&artifact.metadata]))
                .contains("retired token")
        );
    }

    #[test]
    fn oversized_older_frame_retains_newest_serialized_suffix() {
        reset();
        let mut allocator = Allocator::new();
        let oversized = allocator
            .new_atom(&vec![0x42; MAX_DIAGNOSTIC_BYTES])
            .unwrap();
        let newest_program = allocator.one();
        let newest_environment = NodePtr::NIL;
        let invalid_program = allocator.new_atom(&[2]).unwrap();
        let error = run_program_with_diagnostics(
            &mut allocator,
            &ChiaDialect::default(),
            invalid_program,
            NodePtr::NIL,
            100,
            MAX_CAPTURED_FRAMES,
        )
        .unwrap_err()
        .error;
        let failure = EvalFailure {
            error,
            frames: vec![
                EvalFrame {
                    program: oversized,
                    environment: NodePtr::NIL,
                },
                EvalFrame {
                    program: newest_program,
                    environment: newest_environment,
                },
            ],
            truncated: 2,
        };

        let token = capture_failure(&allocator, &failure).expect("retain fitting suffix");
        DIAGNOSTICS.with(|registry| {
            let registry = registry.borrow();
            let record = &registry
                .entries
                .iter()
                .find(|(candidate, _)| *candidate == token)
                .unwrap()
                .1;
            assert_eq!(record.frames.len(), 1);
            assert_eq!(
                record.frames[0].program,
                node_to_bytes(&allocator, newest_program).unwrap()
            );
            assert_eq!(
                record.frames[0].environment,
                node_to_bytes(&allocator, newest_environment).unwrap()
            );
            assert_eq!(record.truncated, 3);
            assert!(record.size() <= MAX_DIAGNOSTIC_BYTES);
        });
    }

    #[test]
    fn unknown_frames_preserve_original_error() {
        reset();
        let failing = compiled("(include *standard-cl-26*) (export (X) (f X))");
        let other = compiled("(include *standard-cl-26*) (export (X) (+ X 1))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &failing.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let diagnostic = diagnose_clvm(token(&error), &metadata(&[&other.metadata]));
        assert!(diagnostic.contains("<unknown:"), "{diagnostic}");
        assert!(diagnostic.starts_with("CLVM error: path into atom\n  "));
    }

    #[test]
    fn diagnose_uses_captured_frames_without_reexecution() {
        reset();
        let artifact = compiled("(include *standard-cl-26*) (export (X) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);

        let successful_program = allocator.one();
        let successful_program = node_to_bytes(&allocator, successful_program).unwrap();
        DIAGNOSTICS.with(|registry| {
            let mut registry = registry.borrow_mut();
            let index = registry
                .entries
                .iter()
                .position(|(candidate, _)| *candidate == token)
                .unwrap();
            let old_size = registry.entries[index].1.size();
            registry.entries[index].1.frames.last_mut().unwrap().program = successful_program;
            let new_size = registry.entries[index].1.size();
            registry.bytes = registry.bytes - old_size + new_size;
        });

        let diagnostic = diagnose_clvm(token, &metadata(&[&artifact.metadata]));
        assert!(diagnostic.contains("CLVM error:"), "{diagnostic}");
        assert!(diagnostic.contains("<unknown:"), "{diagnostic}");
        assert!(diagnostic.starts_with("CLVM error: path into atom\n  "));
    }

    #[test]
    fn non_first_sidecar_owns_the_failure_program() {
        reset();
        let other = compiled("(include *standard-cl-26*) (export (X) (+ X 1))");
        let failing = compiled("(include *standard-cl-26*) (export (X) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &failing.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();

        let diagnostic = diagnose_clvm(
            token(&error),
            &metadata(&[&other.metadata, &failing.metadata]),
        );
        assert!(diagnostic.contains("CLVM error:"), "{diagnostic}");
        assert!(
            diagnostic.contains("File \"diagnostic.clsp\", line "),
            "{diagnostic}"
        );
    }

    #[test]
    fn missing_metadata_does_not_consume_token() {
        reset();
        let artifact = compiled("(include *standard-cl-26*) (export (X) (f X))");
        let mut allocator = Allocator::new();
        let program = decode(&mut allocator, &artifact.program);
        let error = run_clvm(&mut allocator, program, NodePtr::NIL, 1_000_000).unwrap_err();
        let token = token(&error);

        assert!(diagnose_clvm(token, &DebugMetadataCollection::default())
            .contains("no debug metadata loaded"));
        assert_eq!(diagnostic_registry_len(), 1);
        assert!(diagnose_clvm(token, &metadata(&[&artifact.metadata])).contains("CLVM error:"));
        assert_eq!(diagnostic_registry_len(), 0);
    }

    #[test]
    fn metadata_collection_rejects_duplicate_identity_and_malformed_bytes() {
        let artifact = compiled("(include *standard-cl-26*) (export () ())");
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
            "(include *standard-cl-26*) (export (PROGRAM ARGS) (a PROGRAM ARGS))",
        );
        let inner = compiled_named(
            "inner.clsp",
            "(include *standard-cl-26*) (defun fail (Y) (f Y)) (export (X) (fail X))",
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
        assert!(
            diagnostic.contains("File \"outer.clsp\", line "),
            "{diagnostic}"
        );
        assert!(
            diagnostic.contains("File \"inner.clsp\", line "),
            "{diagnostic}"
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_sidecar_helper_loads_only_when_explicitly_diagnosing() {
        reset();
        let artifact = compiled("(include *standard-cl-26*) (export (X) (f X))");
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
        assert!(diagnostic.contains("CLVM error:"), "{diagnostic}");
    }
}
