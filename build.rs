use std::collections::HashMap;
use std::fs;
use std::path::Path;

use clvmr::allocator::Allocator;
use toml::{Table, Value};

use chialisp::classic::clvm_tools::clvmc::CompileError;
use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
use chialisp::classic::platform::argparse::ArgumentValue;
use chialisp::compiler::comptypes::CompileErr;
use chialisp::compiler::srcloc::Srcloc;

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

fn compile_chialisp() -> Result<(), CompileError> {
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

    Ok(())
}

fn compile_chialisp_with_large_stack() {
    let compiler = std::thread::Builder::new()
        .name("chialisp-compiler".to_string())
        .stack_size(CHIALISP_COMPILER_STACK_SIZE)
        .spawn(|| {
            if let Err(e) = compile_chialisp() {
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
                if ext == "clsp" || ext == "clinc" {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
}

fn main() {
    emit_rerun_directives(Path::new("clsp"));
    println!("cargo:rerun-if-changed=chialisp.toml");
    println!("cargo:rerun-if-env-changed=CHIALISP_COMPILE");

    if std::env::var("CHIALISP_COMPILE").is_ok() {
        compile_chialisp_with_large_stack();
    }
}
