//! Rue imports compiled validators as opaque CLVM. The host loads one sidecar
//! per prepared factory, so attach each validator's original source annotations
//! to its embedded program before publishing that sidecar.

use std::fs;
use std::path::Path;

use chialisp::compiler::debug_metadata::{DebugMetadata, DebugNode, DebugParameter};

fn relocate_parameters(parameters: &mut DebugParameter, strings: usize) {
    match parameters {
        DebugParameter::Name { name, .. } => *name += strings,
        DebugParameter::Pair(left, right) => {
            relocate_parameters(left, strings);
            relocate_parameters(right, strings);
        }
        DebugParameter::Nil => {}
    }
}

fn relocate_node(node: &mut DebugNode, spans: usize, strings: usize, functions: usize) {
    let (span, label, function) = match node {
        DebugNode::Atom {
            span,
            label,
            function,
            ..
        } => (span, label, function),
        DebugNode::Pair {
            span,
            label,
            function,
            left,
            right,
        } => {
            relocate_node(left, spans, strings, functions);
            relocate_node(right, spans, strings, functions);
            (span, label, function)
        }
    };
    if let Some(span) = span {
        *span += spans;
    }
    if let Some(label) = label {
        *label += strings;
    }
    if let Some(function) = function {
        *function += functions;
    }
}

fn same_program(left: &DebugNode, right: &DebugNode) -> bool {
    match (left, right) {
        (DebugNode::Atom { value: a, .. }, DebugNode::Atom { value: b, .. }) => a == b,
        (
            DebugNode::Pair {
                left: a, right: b, ..
            },
            DebugNode::Pair {
                left: c, right: d, ..
            },
        ) => same_program(a, c) && same_program(b, d),
        _ => false,
    }
}

fn attach(node: &mut DebugNode, validator: &DebugNode) -> bool {
    if same_program(node, validator) {
        node.clone_from(validator);
        true
    } else if let DebugNode::Pair { left, right, .. } = node {
        let in_left = attach(left, validator);
        let in_right = attach(right, validator);
        in_left || in_right
    } else {
        false
    }
}

pub fn link_validators(factory: &mut DebugMetadata, directory: &Path) -> Result<(), String> {
    let mut validators = Vec::new();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("reading {}: {e}", directory.display())),
    };
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.to_string_lossy().ends_with(".debug.clvm.bin") {
            validators.push(path);
        }
    }
    validators.sort();
    for path in validators {
        let encoded = fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
        let mut metadata = DebugMetadata::decode(&encoded)?;
        for span in &mut metadata.spans {
            span.file += factory.files.len();
        }
        for function in &mut metadata.functions {
            function.name += factory.strings.len();
            relocate_parameters(&mut function.parameters, factory.strings.len());
        }
        relocate_node(
            &mut metadata.tree,
            factory.spans.len(),
            factory.strings.len(),
            factory.functions.len(),
        );
        if !attach(&mut factory.tree, &metadata.tree) {
            // A factory may reference a validator only by its tree hash.
            continue;
        }
        factory.files.extend(metadata.files);
        factory.spans.extend(metadata.spans);
        factory.strings.extend(metadata.strings);
        factory.functions.extend(metadata.functions);
    }
    Ok(())
}
