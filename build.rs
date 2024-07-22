use std::collections::HashMap;
use std::fs;

use clvmr::Allocator;
use toml::{Table, Value};

use clvm_tools_rs::classic::clvm_tools::clvmc::CompileError;
use clvm_tools_rs::classic::clvm_tools::comp_input::RunAndCompileInputData;
use clvm_tools_rs::classic::platform::argparse::ArgumentValue;
use clvm_tools_rs::compiler::comptypes::CompileErr;
use clvm_tools_rs::compiler::srcloc::Srcloc;

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

// Compile chialisp programs in this tree.
fn main() {
    if let Err(e) = compile_chialisp() {
        panic!("error compiling chialisp: {e:?}");
    }
}
