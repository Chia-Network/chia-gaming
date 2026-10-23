//! Standalone contract tests for std.shapes; no game or referee imports.
use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Node};
use clvm_traits::ToClvm;
use clvmr::run_program;

/// These are errors in a closed union, rather than runtime fallback cases.
#[test]
fn test_shapes_reject_ambiguous_or_incorrect_templates() {
    use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
    use chialisp::compiler::compiler::{compile_file, DefaultCompilerOpts};
    use chialisp::compiler::comptypes::CompilerOpts;
    use std::{collections::HashMap, rc::Rc};

    for (body, expected) in [
        (
            "(export VALUE (if-shape VALUE ((atom a) 1) (nil 2)))",
            "alternatives overlap",
        ),
        (
            "(export VALUE (if-shape VALUE (((optional (atom a)) . b) 1) (((c . d) . e) 2)))",
            "alternatives overlap",
        ),
        (
            "(export VALUE (if-shape VALUE ((a . b) 1) ((c . d) 2)))",
            "alternatives overlap",
        ),
        (
            "(export VALUE (if-shape VALUE (((optional ((atom a) . nil)) . b) 1) (((c . d) . e) 2)))",
            "alternatives overlap",
        ),
        (
            "(export VALUE (if-shape VALUE (((atom a) . b) 1) ((c . (atom d)) 2)))",
            "alternatives overlap",
        ),
        (
            "(defun-shape trio #(a b c)) (export (X Y) (make (trio X Y)))",
            "too few shape arguments",
        ),
        (
            "(defun-shape duo #(a b)) (export (X Y Z) (make (duo X Y Z)))",
            "too many shape arguments",
        ),
        (
            "(export VALUE (if-shape VALUE))",
            "needs at least one alternative",
        ),
        (
            "(defun-shape duplicate (a . a)) (export () 0)",
            "field names must be unique",
        ),
    ] {
        let source = format!("(include *standard-cl-23*)\n(import std.shapes)\n{body}");
        let opts = Rc::new(DefaultCompilerOpts::new("shape-errors.clsp"))
            .set_search_paths(&["clsp".to_string(), ".".to_string()]);
        let result = compile_file(
            &mut Default::default(),
            Rc::new(DefaultProgramRunner::new()),
            opts,
            &source,
            &mut HashMap::new(),
        );
        let error = match result {
            Err(error) => format!("{error:?}"),
            Ok(_) => panic!("shape template unexpectedly compiled: {body}"),
        };
        assert!(
            error.contains(expected),
            "expected {expected} for {body}, got {error}"
        );
    }
}

