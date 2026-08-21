use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use clvmr::allocator::Allocator;
use serde_json::Value as JsonValue;
use toml::{Table, Value};

use chialisp::classic::clvm_tools::clvmc::CompileError;
use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
use chialisp::classic::platform::argparse::ArgumentValue;
use chialisp::compiler::comptypes::CompileErr;
use chialisp::compiler::srcloc::Srcloc;

#[derive(Clone, Debug)]
struct GameRegistry {
    production: Vec<String>,
    test: Vec<String>,
}

fn do_compile(title: &str, filename: &str) -> Result<(), CompileError> {
    let mut allocator = Allocator::new();
    let mut arguments: HashMap<String, ArgumentValue> = HashMap::new();
    arguments.insert(
        "include".to_string(),
        ArgumentValue::ArgArray(vec![
            ArgumentValue::ArgString(None, "clsp".to_string()),
            ArgumentValue::ArgString(None, ".".to_string()),
        ]),
    );

    let file_content = fs::read_to_string(filename).map_err(|e| {
        CompileErr(
            Srcloc::start(filename),
            format!("failed to read {filename}: {e:?}"),
        )
    })?;

    arguments.insert(
        "path_or_code".to_string(),
        ArgumentValue::ArgString(Some(filename.to_string()), file_content),
    );

    let parsed = RunAndCompileInputData::new(&mut allocator, &arguments).map_err(|e| {
        CompileError::Modern(
            Srcloc::start("*error*"),
            format!("error building chialisp {title}: {e}"),
        )
    })?;
    let mut symbol_table = HashMap::new();

    parsed.compile_modern(&mut allocator, &mut symbol_table)?;

    Ok(())
}

fn string_list(value: Option<&JsonValue>, field: &str) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| {
                        panic!("games/registry.json {field} entries must be strings")
                    })
                    .to_string()
            })
            .collect(),
        _ => panic!("games/registry.json missing {field} array"),
    }
}

fn load_registry() -> GameRegistry {
    let text = fs::read_to_string("games/registry.json")
        .unwrap_or_else(|e| panic!("failed to read games/registry.json: {e}"));
    let json: JsonValue =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("invalid games/registry.json: {e}"));
    GameRegistry {
        production: string_list(json.get("production"), "production"),
        test: string_list(json.get("test"), "test"),
    }
}

fn is_valid_package_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn validate_package(key: &str, production: bool) {
    if !is_valid_package_key(key) {
        panic!("invalid game package key {key:?}");
    }
    let root = PathBuf::from("games").join(key);
    let rust_mod = root.join("rust/mod.rs");
    let rust_tests = root.join("rust/tests/mod.rs");
    let factory = root.join("clsp/factory.clsp");
    if !rust_mod.is_file() {
        panic!("game package {key} missing rust/mod.rs");
    }
    if !rust_tests.is_file() {
        panic!("game package {key} missing rust/tests/mod.rs");
    }
    if !factory.is_file() {
        panic!("game package {key} missing clsp/factory.clsp");
    }
    if production {
        for rel in [
            "ui/handProposal.ts",
            "ui/handProposalForm.tsx",
            "ui/play.tsx",
        ] {
            if !root.join(rel).is_file() {
                panic!("production game package {key} missing {rel}");
            }
        }
    }
}

fn package_clsp_entrypoints(key: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let factory = format!("games/{key}/clsp/factory.clsp");
    out.push((format!("{key}-factory"), factory));
    let onchain = PathBuf::from(format!("games/{key}/clsp/onchain"));
    if onchain.is_dir() {
        let mut files: Vec<PathBuf> = fs::read_dir(&onchain)
            .unwrap_or_else(|e| panic!("read {onchain:?}: {e}"))
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("clsp"))
            .filter(|p| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|stem| !stem.starts_with("test_"))
            })
            .collect();
        files.sort();
        for file in files {
            let name = file
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("onchain");
            out.push((format!("{key}-{name}"), file.to_string_lossy().into_owned()));
        }
    }
    out
}

