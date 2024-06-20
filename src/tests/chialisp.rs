use std::rc::Rc;

use clvmr::run_program;
use clvm_traits::ToClvm;

use crate::common::types::{AllocEncoder, Node, Sha256Input};
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::chia_dialect;

use clvm_tools_rs::classic::clvm::sexp::first;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use clvm_tools_rs::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;

use clvm_tools_rs::compiler::clvm::{convert_from_clvm_rs, run};
use clvm_tools_rs::compiler::compiler::DefaultCompilerOpts;
use clvm_tools_rs::compiler::comptypes::CompilerOpts;
use clvm_tools_rs::compiler::srcloc::Srcloc;

#[test]
fn test_prepend_count() {
    let mut allocator = AllocEncoder::new();
    let source_data =
        ("prepend_count",
         ([
             (6, (2, ())),
             (6, (3, ())),
             (5, (3, ())),
             (5, (4, ())),
             (5, (1, ())),
             (2, (1, ())),
             (3, (1, ()))
         ], ())
        ).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "((a 6 2) (a 6 3) (i 5 3) (i 5 4) (i 5 1) (q 2 1) (q 3 1))"
    );
}

#[test]
fn test_make_cards() {
    let mut allocator = AllocEncoder::new();
    let loc = Srcloc::start("game_handler");
    let opts = Rc::new(DefaultCompilerOpts::new("game_handler"));

    let program = read_hex_puzzle(&mut allocator, "resources/test_make_cards.hex").expect("should read").to_nodeptr();
    let converted_program = convert_from_clvm_rs(allocator.allocator(), loc.clone(), program).expect("should work");
    let source_data =
        [Sha256Input::Bytes(b"test").hash()]
        .to_clvm(&mut allocator).expect("should build");
    let converted_source = convert_from_clvm_rs(allocator.allocator(), loc.clone(), source_data).expect("should work");
    let runner = Rc::new(DefaultProgramRunner::new());
    let result = run(
        allocator.allocator(),
        Rc::new(DefaultProgramRunner::new()),
        opts.prim_map(),
        converted_program,
        converted_source,
        None,
        None,
    ).expect("should run");
    assert_eq!(
        result.to_string(),
        "((5 22 23 25 27 31 32 35) (() 6 7 20 44 45 47 51))"
    );
}

#[test]
fn test_mergein() {
    let mut allocator = AllocEncoder::new();
    let tests = vec![
        ([vec![1,2,9], vec![], vec![]],
         "(q 2 9)"
        ),
        ([vec![1,2,9], vec![3], vec![]],
         "(q 2 5 9)"
        )
    ];
    let program = read_hex_puzzle(&mut allocator, "resources/test_mergein.hex").expect("should read");
    for t in tests.iter() {
        let clvm_arg = t.0.to_clvm(&mut allocator).expect("should build");
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            program.to_nodeptr(),
            clvm_arg,
            0
        ).expect("should run").1;
        assert_eq!(
            disassemble(allocator.allocator(), result, None),
            t.1
        );
    }
}

#[test]
fn test_pull_indices() {
    let mut allocator = AllocEncoder::new();
    let source_data =
        ("pull_indices",
         ([1, 4, 5],
          ([
              (6, (2, ())),
              (6, (3, ())),
              (5, (3, ())),
              (5, (4, ())),
              (5, (1, ())),
              (2, (1, ())),
              (3, (1, ()))
          ], ()))
        ).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "((r 3) (f 1) (a 1))"
    );
}

#[test]
fn test_pull_out_straight() {
    let mut allocator = AllocEncoder::new();
    let source_data_ace =
        ("pull_out_straight",
         (5,
          ([
              [14, 1, 4],
              [5, 2, 0],
              [4, 3, 1],
              [3, 3, 2],
              [2, 4, 3]
          ], ()))
        ).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data_ace,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "(() 1 2 3)",
    );
}

