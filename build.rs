use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use clvmr::allocator::Allocator;
use clvmr::chia_dialect::ChiaDialect;
use clvmr::serde::{node_from_bytes, node_to_bytes};
use clvmr::{run_program, NodePtr, SExp};
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

const CHIALISP_COMPILER_STACK_SIZE: usize = 128 * 1024 * 1024;

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
    let factory_probe = root.join("clsp/factory_probe.clsp");
    if !factory.is_file() {
        panic!("game package {key} missing clsp/factory.clsp");
    }
    if production {
        if !factory_probe.is_file() {
            panic!("production game package {key} missing clsp/factory_probe.clsp");
        }
        for rel in [
            "ui/handProposal.ts",
            "ui/handProposalForm.tsx",
            "ui/play.tsx",
        ] {
            if !root.join(rel).is_file() {
                panic!("production game package {key} missing {rel}");
            }
        }
        if rust_tests.is_file() && !rust_mod.is_file() {
            panic!("production game package {key} has rust/tests/mod.rs but no rust/mod.rs");
        }
    } else {
        if !rust_mod.is_file() {
            panic!("test game package {key} missing rust/mod.rs");
        }
        if !rust_tests.is_file() {
            panic!("test game package {key} missing rust/tests/mod.rs");
        }
    }
}