#[test]
fn test_shapes_construct_invoke_and_dispatch() {
    let mut allocator = AllocEncoder::new();
    let program = read_hex_puzzle(&mut allocator, "clsp/test/test_shapes.hex").unwrap();
    let program = program.to_clvm(&mut allocator).unwrap();
    let args = [11, 22, 33, 44].to_clvm(&mut allocator).unwrap();
    let result = run_program(allocator.allocator(), &chia_dialect(), program, args, 0)
        .unwrap()
        .1;
    let expected = vec![
        Node((11, (22, 33)).to_clvm(&mut allocator).unwrap()),
        Node(((11, 22), (33, 44)).to_clvm(&mut allocator).unwrap()),
        Node(
            ((11, (22, 33)), ((11, 22), (33, 44)))
                .to_clvm(&mut allocator)
                .unwrap(),
        ),
        Node(
            ((11, (22, 33)), ((11, 22), (33, 44)))
                .to_clvm(&mut allocator)
                .unwrap(),
        ),
        Node(66.to_clvm(&mut allocator).unwrap()),
        Node(66.to_clvm(&mut allocator).unwrap()),
        Node(66.to_clvm(&mut allocator).unwrap()),
        Node(0.to_clvm(&mut allocator).unwrap()),
        Node(11.to_clvm(&mut allocator).unwrap()),
        Node(33.to_clvm(&mut allocator).unwrap()),
        Node(66.to_clvm(&mut allocator).unwrap()),
        Node(11.to_clvm(&mut allocator).unwrap()),
        Node(11.to_clvm(&mut allocator).unwrap()),
        Node(17.to_clvm(&mut allocator).unwrap()),
        Node(33.to_clvm(&mut allocator).unwrap()),
        Node(1.to_clvm(&mut allocator).unwrap()),
        Node(2.to_clvm(&mut allocator).unwrap()),
        Node(3.to_clvm(&mut allocator).unwrap()),
        Node(4.to_clvm(&mut allocator).unwrap()),
        Node(2.to_clvm(&mut allocator).unwrap()),
        Node([11, 22, 33].to_clvm(&mut allocator).unwrap()),
        Node((11, (22, 33)).to_clvm(&mut allocator).unwrap()),
        Node(11.to_clvm(&mut allocator).unwrap()),
        Node((11, 22).to_clvm(&mut allocator).unwrap()),
        Node(((11, 22), (33, (44, 11))).to_clvm(&mut allocator).unwrap()),
        Node(
            (((11, 22), (33, (44, 11))), ((22, (33, 44)), (11, (22, 33))))
                .to_clvm(&mut allocator)
                .unwrap(),
        ),
        Node(1.to_clvm(&mut allocator).unwrap()),
        Node(2.to_clvm(&mut allocator).unwrap()),
        Node(3.to_clvm(&mut allocator).unwrap()),
        Node(33.to_clvm(&mut allocator).unwrap()),
        Node(66.to_clvm(&mut allocator).unwrap()),
        Node(110.to_clvm(&mut allocator).unwrap()),
    ]
    .to_clvm(&mut allocator)
    .unwrap();
    assert_eq!(
        Node(result).to_hex(&mut allocator).unwrap(),
        Node(expected).to_hex(&mut allocator).unwrap()
    );
}

#[test]
fn test_make() {
    let mut allocator = AllocEncoder::new();
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_make.hex").expect("read make test");
    let program_clvm = program.to_clvm(&mut allocator).expect("encode program");
    let args = [11, 22, 33, 44]
        .to_clvm(&mut allocator)
        .expect("encode args");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        args,
        0,
    )
    .expect("run make test")
    .1;
    let expected = ((11, 22), (((11, 22), (33, 44)), ([11, 22, 33, 44], ())))
        .to_clvm(&mut allocator)
        .expect("encode expected pair, tree, and list");
    assert_eq!(
        Node(result)
            .to_hex(&mut allocator)
            .expect("serialize result"),
        Node(expected)
            .to_hex(&mut allocator)
            .expect("serialize expected")
    );
}

