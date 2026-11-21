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
    assert_shape_program(
        &format!("(export VALUE (if-shape VALUE {}))", branches.join(" ")),
        examples,
    );
}

fn assert_shape_program(body: &str, examples: &[(String, usize)]) {
    use chialisp::classic::clvm_tools::comp_input::RunAndCompileInputData;
    use chialisp::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
    use chialisp::classic::platform::argparse::ArgumentValue;
    use chialisp::compiler::{clvm::run, sexp::parse_sexp, srcloc::Srcloc};
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

// Rotations put each branch in every position; reversals also exercise the
// opposite relative order without compiling every factorial permutation.
fn representative_order(branches: &[String], order: usize) -> Vec<String> {
    assert!(order < branches.len() * 2);
    let mut result = branches.to_vec();
    result.rotate_left(order % branches.len());
    if order >= branches.len() {
        result.reverse();
    }
    result
}

macro_rules! dispatch_order_tests {
    ($case:ident; $($name:ident = $order:expr),+ $(,)?) => {
        $(
            #[test]
            fn $name() {
                $case($order);
            }
        )+
    };
}

fn four_way_dispatch(order: usize) {
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
    assert_dispatch(&representative_order(&branches, order), &examples);
}

dispatch_order_tests!(four_way_dispatch;
    four_way_0 = 0, four_way_1 = 1, four_way_2 = 2, four_way_3 = 3,
    four_way_reverse_0 = 4, four_way_reverse_1 = 5,
    four_way_reverse_2 = 6, four_way_reverse_3 = 7,
);

fn eight_way_dispatch(order: usize) {
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
    assert_dispatch(&representative_order(&branches, order), &examples);
}

dispatch_order_tests!(eight_way_dispatch;
    eight_way_0 = 0, eight_way_1 = 1, eight_way_2 = 2, eight_way_3 = 3,
    eight_way_4 = 4, eight_way_5 = 5, eight_way_6 = 6, eight_way_7 = 7,
    eight_way_reverse_0 = 8, eight_way_reverse_1 = 9,
    eight_way_reverse_2 = 10, eight_way_reverse_3 = 11,
    eight_way_reverse_4 = 12, eight_way_reverse_5 = 13,
    eight_way_reverse_6 = 14, eight_way_reverse_7 = 15,
);

fn guard_nested_paths(order: usize) {
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
    assert_dispatch(&representative_order(&branches, order), &examples);
}

dispatch_order_tests!(guard_nested_paths;
    guard_nested_0 = 0, guard_nested_1 = 1,
    guard_nested_2 = 2, guard_nested_3 = 3,
    guard_nested_reverse_0 = 4, guard_nested_reverse_1 = 5,
    guard_nested_reverse_2 = 6, guard_nested_reverse_3 = 7,
);

fn nil_and_optional_subtrees(order: usize) {
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
    assert_dispatch(&representative_order(&branches, order), &examples);
}

dispatch_order_tests!(nil_and_optional_subtrees;
    nil_optional_0 = 0, nil_optional_1 = 1, nil_optional_2 = 2,
    nil_optional_reverse_0 = 3, nil_optional_reverse_1 = 4, nil_optional_reverse_2 = 5,
);

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

fn nil_before_deeper_alternatives(order: usize) {
    let branches = ["(nil 1)", "(((atom a) . b) 2)", "(((a . b) . c) 3)"].map(String::from);
    let examples = [
        ("()".into(), 1),
        ("(11 . 22)".into(), 2),
        ("(() . 22)".into(), 2),
        ("((11 . 22) . 33)".into(), 3),
    ];
    assert_dispatch(&representative_order(&branches, order), &examples);
}

dispatch_order_tests!(nil_before_deeper_alternatives;
    nil_deeper_0 = 0, nil_deeper_1 = 1, nil_deeper_2 = 2,
    nil_deeper_reverse_0 = 3, nil_deeper_reverse_1 = 4, nil_deeper_reverse_2 = 5,
);