fn package_clsp_entrypoints(key: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let factory = format!("games/{key}/clsp/factory.clsp");
    out.push((format!("{key}-factory"), factory));
    let factory_probe = format!("games/{key}/clsp/factory_probe.clsp");
    if Path::new(&factory_probe).is_file() {
        out.push((format!("{key}-factory-probe"), factory_probe));
    }
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

fn proper_list(allocator: &Allocator, mut node: NodePtr) -> Option<Vec<NodePtr>> {
    let mut items = Vec::new();
    loop {
        match allocator.sexp(node) {
            SExp::Pair(first, rest) => {
                items.push(first);
                node = rest;
            }
            SExp::Atom if allocator.atom(node).is_empty() => return Some(items),
            SExp::Atom => return None,
        }
    }
}

fn list_from_nodes(allocator: &mut Allocator, nodes: &[NodePtr]) -> Result<NodePtr, String> {
    let mut tail = NodePtr::NIL;
    for node in nodes.iter().rev() {
        tail = allocator
            .new_pair(*node, tail)
            .map_err(|e| format!("building list: {e:?}"))?;
    }
    Ok(tail)
}

fn curry_program(
    allocator: &mut Allocator,
    program: NodePtr,
    args: &[NodePtr],
) -> Result<NodePtr, String> {
    let quote = allocator.one();
    let apply = allocator
        .new_atom(&[2])
        .map_err(|e| format!("allocating apply atom: {e:?}"))?;
    let cons = allocator
        .new_atom(&[4])
        .map_err(|e| format!("allocating cons atom: {e:?}"))?;
    let mut curried_args = quote;
    for arg in args.iter().rev() {
        let quoted_arg = allocator
            .new_pair(quote, *arg)
            .map_err(|e| format!("quoting curry argument: {e:?}"))?;
        curried_args = list_from_nodes(allocator, &[cons, quoted_arg, curried_args])?;
    }
    let quoted_program = allocator
        .new_pair(quote, program)
        .map_err(|e| format!("quoting factory: {e:?}"))?;
    list_from_nodes(allocator, &[apply, quoted_program, curried_args])
}

fn read_hex_node(allocator: &mut Allocator, path: &Path) -> Result<NodePtr, String> {
    let encoded = fs::read_to_string(path)
        .map_err(|e| format!("reading compiled Chialisp {}: {e}", path.display()))?;
    let bytes = hex::decode(encoded.trim())
        .map_err(|e| format!("decoding compiled Chialisp {}: {e}", path.display()))?;
    node_from_bytes(allocator, &bytes)
        .map_err(|e| format!("parsing compiled Chialisp {}: {e:?}", path.display()))
}

fn prepare_game_packages(registry: &GameRegistry) -> Result<HashMap<String, [u8; 32]>, String> {
    let mut package_ids = HashMap::new();
    let mut manifest = Vec::new();

    for key in &registry.production {
        let root = PathBuf::from("games").join(key).join("clsp");
        let raw_factory_path = root.join(format!("factory_{key}_factory.hex"));
        let mut allocator = Allocator::new();
        let raw_factory = read_hex_node(&mut allocator, &raw_factory_path)?;

        let args_path = root.join("factory_args.clvm.bin");
        let prepared_factory = if args_path.is_file() {
            let bytes = fs::read(&args_path)
                .map_err(|e| format!("reading factory arguments {}: {e}", args_path.display()))?;
            let args_node = node_from_bytes(&mut allocator, &bytes)
                .map_err(|e| format!("parsing factory arguments {}: {e:?}", args_path.display()))?;
            let args = proper_list(&allocator, args_node).ok_or_else(|| {
                format!(
                    "factory arguments {} are not a proper list",
                    args_path.display()
                )
            })?;
            curry_program(&mut allocator, raw_factory, &args)?
        } else {
            raw_factory
        };

        let prepared_path = root.join("factory_prepared.clvm.bin");
        let prepared_bytes = node_to_bytes(&allocator, prepared_factory)
            .map_err(|e| format!("serializing prepared factory for {key}: {e:?}"))?;
        fs::write(&prepared_path, prepared_bytes)
            .map_err(|e| format!("writing prepared factory {}: {e}", prepared_path.display()))?;

        let probe_path = root.join("factory_probe.hex");
        let probe_program = read_hex_node(&mut allocator, &probe_path)?;
        let probe_parameters = run_program(
            &mut allocator,
            &ChiaDialect::default(),
            probe_program,
            NodePtr::NIL,
            11_000_000_000,
        )
        .map_err(|e| format!("running factory probe for {key}: {e:?}"))?
        .1;
        let factory_result = run_program(
            &mut allocator,
            &ChiaDialect::default(),
            prepared_factory,
            probe_parameters,
            11_000_000_000,
        )
        .map_err(|e| format!("running prepared factory for {key}: {e:?}"))?
        .1;
        let records = proper_list(&allocator, factory_result)
            .ok_or_else(|| format!("factory {key} did not return a proper list"))?;
        let first = records
            .first()
            .ok_or_else(|| format!("factory {key} returned no games"))?;
        let fields = proper_list(&allocator, *first)
            .ok_or_else(|| format!("factory {key} first game is not a proper list"))?;
        if fields.len() != 10 {
            return Err(format!(
                "factory {key} first game has {} fields, expected 10",
                fields.len()
            ));
        }
        let id = clvm_utils::tree_hash(&allocator, fields[9]).to_bytes();

        package_ids.insert(key.clone(), id);
        manifest.push(serde_json::json!({
            "key": key,
            "id": hex::encode(id),
            "factory": format!("games/{key}/clsp/factory_prepared.clvm.bin"),
        }));
    }

    let manifest_path = Path::new("games/package_manifest.json");
    let manifest_json = serde_json::to_vec_pretty(&serde_json::json!({ "production": manifest }))
        .map_err(|e| format!("serializing game package manifest: {e}"))?;
    fs::write(manifest_path, manifest_json)
        .map_err(|e| format!("writing {}: {e}", manifest_path.display()))?;
    Ok(package_ids)
}

fn load_package_ids(registry: &GameRegistry) -> HashMap<String, [u8; 32]> {
    let path = Path::new("games/package_manifest.json");
    let text = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}; run ./cb.sh", path.display()));
    let json: JsonValue =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("invalid {}: {e}", path.display()));
    let entries = json
        .get("production")
        .and_then(JsonValue::as_array)
        .unwrap_or_else(|| panic!("{} missing production array", path.display()));
    let mut ids = HashMap::new();
    for entry in entries {
        let key = entry
            .get("key")
            .and_then(JsonValue::as_str)
            .unwrap_or_else(|| panic!("{} package missing key", path.display()));
        let id = entry
            .get("id")
            .and_then(JsonValue::as_str)
            .unwrap_or_else(|| panic!("{} package {key} missing id", path.display()));
        let bytes = hex::decode(id)
            .unwrap_or_else(|e| panic!("{} package {key} invalid id: {e}", path.display()));
        let id: [u8; 32] = bytes.try_into().unwrap_or_else(|v: Vec<u8>| {
            panic!("{} package {key} id has {} bytes", path.display(), v.len())
        });
        ids.insert(key.to_string(), id);
    }
    for key in &registry.production {
        if !ids.contains_key(key) {
            panic!("{} missing production package {key}", path.display());
        }
    }
    ids
}

