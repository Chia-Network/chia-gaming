//! std.pack is usable without std.shapes and has no annotation vocabulary.
use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
use chialisp::classic::platform::argparse::ArgumentValue;
use chialisp::compiler::compiler::compile_file;
use chialisp::compiler::comptypes::CompilerOutput;
use clvm_traits::ToClvm;
use std::{collections::HashMap, rc::Rc};

use crate::common::types::{chia_dialect, AllocEncoder, Node};

fn compile(body: &str) -> Vec<u8> {
    compile_with_library(body, "std.pack")
}

fn compile_with_library(body: &str, library: &str) -> Vec<u8> {
    let source = format!(
        "(include *standard-cl-26*) (import {library})
         (export (A B C D atom optional nil) {body})"
    );
    let arguments = HashMap::from([
        (
            "path_or_code".into(),
            ArgumentValue::ArgString(None, source.clone()),
        ),
        (
            "include".into(),
            ArgumentValue::ArgArray(vec![
                ArgumentValue::ArgString(None, "clsp".into()),
                ArgumentValue::ArgString(None, ".".into()),
            ]),
        ),
    ]);
    let mut allocator = Default::default();
    let parsed = RunAndCompileInputData::new(&mut allocator, &arguments).unwrap();
    let compiled = compile_file(
        &mut allocator,
        Rc::new(DefaultProgramRunner::new()),
        parsed.opts,
        &source,
        &mut HashMap::new(),
    )
    .unwrap_or_else(|error| panic!("{source}\n{error:?}"));
    let program = match compiled {
        CompilerOutput::Program(_, program) => Rc::new(program),
        CompilerOutput::Module(module) => module
            .components
            .iter()
            .find(|component| component.shortname == b"program")
            .expect("exported program")
            .content
            .clone(),
    };
    let node = chialisp::compiler::clvm::convert_to_clvm_rs(&mut allocator, program).unwrap();
    clvmr::serde::node_to_bytes(&allocator, node).unwrap()
}

fn evaluate(program: &[u8], values: &[i32; 7]) -> (u64, String) {
    let mut allocator = AllocEncoder::new();
    let program = clvmr::serde::node_from_bytes(allocator.allocator(), program).unwrap();
    let args = values.to_clvm(&mut allocator).unwrap();
    let result = clvmr::run_program(
        allocator.allocator(),
        &chia_dialect(),
        program,
        args,
        1_000_000,
    )
    .unwrap();
    (result.0, Node(result.1).to_hex(&mut allocator).unwrap())
}

#[test]
fn test_pack_matches_explicit_constructors_without_extra_cost() {
    for (template, explicit) in [
        ("A", "A"),
        ("()", "()"),
        ("(A . B)", "(c A B)"),
        ("(D . (A . B))", "(c D (c A B))"),
        ("((A . B) . (C . D))", "(c (c A B) (c C D))"),
        ("(A B C D)", "(c A (c B (c C (c D ()))))"),
        ("(A (B . C) D)", "(c A (c (c B C) (c D ())))"),
        ("(A B . C)", "(c A (c B C))"),
        ("#(A B C)", "(c A (c B C))"),
        ("#(A B C D)", "(c (c A B) (c C D))"),
        ("(atom A)", "(c atom (c A ()))"),
        ("(optional #(A B C))", "(c optional (c (c A (c B C)) ()))"),
        ("(nil . (atom . optional))", "(c nil (c atom optional))"),
        ("(A . nil)", "(c A nil)"),
        (
            "(A B C D atom optional nil)",
            "(c A (c B (c C (c D (c atom (c optional (c nil ())))))))",
        ),
    ] {
        let packed = compile(&format!("(pack {template})"));
        let baseline = compile(explicit);
        for values in [[11, 22, 33, 44, 55, 66, 77], [0, 0, 0, 0, 0, 0, 0]] {
            let (cost, result) = evaluate(&packed, &values);
            let (baseline_cost, expected) = evaluate(&baseline, &values);
            assert_eq!(result, expected, "template {template}, values {values:?}");
            assert!(
                cost <= baseline_cost,
                "{template}: pack cost {cost} exceeds explicit constructor cost {baseline_cost}"
            );
        }
    }
}

#[test]
fn test_make_uses_pack_construction_after_stripping_annotations() {
    for (template, explicit) in [
        ("((atom A) . (optional #(B C D)))", "(c A (c B (c C D)))"),
        ("((atom A) B C . nil)", "(c A (c B (c C ())))"),
        ("(optional (A B . C))", "(c A (c B C))"),
    ] {
        let made = compile_with_library(&format!("(make {template})"), "std.shapes");
        let baseline = compile(explicit);
        for values in [[11, 22, 33, 44, 55, 66, 77], [0, 0, 0, 0, 0, 0, 0]] {
            let (cost, result) = evaluate(&made, &values);
            let (baseline_cost, expected) = evaluate(&baseline, &values);
            assert_eq!(result, expected, "template {template}");
            assert!(
                cost <= baseline_cost,
                "{template}: make cost {cost} exceeds explicit constructor cost {baseline_cost}"
            );
        }
    }
}