/// Use the same compiler entry point/options as build.rs, including modern
/// optimization. Compile once per union, then run every example against it.
fn assert_dispatch(branches: &[String], examples: &[(String, usize)]) {
    use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
    use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
    use chialisp::classic::platform::argparse::ArgumentValue;
    use chialisp::compiler::{clvm::run, sexp::parse_sexp, srcloc::Srcloc};
    use std::{collections::HashMap, rc::Rc};

    let source = format!(
        "(include *standard-cl-23*) (import std.shapes)\n(export VALUE (if-shape VALUE {}))",
        branches.join(" ")
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
    let compiled = chialisp::compiler::compiler::compile_file(
        &mut allocator,
        Rc::new(DefaultProgramRunner::new()),
        parsed.opts,
        &source,
        &mut HashMap::new(),
    )
    .unwrap_or_else(|error| panic!("{source}\n{error:?}"));
    // An import/export source produces a module containing named components;
    // execute its program component, not its module/hash summary.
    let program = match compiled {
        chialisp::compiler::comptypes::CompilerOutput::Program(_, program) => Rc::new(program),
        chialisp::compiler::comptypes::CompilerOutput::Module(module) => module
            .components
            .iter()
            .find(|component| component.shortname == b"program")
            .expect("exported program")
            .content
            .clone(),
    };
    for (input, expected) in examples {
        let args = parse_sexp(Srcloc::start("shape-input"), input.bytes()).unwrap()[0].clone();
        let result = run(
            &mut allocator,
            Rc::new(DefaultProgramRunner::new()),
            Rc::new(HashMap::new()),
            program.clone(),
            args,
            None,
            Some(1_000_000),
        )
        .unwrap_or_else(|error| panic!("{source}\ninput {input}: {error:?}"));
        assert_eq!(
            result.to_string(),
            if *expected == 0 {
                "()".into()
            } else {
                expected.to_string()
            },
            "{source}\ninput {input}"
        );
    }
}

fn permutations(items: &[String]) -> Vec<Vec<String>> {
    if items.is_empty() {
        return vec![vec![]];
    }
    let mut result = vec![];
    for (index, item) in items.iter().enumerate() {
        let mut rest = items.to_vec();
        rest.remove(index);
        for mut tail in permutations(&rest) {
            tail.insert(0, item.clone());
            result.push(tail);
        }
    }
    result
}

#[test]
fn test_shapes_four_way_dispatch_in_every_order() {
    // Neither check isolates a single alternative. Both checks are necessary,
    // regardless of which one the planner chooses first.
    let branches = [
        "(((atom a) . (atom b)) (+ a b))",
        "(((a . b) . (atom c)) (+ a b c))",
        "(((atom a) . (b . c)) (+ a b c))",
        "(((a . b) . (c . d)) (+ a b c d))",
    ]
    .map(String::from);
    let examples = [
        ("(11 . 22)".into(), 33),
        ("((11 . 22) . 44)".into(), 77),
        ("(11 . (44 . 88))".into(), 143),
        ("((11 . 22) . (44 . 88))".into(), 165),
        // Nil is also an atom, including at both discriminator positions.
        ("(() . ())".into(), 0),
        ("((11 . 22) . ())".into(), 33),
        ("(() . (44 . 88))".into(), 132),
    ];
    for order in permutations(&branches) {
        assert_dispatch(&order, &examples);
    }
}

#[test]
fn test_shapes_eight_way_dispatch_needs_three_checks() {
    let mut branches = vec![];
    let mut examples = vec![];
    for bits in 0..8 {
        let mut patterns = vec![];
        let mut values = vec![];
        for position in 0..3 {
            if bits & (1 << position) == 0 {
                patterns.push(format!("(atom a{position})"));
                values.push("11");
            } else {
                patterns.push(format!("(a{position} . b{position})"));
                values.push("(22 . 33)");
            }
        }
        branches.push(format!(
            "(({} . ({} . {})) {})",
            patterns[0],
            patterns[1],
            patterns[2],
            bits + 1
        ));
        examples.push((
            format!("({} . ({} . {}))", values[0], values[1], values[2]),
            bits + 1,
        ));
    }
    // Every alternative appears first and last, in both forward and reverse order.
    for _ in 0..8 {
        assert_dispatch(&branches, &examples);
        let reverse = branches.iter().rev().cloned().collect::<Vec<_>>();
        assert_dispatch(&reverse, &examples);
        branches.rotate_left(1);
    }
}

#[test]
fn test_shapes_guard_nested_paths_in_every_order() {
    let branches = [
        "((atom a) 1)",
        "(((atom a) . b) 2)",
        "((((atom a) . b) . c) 3)",
        "(((((a . b) . c) . d) . e) 4)",
    ]
    .map(String::from);
    let examples = [
        ("()".into(), 1),
        ("11".into(), 1),
        ("(() . 22)".into(), 2),
        ("(11 . 22)".into(), 2),
        ("((11 . 22) . 33)".into(), 3),
        ("((((11 . 22) . 33) . 44) . 55)".into(), 4),
    ];
    for order in permutations(&branches) {
        assert_dispatch(&order, &examples);
    }
}

#[test]
fn test_shapes_nil_and_optional_subtrees_in_every_order() {
    let branches = [
        "((nil . (optional #(a b c))) 1)",
        "(((nil . a) . (optional #(b c d))) 2)",
        "((((a . b) . c) . (optional #(d e f))) 3)",
    ]
    .map(String::from);
    let mut examples = vec![];
    for tail in ["()", "99", "(44 . 55)", "(44 . (55 . 66))"] {
        examples.push((format!("(() . {tail})"), 1));
        examples.push((format!("((() . 11) . {tail})"), 2));
        examples.push((format!("(((11 . 22) . 33) . {tail})"), 3));
    }
    for order in permutations(&branches) {
        assert_dispatch(&order, &examples);
    }
}
