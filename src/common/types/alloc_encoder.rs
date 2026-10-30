use chialisp::runtime_print::RuntimePrintOutput;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;
use clvmr::Allocator;
use std::collections::VecDeque;

use crate::clvm_execution::DiagnosticToken;

const MAX_RUNTIME_PRINT_LINES: usize = 256;
const MAX_RUNTIME_PRINT_BYTES: usize = 256 * 1024;
const MAX_PENDING_CLVM_DIAGNOSTICS: usize = 16;

pub struct AllocEncoder {
    allocator: Allocator,
    runtime_prints: VecDeque<String>,
    runtime_print_bytes: usize,
    dropped_runtime_prints: usize,
    clvm_diagnostics: VecDeque<DiagnosticToken>,
}

impl Default for AllocEncoder {
    fn default() -> Self {
        Self {
            allocator: Allocator::new(),
            runtime_prints: VecDeque::new(),
            runtime_print_bytes: 0,
            dropped_runtime_prints: 0,
            clvm_diagnostics: VecDeque::new(),
        }
    }
}

impl AllocEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allocator_ref(&self) -> &Allocator {
        &self.allocator
    }

    pub fn allocator(&mut self) -> &mut Allocator {
        &mut self.allocator
    }

    pub fn push_runtime_prints(&mut self, output: RuntimePrintOutput) {
        self.dropped_runtime_prints += output.dropped;
        for record in output.records {
            let line = format!("[clvm-print] {record}");
            let size = line.len();
            if size > MAX_RUNTIME_PRINT_BYTES {
                self.dropped_runtime_prints += 1;
                continue;
            }
            while self.runtime_prints.len() >= MAX_RUNTIME_PRINT_LINES
                || self.runtime_print_bytes + size > MAX_RUNTIME_PRINT_BYTES
            {
                let Some(retired) = self.runtime_prints.pop_front() else {
                    break;
                };
                self.runtime_print_bytes -= retired.len();
                self.dropped_runtime_prints += 1;
            }
            self.runtime_print_bytes += size;
            self.runtime_prints.push_back(line);
        }
    }

    pub fn drain_runtime_prints(&mut self) -> Vec<String> {
        let mut lines = Vec::with_capacity(
            self.runtime_prints.len() + usize::from(self.dropped_runtime_prints > 0),
        );
        if self.dropped_runtime_prints > 0 {
            lines.push(format!(
                "[clvm-print] <{} earlier message(s) omitted>",
                self.dropped_runtime_prints
            ));
        }
        lines.extend(self.runtime_prints.drain(..));
        self.runtime_print_bytes = 0;
        self.dropped_runtime_prints = 0;
        lines
    }

    pub fn push_clvm_diagnostic(&mut self, token: DiagnosticToken) {
        if self.clvm_diagnostics.len() >= MAX_PENDING_CLVM_DIAGNOSTICS {
            self.clvm_diagnostics.pop_front();
        }
        self.clvm_diagnostics.push_back(token);
    }

    pub fn drain_clvm_diagnostics(&mut self) -> impl Iterator<Item = DiagnosticToken> + '_ {
        self.clvm_diagnostics.drain(..)
    }
}

impl ToClvm<AllocEncoder> for NodePtr {
    fn to_clvm(&self, _encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        Ok(*self)
    }
}

impl ClvmEncoder for AllocEncoder {
    type Node = NodePtr;

    fn encode_atom(&mut self, bytes: clvm_traits::Atom<'_>) -> Result<Self::Node, ToClvmError> {
        self.allocator
            .new_atom(&bytes)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }

    fn encode_pair(
        &mut self,
        first: Self::Node,
        rest: Self::Node,
    ) -> Result<Self::Node, ToClvmError> {
        self.allocator
            .new_pair(first, rest)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }
}

#[cfg(test)]
mod tests {
    use chialisp::runtime_print::{RuntimePrintKind, RuntimePrintRecord};

    use super::*;

    #[test]
    fn runtime_print_queue_keeps_newest_bounded_lines() {
        let mut encoder = AllocEncoder::new();
        for index in 0..=MAX_RUNTIME_PRINT_LINES {
            encoder.push_runtime_prints(RuntimePrintOutput {
                records: vec![RuntimePrintRecord {
                    kind: RuntimePrintKind::Chialisp,
                    source: None,
                    value: index.to_string(),
                }],
                dropped: 0,
            });
        }

        let lines = encoder.drain_runtime_prints();
        assert_eq!(lines.len(), MAX_RUNTIME_PRINT_LINES + 1);
        assert_eq!(lines[0], "[clvm-print] <1 earlier message(s) omitted>");
        assert_eq!(lines[1], "[clvm-print] 1");
        assert_eq!(lines.last().map(String::as_str), Some("[clvm-print] 256"));
    }
}
