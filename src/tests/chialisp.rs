use clvmr::run_program;
use clvmr::allocator::Allocator;
use clvm_traits::ToClvm;

use crate::common::types::{AllocEncoder, Node};
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::chia_dialect;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

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
#[ignore]
fn test_find_straight_high() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace =
        ("find_straight_high",
         (1,
          (0,
           (0,
            ([
                [14, 1, 4],
                [5, 2, 0],
                [4, 3, 1],
                [3, 3, 2],
                [2, 4, 3],
                [2, 1, 1],
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
#[ignore]
fn test_straight_indices() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace =
        ("straight_indices",
         ([
             [14, 1, 4],
             [5, 2, 0],
             [4, 3, 1],
             [3, 3, 2],
             [2, 4, 3],
             [2, 1, 1],
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
        "(c () 1 2 3)",
    );
}

#[test]
fn test_handcalc() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let examples =
        [
            // ([ // Simple smoke test example.
            //     (14, 1),
            //     (5, 2),
            //     (4, 3),
            //     (3, 3),
            //     (2, 4),
            //     (2, 2),
            // ], "(5 4 () 1 2)"),
            (
                "()",
                [
                    (12, 1),
                    (11, 1),
                    (14, 1),
                    (13, 1),
                    (10, 1),
                    (9, 1)
                ],
                [
                    (12, 1),
                    (11, 1),
                    (14, 1),
                    (13, 1),
                    (10, 1),
                    (0, 1)
                ]
            )
        ];

    let program = read_hex_puzzle(&mut allocator, "resources/test_handcalc_micro.hex").expect("should read");
    let deep_compare = read_hex_puzzle(&mut allocator, "resources/deep_compare.hex").expect("should read");

    let mut test_handcalc_with_example = |&(expected_relationship, ex_data_1, ex_data_2)| {
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
        let deep_compare_args = [
            Node(result_1),
            Node(result_2)
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

    for test in examples.iter() {
        test_handcalc_with_example(test);
    }
}