fn compile_chialisp_with_large_stack(registry: GameRegistry) {
    let compiler = std::thread::Builder::new()
        .name("chialisp-compiler".to_string())
        .stack_size(CHIALISP_COMPILER_STACK_SIZE)
        .spawn(move || {
            if let Err(e) = compile_chialisp(&registry) {
                panic!("error compiling chialisp: {e:?}");
            }
        })
        .expect("failed to start Chialisp compiler thread");

    if let Err(payload) = compiler.join() {
        std::panic::resume_unwind(payload);
    }
}

fn emit_rerun_directives(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                emit_rerun_directives(&path);
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if (ext == "clsp" || ext == "clinc" || ext == "json" || ext == "rs")
                    && path != Path::new("games/package_manifest.json")
                {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
}

fn generate_package_modules(
    registry: &GameRegistry,
    package_ids: &HashMap<String, [u8; 32]>,
    out_dir: &Path,
) {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut packages = String::new();
    for key in registry.production.iter().chain(registry.test.iter()) {
        let path = manifest_dir.join("games").join(key).join("rust/mod.rs");
        if !path.is_file() {
            continue;
        }
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
    register.push_str(
        "]\n}\n\npub fn built_production_package_ids() -> Vec<(String, crate::common::types::GameType)> {\n    vec![",
    );
    for key in &registry.production {
        let id = package_ids
            .get(key)
            .unwrap_or_else(|| panic!("missing generated protocol id for package {key}"));
        let id_bytes = id
            .iter()
            .map(|byte| format!("0x{byte:02x}"))
            .collect::<Vec<_>>()
            .join(", ");
        register.push_str(&format!(
            "(\"{key}\".to_string(), crate::common::types::GameType::from_hash(crate::common::types::Hash::from_bytes([{id_bytes}]))), "
        ));
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
        crate::common::types::ProgramRef,
    >,
    package_ids: &mut Vec<(String, crate::common::types::GameType)>,
) {
    match key {
"#,
    );
    for key in &registry.production {
        let id = package_ids
            .get(key)
            .unwrap_or_else(|| panic!("missing generated protocol id for package {key}"));
        let id_bytes = id
            .iter()
            .map(|byte| format!("0x{byte:02x}"))
            .collect::<Vec<_>>()
            .join(", ");
        register.push_str(&format!(
            "        \"{key}\" => crate::session_phases::game_collection::register_built_package(\n            allocator,\n            \"{key}\",\n            crate::common::types::GameType::from_hash(crate::common::types::Hash::from_bytes([{id_bytes}])),\n            factories,\n            package_ids,\n        ),\n"
        ));
    }
    for key in &registry.test {
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
        let path = manifest_dir
            .join("games")
            .join(key)
            .join("rust/tests/mod.rs");
        if !path.is_file() {
            continue;
        }
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
    let package_ids = if std::env::var("CHIALISP_COMPILE").is_ok() {
        compile_chialisp_with_large_stack(registry.clone());
        prepare_game_packages(&registry)
            .unwrap_or_else(|e| panic!("error preparing game packages: {e}"))
    } else {
        load_package_ids(&registry)
    };
    generate_package_modules(&registry, &package_ids, &out_dir);
}
