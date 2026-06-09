//! Manifest guards.
//!
//! These tests fail the suite when a source file exists on disk but isn't
//! wired into the hand-maintained manifest that makes it build or run. They
//! exist to prevent the "orphaned file" class of bug -- e.g. a test module
//! that was never added to `src/tests/mod.rs`, or a `.clsp` whose compiled
//! `.hex` a test loads but that was never registered in `chialisp.toml`.
//! Both of those are silent: nothing fails to compile, the file is simply
//! ignored, so the coverage or behavior it was meant to add never happens.

use std::fs;
use std::path::{Path, PathBuf};

fn read(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("manifest guard: cannot read {path}: {e}"))
}

/// Recursively collect every `.rs` file under `dir`.
fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in
        fs::read_dir(dir).unwrap_or_else(|e| panic!("manifest guard: read_dir {dir:?}: {e}"))
    {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Extract `clsp/.../*.hex` paths that appear inside double-quoted string
/// literals. Dynamic paths containing a `{}` format placeholder are returned
/// as-is; the caller skips them since they can't be checked statically.
fn hex_literals(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("\"clsp/") {
        let after_quote = &rest[pos + 1..];
        if let Some(end) = after_quote.find('"') {
            let lit = &after_quote[..end];
            if lit.ends_with(".hex") {
                out.push(lit.to_string());
            }
            rest = &after_quote[end + 1..];
        } else {
            break;
        }
    }
    out
}

/// Every `src/tests/*.rs` (other than `mod.rs`) must be declared in
/// `src/tests/mod.rs` (so it compiles), and any module that exposes a
/// `test_funs` collector must also be aggregated into `run_simulation_tests`
/// in `src/simulator/mod.rs` (so it actually runs).
#[test]
fn every_test_module_is_registered_and_run() {
    let mod_rs = read("src/tests/mod.rs");
    let simulator_rs = read("src/simulator/mod.rs");

    let mut missing_decl = Vec::new();
    let mut missing_run = Vec::new();

    for entry in fs::read_dir("src/tests").expect("read src/tests") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap()
            .to_string();
        if stem == "mod" {
            continue;
        }
        if !mod_rs.contains(&format!("pub mod {stem};")) {
            missing_decl.push(stem.clone());
        }
        // Only modules that expose tests need to be wired into the runner.
        let src = read(path.to_str().unwrap());
        if src.contains("pub fn test_funs")
            && !simulator_rs.contains(&format!("tests::{stem}::test_funs"))
        {
            missing_run.push(stem);
        }
    }

    assert!(
        missing_decl.is_empty(),
        "src/tests/*.rs not declared in src/tests/mod.rs (add `pub mod NAME;`): {missing_decl:?}"
    );
    assert!(
        missing_run.is_empty(),
        "test modules not wired into run_simulation_tests in src/simulator/mod.rs \
         (add `use crate::tests::NAME::test_funs as NAME_tests;` and a ref_lists entry): {missing_run:?}"
    );
}

/// Every static `clsp/.../*.hex` path referenced from Rust source must exist on
/// disk. The chialisp build (`tools/build-chialisp.sh`) runs before the test
/// suite, so a missing file means the source `.clsp` was never registered in
/// `chialisp.toml`'s `[compile]` table (or was renamed/removed).
#[test]
fn every_referenced_hex_is_built() {
    let mut files = Vec::new();
    rs_files(Path::new("src"), &mut files);

    let mut missing = Vec::new();
    for file in &files {
        // Skip this file: it contains the `"clsp/` matcher literal itself.
        if file.file_name().and_then(|n| n.to_str()) == Some("manifest_guards.rs") {
            continue;
        }
        let text = read(file.to_str().unwrap());
        for lit in hex_literals(&text) {
            if lit.contains('{') {
                continue; // dynamic path, not statically checkable
            }
            if !Path::new(&lit).exists() {
                missing.push(format!("{lit}  (referenced in {})", file.display()));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "referenced .hex files are missing after build -- is the source .clsp registered \
         in chialisp.toml [compile]?\n  {}",
        missing.join("\n  ")
    );
}
