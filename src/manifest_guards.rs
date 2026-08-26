//! Manifest guards.
//!
//! These tests fail the suite when a source file exists on disk but isn't
//! wired into the hand-maintained manifest that makes it build or run. They
//! exist to prevent the "orphaned file" class of bug -- e.g. a test module
//! that was never added to `src/tests/mod.rs`, or a `.clsp` whose compiled
//! artifact a test loads but that was never registered in `chialisp.toml`.
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

/// Extract compiled CLVM paths under `clsp/` and `games/` that appear inside
/// double-quoted string literals. Dynamic paths containing a `{}` format
/// placeholder are returned as-is; the caller skips them since they can't be
/// checked statically.
fn clvm_artifact_literals(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find('"') {
        let after_quote = &rest[pos + 1..];
        if let Some(end) = after_quote.find('"') {
            let lit = &after_quote[..end];
            if (lit.ends_with(".hex") || lit.ends_with(".clvm.bin"))
                && (lit.starts_with("clsp/") || lit.starts_with("games/"))
            {
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

/// Every static compiled CLVM path referenced from Rust source must exist on
/// disk. The chialisp build (`tools/build-chialisp.sh`) runs before the test
/// suite, so a missing file means the source `.clsp` was never registered in
/// `chialisp.toml`'s `[compile]` table (or was renamed/removed).
#[test]
fn every_referenced_clvm_artifact_is_built() {
    let mut files = Vec::new();
    rs_files(Path::new("src"), &mut files);
    rs_files(Path::new("games"), &mut files);
    rs_files(Path::new("wasm"), &mut files);

    let mut missing = Vec::new();
    for file in &files {
        // Skip this file: it contains the `"clsp/` matcher literal itself.
        if file.file_name().and_then(|n| n.to_str()) == Some("manifest_guards.rs") {
            continue;
        }
        let text = read(file.to_str().unwrap());
        for lit in clvm_artifact_literals(&text) {
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
        "referenced CLVM artifacts are missing after build -- is the source .clsp registered \
         in chialisp.toml [compile]?\n  {}",
        missing.join("\n  ")
    );
}

fn registry_keys() -> (Vec<String>, Vec<String>) {
    let json: serde_json::Value = serde_json::from_str(&read("games/registry.json"))
        .unwrap_or_else(|e| panic!("manifest guard: invalid games/registry.json: {e}"));
    let strings = |field: &str| -> Vec<String> {
        json.get(field)
            .and_then(|v| v.as_array())
            .unwrap_or_else(|| panic!("manifest guard: games/registry.json missing {field}"))
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| panic!("manifest guard: {field} entries must be strings"))
                    .to_string()
            })
            .collect()
    };
    (strings("production"), strings("test"))
}

/// Every directory under `games/` except the JSON catalog and `games/host`
/// (the portable host contract, not a factory game) must be a registered
/// package, and every registered key must exist with conventional files.
/// Production packages must export the UI modules stitched by the generator;
/// their Rust module and Rust tests are optional. Internal test packages retain
/// the Rust hooks used by the simulator's package registration.
#[test]
fn every_game_package_is_registered() {
    let (production, test) = registry_keys();
    let mut registered = std::collections::BTreeSet::new();
    for key in production.iter().chain(test.iter()) {
        assert!(
            registered.insert(key.clone()),
            "duplicate game package key {key} in games/registry.json"
        );
    }

    let mut on_disk = std::collections::BTreeSet::new();
    for entry in fs::read_dir("games").expect("read games") {
        let path = entry.expect("dir entry").path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap()
            .to_string();
        if name.starts_with('.') || name == "host" {
            continue;
        }
        on_disk.insert(name);
    }

    let unregistered: Vec<_> = on_disk.difference(&registered).cloned().collect();
    let missing: Vec<_> = registered.difference(&on_disk).cloned().collect();
    assert!(
        unregistered.is_empty(),
        "games/* directories not listed in games/registry.json: {unregistered:?}"
    );
    assert!(
        missing.is_empty(),
        "games/registry.json keys with no package directory: {missing:?}"
    );

    let mut missing_files = Vec::new();
    for key in &registered {
        let root = PathBuf::from("games").join(key);
        if !root.join("clsp/factory.clsp").is_file() {
            missing_files.push(format!("games/{key}/clsp/factory.clsp"));
        }
        if production.iter().any(|k| k == key) {
            for rel in [
                "clsp/factory_probe.clsp",
                "ui/handProposal.ts",
                "ui/handProposalForm.tsx",
                "ui/play.tsx",
            ] {
                if !root.join(rel).is_file() {
                    missing_files.push(format!("games/{key}/{rel}"));
                }
            }
            if root.join("rust/tests/mod.rs").is_file() && !root.join("rust/mod.rs").is_file() {
                missing_files.push(format!(
                    "games/{key}/rust/mod.rs (required when rust/tests/mod.rs exists)"
                ));
            }
        } else {
            for rel in ["rust/mod.rs", "rust/tests/mod.rs"] {
                if !root.join(rel).is_file() {
                    missing_files.push(format!("games/{key}/{rel}"));
                }
            }
        }
    }
    assert!(
        missing_files.is_empty(),
        "registered game packages missing conventional files: {missing_files:?}"
    );
}

/// Game-owned Rust test modules, when present, must expose `test_funs` and be
/// pulled in through the generated full-suite aggregator rather than a
/// handwritten package list.
#[test]
fn every_game_package_test_module_is_aggregated() {
    let (production, test) = registry_keys();
    let mut missing = Vec::new();
    for key in production.iter().chain(test.iter()) {
        let tests = PathBuf::from(format!("games/{key}/rust/tests/mod.rs"));
        if !tests.is_file() {
            continue;
        }
        let src = read(tests.to_str().unwrap());
        if !src.contains("pub fn test_funs") {
            missing.push(key.clone());
        }
    }
    assert!(
        missing.is_empty(),
        "game packages missing rust/tests/mod.rs `pub fn test_funs`: {missing:?}"
    );

    let simulator_rs = read("src/simulator/mod.rs");
    assert!(
        simulator_rs.contains("game_package_test_funs()"),
        "src/simulator/mod.rs must call generated game_package_test_funs()"
    );
}

/// Prepared production factories must exist after the Chialisp build so the
/// frontend generator's preset list is not hollow.
#[test]
fn every_production_package_preset_exists() {
    let (production, _) = registry_keys();
    let mut missing = Vec::new();
    for key in production {
        let factory = PathBuf::from(format!("games/{key}/clsp/factory_prepared.clvm.bin"));
        if !factory.is_file() {
            missing.push(factory.display().to_string());
        }
    }
    assert!(
        missing.is_empty(),
        "production game presets missing after chialisp build: {missing:?}"
    );
}
