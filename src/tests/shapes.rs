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
        (
            "(defun-shape bad atom) (export () 0)",
            "reserved shape field name",
        ),
        (
            "(defun-shape bad (a . optional)) (export () 0)",
            "reserved shape field name",
        ),
        (
            "(defun-shape atom (a . b)) (export () 0)",
            "shape name cannot",
        ),
        (
            "(defun-shape optional (a . b)) (export () 0)",
            "shape name cannot",
        ),
        (
            "(defun-shape nil (a . b)) (export () 0)",
            "shape name cannot",
        ),
        (
            "(export () (make (atom)))",
            "atom takes exactly one",
        ),
        (
            "(export (a b) (make (atom a b)))",
            "atom takes exactly one",
        ),
        (
            "(export a (make (atom . a)))",
            "atom takes exactly one",
        ),
        (
            "(defun-shape bad (atom (a . b))) (export () 0)",
            "atom field must be a leaf",
        ),
        (
            "(defun-shape bad (atom nil)) (export () 0)",
            "atom field cannot",
        ),
        (
            "(defun-shape bad (atom atom)) (export () 0)",
            "atom field cannot",
        ),
        (
            "(export () (make (optional)))",
            "optional needs at least one",
        ),
        (
            "(export a (make (optional . a)))",
            "optional needs at least one",
        ),
        (
            "(export (a b) (make (optional a . b)))",
            "optional needs a proper list",
        ),
        (
            "(export a (make (optional (atom))))",
            "atom takes exactly one",
        ),
        (
            "(defun-shape leaf a) (export VALUE (if-shape VALUE ((leaf optional) 1)))",
            "reserved shape field name",
        ),
        (
            "(defun-shape leaf a) (export VALUE (if-shape VALUE ((leaf atom) 1)))",
            "reserved shape field name",
        ),
        (
            "(defun f a a) (export () (invoke f (atom)))",
            "atom takes exactly one",
        ),
        (
            "(export VALUE (if-shape VALUE (((a . a) . b) a)))",
            "field names must be unique",
        ),
        (
            "(export VALUE (if-shape VALUE (((atom) . b) 1)))",
            "atom takes exactly one",
        ),
        (
            "(export VALUE (if-shape VALUE ((atom a))))",
            "branch needs a template and one body",
        ),
        (
            "(export VALUE (if-shape VALUE ((atom a) 1 2)))",
            "branch needs a template and one body",
        ),
        (
            "(export VALUE (if-shape VALUE ((atom a) . 1)))",
            "branch needs a template and one body",
        ),
        (
            "(export VALUE (get-field (a . b) missing VALUE))",
            "unknown shape field",
        ),
        (
            "(export VALUE (get-field (a . a) a VALUE))",
            "field names must be unique",
        ),
        (
            "(export VALUE (get-field (a . nil) nil VALUE))",
            "get-field needs a non-reserved field name",
        ),
        (
            "(export VALUE (get-field (a . b) (a) VALUE))",
            "get-field needs a non-reserved field name",
        ),
        (
            "(export VALUE (get-field ((atom) . b) b VALUE))",
            "atom takes exactly one",
        ),
    ] {
        let source = format!("(include *standard-cl-26*)\n(import std.shapes)\n{body}");
        let opts = Rc::new(DefaultCompilerOpts::new("shape-errors.clsp"))
            .set_search_paths(&["clsp".to_string(), ".".to_string()]);
        let result = compile_file(
            &mut chialisp::clvmr::Allocator::new(),
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

fn shape_program_bytes(body: &str) -> Vec<u8> {
    use chialisp::classic::clvm::sexp::sexp_as_bin;
    use chialisp::compiler::clvm::convert_to_clvm_rs;

    let mut allocator = chialisp::clvmr::Allocator::new();
    let program = convert_to_clvm_rs(&mut allocator, compile_shape_program(body)).unwrap();
    sexp_as_bin(&mut allocator, program).raw()
}

fn shape_cost(program: &[u8], input: &str) -> (u64, Vec<u8>) {
    use chialisp::classic::clvm::sexp::sexp_as_bin;
    use chialisp::compiler::{clvm::convert_to_clvm_rs, sexp::parse_sexp, srcloc::Srcloc};

    let mut allocator = chialisp::clvmr::Allocator::new();
    let input = parse_sexp(Srcloc::start("input"), input.bytes()).unwrap()[0].clone();
    let input = convert_to_clvm_rs(&mut allocator, input).unwrap();
    let input = sexp_as_bin(&mut allocator, input).raw();
    let mut runtime = AllocEncoder::new();
    let allocator = runtime.allocator();
    let program = clvmr::serde::node_from_bytes(allocator, program).unwrap();
    let input = clvmr::serde::node_from_bytes(allocator, &input).unwrap();
    let result = run_program(allocator, &chia_dialect(), program, input, 1_000_000).unwrap();
    (
        result.0,
        clvmr::serde::node_to_bytes(allocator, result.1).unwrap(),
    )
}

#[test]
fn shape_dispatch_avoids_unneeded_bindings() {
    for (name, body, input, max_bytes, max_cost) in [
        ("four-way", "(if-shape VALUE (((atom a) . (atom b)) 1) (((a . b) . (atom c)) 2) (((atom a) . (b . c)) 3) (((a . b) . (c . d)) 4))", "((2 . 3) . (4 . 5))", 45, 386),
        ("four-way singleton splits", "(if-shape VALUE (#((a . x) (atom b) (atom c)) 1) (#((atom a) (b . y) (atom c)) 2) (#((atom a) (atom b) (c . z)) 3) (#((atom a) (atom b) (atom c)) 4))", "(4 . (4 . 4))", 45, 394),
        ("four-way bodies", "(if-shape VALUE (((atom a) . (atom b)) (+ a b)) (((a . b) . (atom c)) (+ a b c)) (((atom a) . (b . c)) (- a b c)) (((a . b) . (c . d)) (+ a b c d)))", "((2 . 3) . (4 . 5))", 83, 2131),
        ("two-way", "(if-shape VALUE (((a . b) . (atom c)) (+ a b c)) (((atom d) . (e . f)) (+ d e f)))", "((2 . 3) . 4)", 48, 1650),
        ("nil-pair", "(if-shape VALUE (nil 1) ((a . b) 2))", "(2 . 3)", 13, 118),
    ] {
        let program = shape_program_bytes(&format!("(export VALUE {body})"));
        let (cost, _) = shape_cost(&program, input);
        assert!(program.len() <= max_bytes, "{name}: {} bytes exceed {max_bytes}", program.len());
        assert!(cost <= max_cost, "{name}: cost {cost} exceeds {max_cost}");
    }
}

#[test]
fn shape_dispatch_balances_splits_reproducibly() {
    // The first position isolates one case. The other two each split 2:2.
    let body = "(export VALUE (if-shape VALUE
        (#((atom a) (atom b) (atom c)) 1)
        (#((a . x) (atom b) (c . z)) 2)
        (#((a . x) (b . y) (atom c)) 3)
        (#((a . x) (b . y) (c . z)) 4)))";
    let program = shape_program_bytes(body);
    assert_eq!(program, shape_program_bytes(body));
    for (input, expected) in [
        ("(1 . (2 . 3))", 1),
        ("((1 . 1) . (2 . (3 . 3)))", 2),
        ("((1 . 1) . ((2 . 2) . 3))", 3),
        ("((1 . 1) . ((2 . 2) . (3 . 3)))", 4),
    ] {
        let (cost, result) = shape_cost(&program, input);
        assert_eq!(result, [expected]);
        assert!(cost <= 427, "cost {cost} for {input}");
    }
}

#[test]
fn shape_dispatch_selects_the_cheaper_split_policy() {
    // b isolates the third case. Testing a first splits the same six cases 2:4.
    // Changing only the third body flips which tree has the cheaper mean.
    let inputs = [
        "((4 . (4 . 5)) . (4 . 4))",
        "(((4 . 5) . (4 . 5)) . ((4 . 5) . (4 . 5)))",
        "((4 . 4) . ((4 . 5) . 4))",
        "(((4 . 5) . (4 . 5)) . (4 . 4))",
        "((4 . (4 . 5)) . ((4 . 5) . (4 . 5)))",
        "((4 . (4 . 5)) . (4 . (4 . 5)))",
    ];
    for (third_body, third_result, max_total) in [("(+ a 3)", 7, 4378), ("3", 3, 3318)] {
        let program = shape_program_bytes(&format!(
            "(export VALUE (if-shape VALUE
                (#((atom a) (b . tb) (atom c) (atom d)) 1)
                (#((a . ta) (b . tb) (c . tc) (d . td)) 2)
                (#((atom a) (atom b) (c . tc) (atom d)) {third_body})
                (#((a . ta) (b . tb) (atom c) (atom d)) 4)
                (#((atom a) (b . tb) (c . tc) (d . td)) 5)
                (#((atom a) (b . tb) (atom c) (d . td)) 6)))"
        ));
        let mut total = 0;
        for (input, expected) in inputs.iter().zip([1, 2, third_result, 4, 5, 6]) {
            let (cost, result) = shape_cost(&program, input);
            assert_eq!(result, [expected]);
            total += cost;
        }
        assert!(total <= max_total, "{third_body}: total cost {total}");
    }
}

#[test]
fn shape_dispatch_fuses_three_safe_cases() {
    // Changing the third corner puts the singleton on opposite sides of the
    // first test. Some unselected arithmetic arms would read an atom as a pair.
    for (third_shape, third_input) in [
        ("((a . x) . (b . y))", "((5 . 6) . (7 . 8))"),
        ("((atom a) . (atom b))", "(5 . 7)"),
    ] {
        for (bodies, expected, max_bytes, max_total) in [
            (["(+ a 1)", "(+ b 2)", "(+ a b)"], [6, 9, 12], 59, 3713),
            (["1", "2", "3"], [1, 2, 3], 31, 792),
        ] {
            let [first, second, third] = bodies;
            let program = shape_program_bytes(&format!(
                "(export VALUE (if-shape VALUE
                    (((a . x) . (atom b)) {first})
                    (((atom a) . (b . y)) {second})
                    ({third_shape} {third})))"
            ));
            let mut total = 0;
            for (input, value) in ["((5 . 6) . 7)", "(5 . (7 . 8))", third_input]
                .iter()
                .zip(expected)
            {
                let (cost, result) = shape_cost(&program, input);
                assert_eq!(result, [value]);
                total += cost;
            }
            assert!(
                program.len() <= max_bytes,
                "{third_shape}: {} bytes",
                program.len()
            );
            assert!(total <= max_total, "{third_shape}: total cost {total}");
        }
    }
}

#[test]
fn shape_dispatch_keeps_guarded_or_costly_tests_lazy() {
    // The two literal leaves already share an eager selector. Speculating
    // their test on the arithmetic path would only add cost.
    let program = shape_program_bytes(
        "(export VALUE (if-shape VALUE
        (((atom a) . (atom b)) (+ a b))
        (((a . b) . (atom c)) 2)
        (((a . b) . (c . d)) 3)))",
    );
    for (input, expected, ceiling) in [
        ("(4 . 5)", 9, 1129),
        ("((4 . 5) . 6)", 2, 419),
        ("((4 . 5) . (6 . 7))", 3, 419),
    ] {
        let (cost, result) = shape_cost(&program, input);
        assert_eq!(result, [expected]);
        assert!(cost <= ceiling, "{input}: cost {cost}");
    }

    // Only the pair arm may inspect the left child. The atom input would
    // abort if the second test were evaluated eagerly.
    assert_shape_program(
        "(export VALUE (if-shape VALUE
            ((atom v) (+ v 1))
            (((atom x) . y) (+ x 2))
            (((x . z) . y) (+ z 3))))",
        &[
            ("4".into(), 5),
            ("(5 . 7)".into(), 7),
            ("((5 . 6) . 7)".into(), 9),
        ],
    );

    // On (9 . 99) both halves exist. A later test in the nested selector
    // would descend into 9, so the selector must stay inside its guard.
    assert_shape_program(
        "(export V (if-shape V
            (((atom a) . tail) (+ a 1))
            (((x . tail) . (atom b)) (+ b 2))
            ((((atom a) . tail) . (b . y)) (+ a 3))
            ((((a . x) . tail) . (b . y)) (+ x 4))))",
        &[
            ("(9 . 99)".into(), 10),
            ("((3 . 4) . 5)".into(), 7),
            ("((3 . 4) . (5 . 6))".into(), 6),
            ("(((1 . 5) . 4) . (5 . 6))".into(), 9),
        ],
    );
}

#[test]
fn shape_dispatch_declines_costly_three_way_fusion() {
    // Both predicates are safe, but fifty edges down. The flat selector
    // costs 5665 over these inputs, eight more than the nested tree.
    let fields = (0..49)
        .map(|i| format!("pad{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    let prefix = "0 ".repeat(49);
    let program = shape_program_bytes(&format!(
        "(export VALUE (if-shape VALUE
            (({fields} . ((a . x) . (atom b))) (+ a 1))
            (({fields} . ((atom a) . (b . y))) (+ b 2))
            (({fields} . ((atom a) . (atom b))) (+ a b))))"
    ));
    let mut total = 0;
    for (tail, expected) in [("((5 . 6) . 7)", 6), ("(5 . (7 . 8))", 9), ("(5 . 7)", 12)] {
        let (cost, result) = shape_cost(&program, &format!("({prefix}. {tail})"));
        assert_eq!(result, [expected]);
        total += cost;
    }
    assert!(total <= 5657, "total cost {total}");
}

#[test]
fn shape_dispatch_keeps_a_deep_repeated_test_lazy() {
    // The second test is twelve edges down. Repeating it for eager fusion
    // costs 474 per input. The lazy outer split reads the path once for 463.
    let mut branches = Vec::new();
    let mut inputs = Vec::new();
    for (left, left_value) in [("(atom a)", "1"), ("(a . x)", "(1 . 2)")] {
        for (right, right_value) in [("(atom b)", "3"), ("(b . y)", "(3 . 4)")] {
            let mut tail = right.to_owned();
            let mut value = right_value.to_owned();
            for depth in 1..12 {
                tail = format!("(pad{depth} . {tail})");
                value = format!("(0 . {value})");
            }
            branches.push(format!("(({left} . {tail}) {})", branches.len() + 1));
            inputs.push(format!("({left_value} . {value})"));
        }
    }
    let program = shape_program_bytes(&format!(
        "(export VALUE (if-shape VALUE {}))",
        branches.join(" ")
    ));
    for (input, expected) in inputs.iter().zip(1u8..) {
        let (cost, result) = shape_cost(&program, input);
        assert_eq!(result, [expected]);
        assert!(cost <= 463, "{input}: cost {cost}");
    }
}

#[test]
fn shape_dispatch_fields_can_shadow_a_function_argument() {
    let cases = "(if-shape value
        ((item) (+ value tail shapes-value))
        ((atom value) value))";
    let shape = "(defun-shape item ((atom value) . tail))";
    let examples = [("((11 . 22) 100)".into(), 133), ("(44 100)".into(), 44)];
    assert_shape_program(
        &format!(
            "{shape} (defun pick (value shapes-value) {cases}) (export args (pick &rest args))"
        ),
        &examples,
    );
    // Chialisp 0.7.0 needs distinct field names directly in a module export.
    assert_shape_program(
        &format!(
            "{shape} (export (value shapes-value)
                (if-shape value
                    ((item item-value tail) (+ item-value tail shapes-value))
                    ((atom leaf) leaf)))"
        ),
        &examples,
    );
}

#[test]
fn shape_dispatch_keeps_variable_reads_lazy() {
    // Reading the outer variable right would abort on a nil input.
    assert_shape_program(
        "(export (@ VALUE (left . right)) (if-shape VALUE (nil 7) ((a . b) right)))",
        &[("()".into(), 7), ("(3 . 4)".into(), 4)],
    );
}

/// Use the same compiler entry point/options as build.rs, including modern
/// optimization. Compile once per union, then run every example against it.
fn assert_dispatch(branches: &[String], examples: &[(String, usize)]) {
    assert_shape_program(
        &format!("(export VALUE (if-shape VALUE {}))", branches.join(" ")),
        examples,
    );
}

fn compile_shape_program(body: &str) -> std::rc::Rc<chialisp::compiler::sexp::SExp> {
    use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
    use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
    use chialisp::classic::platform::argparse::ArgumentValue;
    use std::{collections::HashMap, rc::Rc};
    let source = format!("(include *standard-cl-26*) (import std.shapes) {body}");
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
    let mut allocator = chialisp::clvmr::Allocator::new();
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
    match compiled {
        chialisp::compiler::comptypes::CompilerOutput::Program(_, program) => Rc::new(program),
        chialisp::compiler::comptypes::CompilerOutput::Module(module) => module
            .components
            .iter()
            .find(|component| component.shortname == b"program")
            .expect("exported program")
            .content
            .clone(),
    }
}

fn assert_shape_program(body: &str, examples: &[(String, usize)]) {
    use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
    use chialisp::compiler::{clvm::run, sexp::parse_sexp, srcloc::Srcloc};
    use std::{collections::HashMap, rc::Rc};

    let program = compile_shape_program(body);
    let mut allocator = chialisp::clvmr::Allocator::new();
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
        .unwrap_or_else(|error| panic!("{body}\ninput {input}: {error:?}"));
        assert_eq!(
            result.to_string(),
            if *expected == 0 {
                "()".into()
            } else {
                expected.to_string()
            },
            "{body}\ninput {input}"
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
        let program = shape_program_bytes(&format!(
            "(export VALUE (if-shape VALUE {}))",
            branches.join(" ")
        ));
        assert!(program.len() <= 111, "{} bytes", program.len());
        for (input, expected) in &examples {
            let (cost, result) = shape_cost(&program, input);
            assert_eq!(result, [*expected as u8]);
            assert!(cost <= 675, "{input}: cost {cost}");
        }
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

#[test]
fn test_shapes_make_allows_annotation_names_as_values() {
    assert_shape_program(
        "(defun-shape single value)
         (defun-shape annotated ((atom a) . (optional b)))
         (defun add (a . b) (+ a b))
         (export (atom optional)
             (+ (make atom) (make optional)
                (make (single atom)) (make (single optional))
                (invoke add (annotated atom optional))
                (make (atom nil))))",
        &[("(11 22)".into(), 99)],
    );
}

#[test]
fn test_shapes_get_field_named_inline_and_optional() {
    for (template, field, input, expected) in [
        ("(record)", "a", "((11 . 22) . 33)", 11),
        ("(record)", "b", "((11 . 22) . 33)", 22),
        ("(record)", "c", "((11 . 22) . 33)", 33),
        ("(record x y z)", "y", "((11 . 22) . 33)", 22),
        ("((a . b) . c)", "b", "((11 . 22) . 33)", 22),
        ("#(a b c)", "b", "(11 . (22 . 33))", 22),
        ("(a . (optional (b . c)))", "c", "(11 . (22 . 33))", 33),
        ("((atom a) . (optional (b . c)))", "a", "(11 . ())", 11),
        ("a", "a", "44", 44),
    ] {
        assert_shape_program(
            &format!(
                "(defun-shape record ((a . b) . c))
                      (export VALUE (get-field {template} {field} VALUE))"
            ),
            &[(input.into(), expected)],
        );
    }
}

#[test]
fn test_shapes_nil_before_deeper_alternatives_in_every_order() {
    let branches = ["(nil 1)", "(((atom a) . b) 2)", "(((a . b) . c) 3)"].map(String::from);
    let examples = [
        ("()".into(), 1),
        ("(11 . 22)".into(), 2),
        ("(() . 22)".into(), 2),
        ("((11 . 22) . 33)".into(), 3),
    ];
    for order in permutations(&branches) {
        assert_dispatch(&order, &examples);
    }
}