#[test]
fn test_find_straight_high() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace =
        ("find_straight_high",
         (1,
          (0,
           (0,
            ([
                [14, 2, 0],
                [5, 2, 1],
                [4, 2, 2],
                [3, 2, 3],
                [2, 2, 4],
            ], ())
           )
          )
         )
        ).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data_ace,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "5",
    );
}

#[test]
fn test_straight_indices() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace =
        ("straight_indices",
         ([
             [14, 1, 0],
             [5, 2, 1],
             [4, 3, 2],
             [3, 3, 3],
             [2, 4, 4],
             [2, 1, 5],
         ], ())
        ).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data_ace,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "(() 1 2 3 4)",
    );
}

#[test]
fn test_handcalc() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let examples =
        [
            (
                "()",
                vec!["smoke test"],
                vec![
                    (12, 1),
                    (11, 1),
                    (14, 1),
                    (13, 1),
                    (10, 1),
                    (9, 1)
                ],
                vec![
                    (12, 1),
                    (11, 1),
                    (14, 1),
                    (13, 1),
                    (10, 1),
                    (0, 1)
                ]
            ),
            (
                "()",
                vec!["test from calpoker smoke test 1"],
                vec![
                    (12, 2),
                    (10, 1),
                    (4, 3),
                    (2, 1),
                    (7, 4),
                    (6, 3),
                    (4, 2),
                    (2, 3)
                ],
                vec![
                    (12, 2),
                    (10, 1),
                    (4, 3),
                    (2, 1),
                    (7, 4),
                    (6, 3),
                    (4, 2),
                    (2, 3)
                ],
            ),
            (
                "()",
                vec![ "straight flushes of different suits tie",
                   "A1 K1 Q1 J1 T1 = A2 K2 Q2 J2 T2"
                ],
                vec![
                    (14, 1),
                    (13, 1),
                    (12, 1),
                    (11, 1),
                    (10, 1)
                ],
                vec![
                    (14, 2),
                    (13, 2),
                    (12, 2),
                    (11, 2),
                    (10, 2)
                ]
            ),
            (
                "1",
                vec![ "higher straight flush beats lower straight flush",
                   "A1 K1 Q1 J1 T1 > 61 51 41 31 21"
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (11, 1), (10, 1)
                ],
                vec![
                    (6, 1), (5, 1), (4, 1), (3, 1), (2, 1)
                ]
            ),
            (
                "()",
                vec!["A1 K1 Q1 J1 T1 91 = A1 K1 Q1 J1 T1"],
                vec![
                    (12, 1), (11, 1), (14, 1), (13, 1), (10, 1), (9, 1)
                ],
                vec![
                    (14, 2), (11, 2), (10, 2), (13, 2), (12, 2)
                ]
            ),
            (
                "1",
                vec![ "lower (2-6) straight flush beats ace to four straight flush",
                   "61 51 41 31 21 > A2 52 42 32 22"
                ],
                vec![
                    (6, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ],
                vec![
                    (14, 2), (5, 2), (4, 2), (3, 2), (2, 2),
                ]

            ),
            (
                "()",
                vec!["A1 61 51 41 31 21 = 61 51 41 31 21"],
                vec![
                    (14, 1), (6, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ],
                vec![
                    (6, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ]
            ),
            (
                "()",
                vec!["ace to four straight flush with higher kicker ties",
                 "A2 52 42 32 22 61 = A1 51 41 31 21 71"],
                vec![
                    (14, 2), (5, 2), (4, 2), (3, 2), (2, 2), (6, 1),
                ],
                vec![
                    (14, 1), (5, 1), (4, 1), (3, 1), (2, 1), (7, 1)
                ]
            ),
            (
                "()",
                vec!["ace to four straight flushes of different suits tie",
                     "A1 51 41 31 21 = A2 52 42 32 22"
                ],
                vec![
                    (14, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ],
                vec![
                    (14, 2), (5, 2), (4, 2), (3, 2), (2, 2),
                ]

            ),
            (
                "1",
                vec!["ace to four straight flush beats four of a kind",
                     "A1 51 41 31 21 > K1 K2 K3 K4 J1"],
                vec![
                    (14, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (11, 1)
                ]
            ),
            (
                "()",
                vec!["A1 A2 A3 A4 51 41 31 21 = A1 51 41 31 21"],
                vec![
                    (14, 1), (14, 2), (14, 3), (5, 1), (4, 1), (3, 1), (2, 1),
                ],
                vec![
                    (14, 1), (5, 1), (4, 1), (3, 1), (2, 1),
                ]
            ),
            (
                "1",
                vec!["four of a kind with higher kicker wins",
                     "K1 K2 K3 K4 Q1 > K1 K2 K3 K4 J1"],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (12, 1),
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (11, 1),
                ]
            ),
            (
                "()",
                vec!["K1 K2 K3 K4 T1 91 = K1 K2 K3 K4 T1"],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (10, 1), (9, 1),
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (10, 1)
                ]
            ),
            (
                "()",
                vec!["four of a kind with higher second kicker ties",
                     "K1 K2 K3 K4 Q1 J1 = K1 K2 K3 K4 Q1 T1"
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (12, 1), (11, 1),
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (12, 1), (10, 1),
                ]
            ),
            (
                "1",
                vec!["higher four of a kind beats lower four of a kind",
                     "K1 K2 K3 K4 21 > 31 32 33 34 A1"
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (2, 1),
                ],
                vec![
                    (3, 1), (3, 2), (3, 3), (3, 4), (14, 1),
                ]
            ),
            (
                "()",
                vec!["K1 K2 K3 K4 31 32 33 34 = K1 K2 K3 K4 32"],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (3, 1), (3, 2), (3, 3), (3, 4),
                ],
                vec![
                    (13, 1), (13, 2), (13, 3), (13, 4), (3, 2),
                ]
            ),
            (
                "1",
                vec!["four of a kind beats full house",
                     "21 22 23 24 31 > A1 A2 A3 K1 K2"
                ],
                vec![
                    (2, 1), (2, 2), (2, 3), (2, 4), (3, 1),
                ],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (13, 2),
                ]
            ),
            (
                "()",
                vec!["four of a kind equality: 21 22 23 24 A1 A2 A3 = 21 22 23 24 A2"],
                vec![
                    (2, 1), (2, 2), (2, 3), (2, 4), (14, 1), (14, 2), (14, 3),
                ],
                vec![
                    (2, 1), (2, 2), (2, 3), (2, 4), (14, 2),
                ],
            ),
            (
                "1",
                vec![
                    "full house with higher set wins",
                    "51 52 53 21 22 > 31 32 33 71 72",
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (2, 1), (2, 2),
                ],
                vec![
                    (3, 1), (3, 2), (3, 3), (7, 1), (7, 2),
                ]
            ),
            (
                "()",
                vec!["A1 A2 A3 K1 K2 K3 = A1 A2 A3 K1 K2"],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (13, 2), (13, 3),
                ],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (13, 2),
                ]
            ),
            (
                "1",
                vec![
                    "full house with same set and higher pair wins",
                    "51 52 53 41 42 > 51 52 53 31 32",
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2),
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (3, 1), (3, 2),
                ]
            ),
            (
                "()",
                vec![
                    "A1 A2 A3 K1 K2 51 52 = A1 A2 A3 K1 K2",
                ],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (13, 2), (5, 1), (5, 2),
                ],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (13, 2),
                ],
            ),
            (
                "()",
                vec![
                    "full house ties with two sets",
                    "51 52 53 41 42 A1 = 51 52 53 41 42 43"
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2), (14, 1),
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2), (4, 3),
                ]
            ),
            (
                "1",
                vec![
                    "full house beats flush",
                    "51 52 53 41 42 > A1 Q1 T1 81 71",
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2),
                ],
                vec![
                    (14, 1), (12, 1), (10, 1), (8, 1), (7, 1),
                ]
            ),
            (
                "()",
                vec!["51 52 53 41 42 A1 K1 Q1 = 51 52 53 41 42"],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2), (14, 1), (13, 1), (12, 1),
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (4, 1), (4, 2),
                ]
            ),
            (
                "1",
                vec![
                    "higher flush beats lower flush",
                    "A1 61 51 41 31 > K1 Q1 J1 T1 81",
                ],
                vec![
                    (14, 1), (6, 1), (5, 1), (4, 1), (3, 1),
                ],
                vec![
                    (13, 1), (12, 2), (11, 1), (10, 1), (8, 1),
                ]
            ),
            (
                "()",
                vec!["A1 K1 Q1 J1 81 71 = A1 K1 Q1 J1 81"],
                vec![
                    (14, 1), (13, 1), (12, 1), (11, 1), (8, 1), (7, 1),
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (11, 1), (8, 1),
                ]
            ),
            (
                "1",
                vec![
                    "flush with higher second card wins",
                    "A1 K1 51 41 31 > A1 Q1 J1 T1 91",
                ],
                vec![
                    (14, 1), (13, 1), (5, 1), (4, 1), (3, 1),
                ],
                vec![
                    (14, 1), (12, 2), (11, 1), (10, 1), (9, 1),
                ],
            ),
            (
                "1",
                vec![
                    "flush with higher third card wins",
                    "A1 K1 Q1 41 31 > A1 K1 J1 T1 91",
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (4, 1), (3, 1),
                ],
                vec![
                    (14, 1), (13, 1), (11, 1), (10, 1), (9, 1),
                ]
            ),
            (
                "1",
                vec![
                    "flush with higher fourth card wins",
                    "A1 K1 Q1 T1 21 > A1 K1 Q1 91 81",
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (10, 1), (2, 1),
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (9, 1), (8, 1),
                ]
            ),
            (
                "1",
                vec![
                    "flush with higher fifth card wins",
                    "A1 K1 Q1 T1 81 > A1 K1 Q1 T1 71",
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (10, 1), (8, 1),
                ],
                vec![
                    (14, 1), (13, 1), (12, 1), (10, 1), (7, 1),
                ]
            ),
            (
                "()",
                vec![
                    "flushes of different suits tie",
                    "A1 K1 J1 T1 81 = A2 K2 J2 T2 82"
                ],
                vec![
                    (14, 1), (13, 1), (11, 1), (10, 1), (8, 1),
                ],
                vec![
                    (14, 2), (13, 2), (11, 2), (10, 2), (8, 2),
                ]
            ),
            (
                "()",
                vec![
                    "same flush with higher sixth card ties",
                    "A1 K1 J1 T1 81 71 = A1 K1 J1 T1 81 61",
                ],
                vec![
                    (14, 1), (13, 1), (11, 1), (10, 1), (8, 1), (7, 1),
                ],
                vec![
                    (14, 1), (13, 1), (11, 1), (10, 1), (8, 1), (6, 1),
                ]
            ),
            (
                "1",
                vec![
                    "flush beats straight",
                    "71 61 51 41 21 > A1 K2 Q3 J4 T1",
                ],
                vec![
                    (7, 1), (6, 1), (5, 1), (4, 1), (2, 1),
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1),
                ]
            ),
            (
                "()",
                vec![
                    "A1 K2 Q3 J4 T1 81 71 61 = A1 T1 81 71 61",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (8, 1), (7, 1), (6, 1),
                ],
                vec![
                    (14, 1), (10, 1), (8, 1), (7, 1), (6, 1),
                ]
            ),
            (
                "()",
                vec![
                    "straight with higher kicker ties",
                    "A1 K2 Q3 J4 T1 92 = A1 K2 Q3 J4 T1 22",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (9, 2),
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (2, 2),
                ]
            ),
            (
                "()",
                vec![
                    "straights of different suits tie",
                    "A1 K2 Q3 J4 T1 = A2 K3 Q4 J1 T2",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1),
                ],
                vec![
                    (14, 2), (13, 3), (12, 4), (11, 1), (10, 2),
                ]
            ),
            (
                "1",
                vec![
                    "higher straight beats lower straight",
                    "A1 K2 Q3 J4 T1 > 61 52 43 34 21",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1),
                ],
                vec![
                    (6, 1), (5, 2), (4, 3), (3, 4), (2, 1),
                ]
            ),
            (
                "()",
                vec!["A1 K2 Q3 J4 T1 92 83 = A1 K2 Q3 J4 T1"],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (9, 2), (8, 3),
                ],
                vec![
                    (14, 2), (13, 3), (12, 4), (11, 1), (10, 2),
                ]
            ),
            (
                "1",
                vec![
                    "lower (2-6) straight beats ace to four straight",
                    "61 52 43 34 21 > A1 52 43 34 21",
                ],
                vec![
                    (6, 1), (5, 2), (4, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 4), (2, 1),
                ]
            ),
            (
                "()",
                vec!["A1 62 53 44 31 22 = 62 53 44 31 22"],
                vec![
                    (14, 1), (6, 2), (5, 3), (4, 4), (3, 1), (2, 2),
                ],
                vec![
                    (6, 2), (5, 3), (4, 4), (3, 1), (2, 2),
                ]
            ),
            (
                "()",
                vec![
                    "ace to four straight with higher kicker ties",
                    "A1 52 43 34 21 K2 = A1 52 43 34 21 72",
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 4), (2, 1), (13, 2),
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 4), (2, 1), (7, 2),
                ]
            ),
            (
                "()",
                vec![
                    "ace to fours of different suits tie",
                    "A1 52 43 34 21 = A2 53 44 31 22",
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 2), (5, 3), (4, 4), (3, 1), (2, 2),
                ]
            ),
            (
                "1",
                vec![
                    "ace to four straight beats set",
                    "A1 52 43 34 21 > A1 A2 A3 K1 Q2"
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 1), (14, 2), (14, 3), (13, 1), (12, 2),
                ]
            ),
            (
                "()",
                vec!["A1 A2 A3 52 43 34 21 = A1 52 43 34 21"],
                vec![
                    (14, 1), (14, 2), (14, 3), (5, 2), (4, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 1), (5, 2), (4, 3), (3, 2), (2, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher set wins",
                    "71 72 73 34 21 > 51 52 53 A4 K1",
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (3, 4), (2, 1),
                ],
                vec![
                    (5, 1), (5, 2), (5, 3), (14, 4), (13, 1),
                ]
            ),
            (
                "1",
                vec![
                    "set with higher first kicker wins",
                    "71 72 73 A1 22 > 71 72 73 K1 Q2",
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (2, 2),
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (13, 1), (12, 2),
                ]
            ),
            (
                "()",
                vec!["71 72 73 A1 K2 J3 54 43 = 71 72 73 A1 K2"],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (13, 2), (11, 3), (5, 4), (4, 3),
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (13, 2),
                ]
            ),
            (
                "1",
                vec![
                    "set with higher second kicker wins",
                    "71 72 73 A1 K2 > 71 72 73 A1 Q2",
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (13, 2),
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (12, 2),
                ]
            ),
            (
                "()",
                vec![
                    "set with higher third kicker ties",
                    "71 72 73 A1 K2 Q3 = 71 72 73 A1 K2 J3",
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (13, 2), (12, 3),
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (14, 1), (13, 2), (11, 3),
                ]
            ),
            (
                "1",
                vec![
                    "set beats two pair",
                    "71 72 73 34 21 > A1 A2 K3 K4 Q1",
                ],
                vec![
                    (7, 1), (7, 2), (7, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 1), (14, 2), (13, 3), (13, 4), (12, 1),
                ],
            ),
            (
                "1",
                vec![
                    "two pair with higher high pair wins",
                    "K1 K2 33 34 21 > Q1 Q2 J3 J4 A1",
                ],
                vec![
                    (13, 1), (13, 2), (3, 3), (3, 4), (2, 1),
                ],
                vec![
                    (12, 1), (12, 2), (11, 3), (11, 4), (14, 1),
                ]
            ),
            (
                "()",
                vec!["A1 A2 K1 K2 J1 J2 = A1 A2 K1 K2 J3"],
                vec![
                    (14, 1), (14, 2), (13, 1), (13, 2), (11, 1), (11, 2),
                ],
                vec![
                    (14, 1), (14, 2), (13, 1), (13, 2), (11, 3),
                ]
            ),
            (
                "1",
                vec![
                    "two pair with tied higher pair and higher lower pair wins",
                    "K1 K2 71 72 23 > K1 K2 63 64 A1",
                ],
                vec![
                    (13, 1), (13, 2), (7, 1), (7, 2), (2, 3),
                ],
                vec![
                    (13, 1), (13, 2), (6, 3), (6, 4), (14, 1),
                ]
            ),
            (
                "1",
                vec![
                    "two pair with higher kicker wins",
                    "K1 K2 Q3 Q4 J1 > K1 K2 Q3 Q4 T1",
                ],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (11, 1),
                ],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (10, 1),
                ]
            ),
            (
                "()",
                vec!["K1 K2 Q3 Q4 A1 T1 92 63 = K1 K2 Q3 Q4 A1"],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (14, 1), (10, 1), (9, 2), (6, 3),
                ],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (14, 1),
                ]
            ),
            (
                "()",
                vec![
                    "two pair with higher second kicker ties",
                    "K1 K2 Q3 Q4 J1 T2 = K1 K2 Q3 Q4 J1 92",
                ],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (11, 1), (10, 2),
                ],
                vec![
                    (13, 1), (13, 2), (12, 3), (12, 4), (11, 1), (9, 2),
                ]
            ),
            (
                "1",
                vec![
                    "two pair beats pair",
                    "41 42 33 34 21 > A1 A2 K3 Q4 J1",
                ],
                vec![
                    (4, 1), (4, 2), (3, 3), (3, 4), (2, 1),
                ],
                vec![
                    (14, 1), (14, 2), (13, 3), (12, 4), (11, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher pair wins",
                    "71 72 53 44 31 > 61 62 A3 K4 Q1",
                ],
                vec![
                    (7, 1), (7, 2), (5, 3), (4, 4), (3, 1),
                ],
                vec![
                    (6, 1), (6, 2), (14, 3), (13, 4), (12, 1),
                ],
            ),
            (
                "1",
                vec![
                    "tied pair with higher first kicker wins",
                    "91 92 A3 34 21 > 91 92 K3 Q4 J1",
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (3, 4), (2, 1),
                ],
                vec![
                    (9, 1), (9, 2), (13, 3), (12, 4), (11, 1),
                ]
            ),
            (
                "()",
                vec![
                    "21 22 A1 Q2 J3 94 81 = 21 22 A1 Q2 J3",
                ],
                vec![
                    (2, 1), (2, 2), (14, 1), (12, 2), (11, 3), (9, 4), (8, 1),
                ],
                vec![
                    (2, 1), (2, 2), (14, 1), (12, 2), (11, 3),
                ]
            ),
            (
                "1",
                vec![
                    "tied pair with higher second kicker wins",
                    "91 92 A3 K4 21 > 91 92 A3 Q4 J1",
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (13, 4), (2, 1),
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (12, 4), (11, 1),
                ]
            ),
            (
                "1",
                vec![
                    "tied pair with higher third kicker wins",
                    "91 92 A3 K4 Q1 > 91 92 A3 K4 J1",
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (13, 4), (12, 1),
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (13, 4), (11, 1),
                ]
            ),
            (
                "()",
                vec![
                    "tied pair with higher fourth kicker ties",
                    "91 92 A3 K4 Q1 J2 = 91 92 A3 K4 Q1 T2",
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (13, 4), (12, 1), (11, 2),
                ],
                vec![
                    (9, 1), (9, 2), (14, 3), (13, 4), (12, 1), (10, 2),
                ]
            ),
            (
                "1",
                vec![
                    "pair beats high card",
                    "21 22 33 44 51 > A1 Q2 J3 T4 91",
                ],
                vec![
                    (2, 1), (2, 2), (3, 3), (4, 4), (5, 1),
                ],
                vec![
                    (14, 1), (12, 2), (11, 3), (10, 4), (9, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher high card wins",
                    "A1 22 33 44 61 > K1 Q2 J3 T4 81",
                ],
                vec![
                    (14, 1), (2, 2), (3, 3), (4, 4), (6, 1),
                ],
                vec![
                    (13, 1), (12, 2), (11, 3), (10, 4), (8, 1),
                ]
            ),
            (
                "()",
                vec!["A1 K2 J3 T4 81 72 53 = A1 K2 J3 T4 81"],
                vec![
                    (14, 1), (13, 2), (11, 3), (10, 4), (8, 1), (7, 2), (5, 3),
                ],
                vec![
                    (14, 1), (13, 2), (11, 3), (10, 4), (8, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher second card wins",
                    "A1 K2 23 34 41 > A1 Q2 J3 T4 91",
                ],
                vec![
                    (14, 1), (13, 2), (2, 3), (3, 4), (4, 1),
                ],
                vec![
                    (14, 1), (12, 2), (11, 3), (10, 4), (9, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher third card wins",
                    "A1 K2 Q3 24 41 > A1 K2 J3 T4 91",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (2, 4), (4, 1),
                ],
                vec![
                    (14, 1), (13, 2), (11, 3), (10, 4), (9, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher fourth card wins",
                    "A1 K2 Q3 J4 31 > A1 K2 Q3 T4 91",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (3, 1),
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (10, 4), (9, 1),
                ]
            ),
            (
                "1",
                vec![
                    "higher fifth card wins",
                    "A1 K2 Q3 J4 91 > A1 K2 Q3 J4 81",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (9, 1),
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (8, 1),
                ]
            ),
            (
                "()",
                vec![
                    "higher sixth card ties",
                    "A1 K2 Q3 J4 91 22 = A1 K2 Q3 J4 91 82"
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (9, 1), (2, 2),
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (9, 1), (8, 2),
                ]
            ),
            (
                "()",
                vec![
                    "high cards of different suits ties",
                    "A1 K2 Q3 J4 91 = A2 K3 Q4 J1 92",
                ],
                vec![
                    (14, 1), (13, 2), (12, 3), (11, 4), (9, 1),
                ],
                vec![
                    (14, 2), (13, 3), (12, 4), (11, 1), (9, 2),
                ]
            )
        ];

    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let deep_compare = read_hex_puzzle(&mut allocator, "resources/deep_compare.hex").expect("should read");

    let mut test_handcalc_with_example = |(expected_relationship, explanation, ex_data_1, ex_data_2)| {
        let source_data_1 =
            ("handcalc",
             (ex_data_1, ())
            ).to_clvm(&mut allocator).expect("should build");
        let source_data_2 =
            ("handcalc",
             (ex_data_2, ())
            ).to_clvm(&mut allocator).expect("should build");
        let result_1 = run_program(
            allocator.allocator(),
            &chia_dialect(),
            program.to_nodeptr(),
            source_data_1,
            0
        ).expect("should run").1;
        let result_2 = run_program(
            allocator.allocator(),
            &chia_dialect(),
            program.to_nodeptr(),
            source_data_2,
            0
        ).expect("should run").1;
        eprintln!("{explanation:?}");
        eprintln!(
            "result 1 {}",
            disassemble(allocator.allocator(), result_1, None)
        );
        eprintln!(
            "result 2 {}",
            disassemble(allocator.allocator(), result_2, None)
        );
        let deep_compare_args = [
            Node(first(allocator.allocator(), result_1).expect("ok")),
            Node(first(allocator.allocator(), result_2).expect("ok"))
        ].to_clvm(&mut allocator).expect("should build");
        let compare_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            deep_compare.to_nodeptr(),
            deep_compare_args,
            0
        ).expect("should run").1;
        assert_eq!(
            disassemble(allocator.allocator(), compare_result, None),
            expected_relationship
        );
    };

    for test in examples.into_iter() {
        eprintln!("test {test:?}");
        test_handcalc_with_example(test);
    }
}