fn compile_chialisp(registry: &GameRegistry) -> Result<(), CompileError> {
    let srcloc = Srcloc::start("chialisp.toml");
    let chialisp_toml_text = fs::read_to_string("chialisp.toml").map_err(|e| {
        CompileError::Modern(
            srcloc.clone(),
            format!("Error reading chialisp.toml: {e:?}"),
        )
    })?;

    let chialisp_toml = chialisp_toml_text
        .parse::<Table>()
        .map_err(|e| CompileError::Modern(srcloc, format!("Error parsing chialisp.toml: {e:?}")))?;

    if let Some(Value::Table(t)) = chialisp_toml.get("compile") {
        for (k, v) in t.iter() {
            if let Value::String(s) = v {
                do_compile(k, s)?;
            }
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    for key in registry.production.iter().chain(registry.test.iter()) {
        if !seen.insert(key) {
            panic!("duplicate game package key {key}");
        }
        validate_package(key, registry.production.iter().any(|k| k == key));
        for (title, path) in package_clsp_entrypoints(key) {
            do_compile(&title, &path)?;
        }
    }

    Ok(())
}

fn emit_rerun_directives(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                emit_rerun_directives(&path);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext == "clsp" || ext == "clinc" || ext == "json" || ext == "rs" {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
}

fn generate_package_modules(registry: &GameRegistry, out_dir: &Path) {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut packages = String::new();
    for key in registry.production.iter().chain(registry.test.iter()) {
        let path = manifest_dir.join("games").join(key).join("rust/mod.rs");
        packages.push_str(&format!(
            "#[path = \"{}\"]\npub mod {key};\n",
            path.display().to_string().replace('\\', "\\\\")
        ));
    }
    fs::write(out_dir.join("game_packages.rs"), packages).unwrap();

    let mut register =
        String::from("pub fn production_package_keys() -> &'static [&'static str] {\n    &[");
    for key in &registry.production {
        register.push_str(&format!("\"{key}\", "));
    }
    register.push_str("]\n}\n\npub fn test_package_keys() -> &'static [&'static str] {\n    &[");
    for key in &registry.test {
        register.push_str(&format!("\"{key}\", "));
    }
    register.push_str(
        r#"]
}

pub fn register_one_package(
    allocator: &mut crate::common::types::AllocEncoder,
    key: &str,
    factories: &mut std::collections::BTreeMap<
        crate::common::types::GameType,
        crate::session_phases::types::GameFactory,
    >,
    package_ids: &mut Vec<(String, crate::common::types::GameType)>,
) {
    match key {
"#,
    );
    for key in registry.production.iter().chain(registry.test.iter()) {
        register.push_str(&format!(
            "        \"{key}\" => {{\n            let factory = crate::games::{key}::prepared_factory(allocator).unwrap_or_else(|e| panic!(\"package {key} factory: {{e:?}}\"));\n            let probe = crate::games::{key}::probe_parameters(allocator).unwrap_or_else(|e| panic!(\"package {key} probe: {{e:?}}\"));\n            crate::session_phases::game_collection::register_package(\n                allocator,\n                \"{key}\",\n                factory,\n                probe,\n                factories,\n                package_ids,\n            );\n        }}\n"
        ));
    }
    register.push_str(
        r#"        other => panic!("unknown game package {other}"),
    }
}
"#,
    );
    fs::write(out_dir.join("game_register.rs"), register).unwrap();

    let mut tests = String::from(
        "pub fn game_package_test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {\n    let mut funs = Vec::new();\n",
    );
    for key in registry.production.iter().chain(registry.test.iter()) {
        tests.push_str(&format!(
            "    funs.extend(crate::games::{key}::tests::test_funs());\n"
        ));
    }
    tests.push_str("    funs\n}\n");
    fs::write(out_dir.join("game_package_test_funs.rs"), tests).unwrap();
}

fn main() {
    let registry = load_registry();
    let mut seen = std::collections::BTreeSet::new();
    for key in registry.production.iter().chain(registry.test.iter()) {
        if !seen.insert(key) {
            panic!("duplicate game package key {key}");
        }
        validate_package(key, registry.production.iter().any(|k| k == key));
    }

    emit_rerun_directives(Path::new("clsp"));
    emit_rerun_directives(Path::new("games"));
    println!("cargo:rerun-if-changed=chialisp.toml");
    println!("cargo:rerun-if-changed=games/registry.json");
    println!("cargo:rerun-if-env-changed=CHIALISP_COMPILE");

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    generate_package_modules(&registry, &out_dir);

    if std::env::var("CHIALISP_COMPILE").is_ok() {
        if let Err(e) = compile_chialisp(&registry) {
            panic!("error compiling chialisp: {e:?}");
        }
    }
}
