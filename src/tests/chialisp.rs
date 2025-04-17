use std::process::Command;

use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Error, Node, Program, Sha256Input};

use clvm_traits::ToClvm;
use clvmr::{run_program, ChiaDialect};
use clvmr::reduction::EvalErr;

use crate::utils::{first, proper_list};

use log::debug;

#[test]
fn test_prepend_count() {
    let mut allocator = AllocEncoder::new();
    let source_data = (
        "prepend_count",
        (
            [
                (6, (2, ())),
                (6, (3, ())),
                (5, (3, ())),
                (5, (4, ())),
                (5, (1, ())),
                (2, (1, ())),
                (3, (1, ())),
            ],
            (),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should build");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should do");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data,
        0,
    )
    .expect("should run")
    .1;
    let check_result = Program::from_hex("ffff02ff06ff0280ffff02ff06ff0380ffff03ff05ff0380ffff03ff05ff0480ffff03ff05ff0180ffff01ff02ff0180ffff01ff03ff018080").expect("cvt");
    let check_node = check_result.to_clvm(&mut allocator).expect("cvt");
    let result_hex = Node(result).to_hex(&mut allocator).expect("cvt");
    assert_eq!(
        result_hex,
        Node(check_node).to_hex(&mut allocator).expect("cvt")
    );
}

#[test]
fn test_make_cards() {
    let mut allocator = AllocEncoder::new();
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_make_cards.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should do");
    let source_data = [Sha256Input::Bytes(b"test").hash()]
        .to_clvm(&mut allocator)
        .expect("should build");
    let result = run_program(
        allocator.allocator(),
        &ChiaDialect::new(0),
        program_clvm,
        source_data,
        0,
    )
    .expect("should run")
    .1;
    let compare_result = (
        [5, 22, 23, 25, 27, 31, 32, 35],
        ([0, 6, 7, 20, 44, 45, 47, 51], ()),
    )
        .to_clvm(&mut allocator)
        .expect("cvt");
    let compare_hex = Node(compare_result).to_hex(&mut allocator).expect("cvt");
    assert_eq!(
        Node(result).to_hex(&mut allocator).expect("cvt"),
        compare_hex
    );
}

#[test]
fn test_mergein() {
    let mut allocator = AllocEncoder::new();
    let tests = [
        ([vec![1, 2, 9], vec![], vec![]], "ff01ff02ff0980"),
        ([vec![1, 2, 9], vec![3], vec![]], "ff01ff02ff05ff0980"),
    ];
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_mergein.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should do");
    for t in tests.iter() {
        let clvm_arg = t.0.to_clvm(&mut allocator).expect("should build");
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            program_clvm,
            clvm_arg,
            0,
        )
        .expect("should run")
        .1;
        let result_hex = Node(result).to_hex(&mut allocator).expect("cvt");
        assert_eq!(result_hex, t.1);
    }
}

#[test]
fn test_pull_indices() {
    let mut allocator = AllocEncoder::new();
    let source_data = (
        "pull_indices",
        (
            [1, 4, 5],
            (
                [
                    (6, (2, ())),
                    (6, (3, ())),
                    (5, (3, ())),
                    (5, (4, ())),
                    (5, (1, ())),
                    (2, (1, ())),
                    (3, (1, ())),
                ],
                (),
            ),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should build");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should do");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data,
        0,
    )
    .expect("should run")
    .1;
    assert_eq!(
        Node(result).to_hex(&mut allocator).expect("cvt"),
        "ffff06ff0380ffff05ff0180ffff02ff018080"
    );
}

#[test]
fn test_pull_out_straight() {
    let mut allocator = AllocEncoder::new();
    let source_data_ace = (
        "pull_out_straight",
        (
            5,
            ([[14, 1, 4], [5, 2, 0], [4, 3, 1], [3, 3, 2], [2, 4, 3]], ()),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should build");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should do");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data_ace,
        0,
    )
    .expect("should run")
    .1;
    assert_eq!(
        Node(result).to_hex(&mut allocator).expect("cvt"),
        "ff80ff01ff02ff0380",
    );
}

#[test]
fn test_onehandcalc_specific_case() {
    let mut allocator = AllocEncoder::new();
    let source_data = (
        "onehandcalc",
        (
            [
                (13, 4),
                (5, 2),
                (3, 3),
                (4, 3),
                (2, 1)
            ],
            ()
        )
    ).to_clvm(&mut allocator).expect("should convert");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should work");
    let result_e = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data,
        0,
    );
    if let Err(EvalErr(n, e)) = &result_e {
        debug!("error {e}: {:?}", Program::from_nodeptr(&mut allocator, *n));
    }
    let result = result_e.unwrap().1;
    assert_eq!(Node(result).to_hex(&mut allocator).unwrap(), "ff01ff01ff01ff01ff01ff0dff05ff04ff03ff0280");
}

#[test]
fn test_find_straight_high() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace = (
        "find_straight_high",
        (
            1,
            (
                0,
                (
                    0,
                    ([[14, 2, 0], [5, 2, 1], [4, 2, 2], [3, 2, 3], [2, 2, 4]], ()),
                ),
            ),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should build");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should work");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data_ace,
        0,
    )
        .expect("should run")
        .1;
    assert_eq!(Node(result).to_hex(&mut allocator).expect("cvt"), "05");
}

#[test]
fn test_straight_indices() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let source_data_ace = (
        "straight_indices",
        (
            [
                [14, 1, 0],
                [5, 2, 1],
                [4, 3, 2],
                [3, 3, 3],
                [2, 4, 4],
                [2, 1, 5],
            ],
            (),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should build");
    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let program_clvm = program.to_clvm(&mut allocator).expect("should work");
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program_clvm,
        source_data_ace,
        0,
    )
    .expect("should run")
    .1;
    assert_eq!(
        Node(result).to_hex(&mut allocator).expect("cvt"),
        "ff80ff01ff02ff03ff0480"
    );
}

#[test]
fn test_handcalc() {
    let mut allocator = AllocEncoder::new();
    // Add additional case tests for normal range, not a straight.
    let examples = [
        (
            "80",
            vec!["smoke test"],
            vec![(12, 1), (11, 1), (14, 1), (13, 1), (10, 1), (9, 1)],
            vec![(12, 1), (11, 1), (14, 1), (13, 1), (10, 1), (0, 1)],
        ),
        (
            "80",
            vec!["test from calpoker smoke test 1"],
            vec![
                (12, 2),
                (10, 1),
                (4, 3),
                (2, 1),
                (7, 4),
                (6, 3),
                (4, 2),
                (2, 3),
            ],
            vec![
                (12, 2),
                (10, 1),
                (4, 3),
                (2, 1),
                (7, 4),
                (6, 3),
                (4, 2),
                (2, 3),
            ],
        ),
        (
            "80",
            vec![
                "straight flushes of different suits tie",
                "A1 K1 Q1 J1 T1 = A2 K2 Q2 J2 T2",
            ],
            vec![(14, 1), (13, 1), (12, 1), (11, 1), (10, 1)],
            vec![(14, 2), (13, 2), (12, 2), (11, 2), (10, 2)],
        ),
        (
            "01",
            vec![
                "higher straight flush beats lower straight flush",
                "A1 K1 Q1 J1 T1 > 61 51 41 31 21",
            ],
            vec![(14, 1), (13, 1), (12, 1), (11, 1), (10, 1)],
            vec![(6, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
        ),
        (
            "80",
            vec!["A1 K1 Q1 J1 T1 91 = A1 K1 Q1 J1 T1"],
            vec![(12, 1), (11, 1), (14, 1), (13, 1), (10, 1), (9, 1)],
            vec![(14, 2), (11, 2), (10, 2), (13, 2), (12, 2)],
        ),
        (
            "01",
            vec![
                "lower (2-6) straight flush beats ace to four straight flush",
                "61 51 41 31 21 > A2 52 42 32 22",
            ],
            vec![(6, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
            vec![(14, 2), (5, 2), (4, 2), (3, 2), (2, 2)],
        ),
        (
            "80",
            vec!["A1 61 51 41 31 21 = 61 51 41 31 21"],
            vec![(14, 1), (6, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
            vec![(6, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
        ),
        (
            "80",
            vec![
                "ace to four straight flush with higher kicker ties",
                "A2 52 42 32 22 61 = A1 51 41 31 21 71",
            ],
            vec![(14, 2), (5, 2), (4, 2), (3, 2), (2, 2), (6, 1)],
            vec![(14, 1), (5, 1), (4, 1), (3, 1), (2, 1), (7, 1)],
        ),
        (
            "80",
            vec![
                "ace to four straight flushes of different suits tie",
                "A1 51 41 31 21 = A2 52 42 32 22",
            ],
            vec![(14, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
            vec![(14, 2), (5, 2), (4, 2), (3, 2), (2, 2)],
        ),
        (
            "01",
            vec![
                "ace to four straight flush beats four of a kind",
                "A1 51 41 31 21 > K1 K2 K3 K4 J1",
            ],
            vec![(14, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (11, 1)],
        ),
        (
            "80",
            vec!["A1 A2 A3 A4 51 41 31 21 = A1 51 41 31 21"],
            vec![(14, 1), (14, 2), (14, 3), (5, 1), (4, 1), (3, 1), (2, 1)],
            vec![(14, 1), (5, 1), (4, 1), (3, 1), (2, 1)],
        ),
        (
            "01",
            vec![
                "four of a kind with higher kicker wins",
                "K1 K2 K3 K4 Q1 > K1 K2 K3 K4 J1",
            ],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (12, 1)],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (11, 1)],
        ),
        (
            "80",
            vec!["K1 K2 K3 K4 T1 91 = K1 K2 K3 K4 T1"],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (10, 1), (9, 1)],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (10, 1)],
        ),
        (
            "80",
            vec![
                "four of a kind with higher second kicker ties",
                "K1 K2 K3 K4 Q1 J1 = K1 K2 K3 K4 Q1 T1",
            ],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (12, 1), (11, 1)],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (12, 1), (10, 1)],
        ),
        (
            "01",
            vec![
                "higher four of a kind beats lower four of a kind",
                "K1 K2 K3 K4 21 > 31 32 33 34 A1",
            ],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (2, 1)],
            vec![(3, 1), (3, 2), (3, 3), (3, 4), (14, 1)],
        ),
        (
            "80",
            vec!["K1 K2 K3 K4 31 32 33 34 = K1 K2 K3 K4 32"],
            vec![
                (13, 1),
                (13, 2),
                (13, 3),
                (13, 4),
                (3, 1),
                (3, 2),
                (3, 3),
                (3, 4),
            ],
            vec![(13, 1), (13, 2), (13, 3), (13, 4), (3, 2)],
        ),
        (
            "01",
            vec![
                "four of a kind beats full house",
                "21 22 23 24 31 > A1 A2 A3 K1 K2",
            ],
            vec![(2, 1), (2, 2), (2, 3), (2, 4), (3, 1)],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (13, 2)],
        ),
        (
            "80",
            vec!["four of a kind equality: 21 22 23 24 A1 A2 A3 = 21 22 23 24 A2"],
            vec![(2, 1), (2, 2), (2, 3), (2, 4), (14, 1), (14, 2), (14, 3)],
            vec![(2, 1), (2, 2), (2, 3), (2, 4), (14, 2)],
        ),
        (
            "01",
            vec![
                "full house with higher set wins",
                "51 52 53 21 22 > 31 32 33 71 72",
            ],
            vec![(5, 1), (5, 2), (5, 3), (2, 1), (2, 2)],
            vec![(3, 1), (3, 2), (3, 3), (7, 1), (7, 2)],
        ),
        (
            "80",
            vec!["A1 A2 A3 K1 K2 K3 = A1 A2 A3 K1 K2"],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (13, 2), (13, 3)],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (13, 2)],
        ),
        (
            "01",
            vec![
                "full house with same set and higher pair wins",
                "51 52 53 41 42 > 51 52 53 31 32",
            ],
            vec![(5, 1), (5, 2), (5, 3), (4, 1), (4, 2)],
            vec![(5, 1), (5, 2), (5, 3), (3, 1), (3, 2)],
        ),
        (
            "80",
            vec!["A1 A2 A3 K1 K2 51 52 = A1 A2 A3 K1 K2"],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (13, 2), (5, 1), (5, 2)],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (13, 2)],
        ),
        (
            "80",
            vec![
                "full house ties with two sets",
                "51 52 53 41 42 A1 = 51 52 53 41 42 43",
            ],
            vec![(5, 1), (5, 2), (5, 3), (4, 1), (4, 2), (14, 1)],
            vec![(5, 1), (5, 2), (5, 3), (4, 1), (4, 2), (4, 3)],
        ),
        (
            "01",
            vec!["full house beats flush", "51 52 53 41 42 > A1 Q1 T1 81 71"],
            vec![(5, 1), (5, 2), (5, 3), (4, 1), (4, 2)],
            vec![(14, 1), (12, 1), (10, 1), (8, 1), (7, 1)],
        ),
        (
            "80",
            vec!["51 52 53 41 42 A1 K1 Q1 = 51 52 53 41 42"],
            vec![
                (5, 1),
                (5, 2),
                (5, 3),
                (4, 1),
                (4, 2),
                (14, 1),
                (13, 1),
                (12, 1),
            ],
            vec![(5, 1), (5, 2), (5, 3), (4, 1), (4, 2)],
        ),
        (
            "01",
            vec![
                "higher flush beats lower flush",
                "A1 61 51 41 31 > K1 Q1 J1 T1 81",
            ],
            vec![(14, 1), (6, 1), (5, 1), (4, 1), (3, 1)],
            vec![(13, 1), (12, 2), (11, 1), (10, 1), (8, 1)],
        ),
        (
            "80",
            vec!["A1 K1 Q1 J1 81 71 = A1 K1 Q1 J1 81"],
            vec![(14, 1), (13, 1), (12, 1), (11, 1), (8, 1), (7, 1)],
            vec![(14, 1), (13, 1), (12, 1), (11, 1), (8, 1)],
        ),
        (
            "01",
            vec![
                "flush with higher second card wins",
                "A1 K1 51 41 31 > A1 Q1 J1 T1 91",
            ],
            vec![(14, 1), (13, 1), (5, 1), (4, 1), (3, 1)],
            vec![(14, 1), (12, 2), (11, 1), (10, 1), (9, 1)],
        ),
        (
            "01",
            vec![
                "flush with higher third card wins",
                "A1 K1 Q1 41 31 > A1 K1 J1 T1 91",
            ],
            vec![(14, 1), (13, 1), (12, 1), (4, 1), (3, 1)],
            vec![(14, 1), (13, 1), (11, 1), (10, 1), (9, 1)],
        ),
        (
            "01",
            vec![
                "flush with higher fourth card wins",
                "A1 K1 Q1 T1 21 > A1 K1 Q1 91 81",
            ],
            vec![(14, 1), (13, 1), (12, 1), (10, 1), (2, 1)],
            vec![(14, 1), (13, 1), (12, 1), (9, 1), (8, 1)],
        ),
        (
            "01",
            vec![
                "flush with higher fifth card wins",
                "A1 K1 Q1 T1 81 > A1 K1 Q1 T1 71",
            ],
            vec![(14, 1), (13, 1), (12, 1), (10, 1), (8, 1)],
            vec![(14, 1), (13, 1), (12, 1), (10, 1), (7, 1)],
        ),
        (
            "80",
            vec![
                "flushes of different suits tie",
                "A1 K1 J1 T1 81 = A2 K2 J2 T2 82",
            ],
            vec![(14, 1), (13, 1), (11, 1), (10, 1), (8, 1)],
            vec![(14, 2), (13, 2), (11, 2), (10, 2), (8, 2)],
        ),
        (
            "80",
            vec![
                "same flush with higher sixth card ties",
                "A1 K1 J1 T1 81 71 = A1 K1 J1 T1 81 61",
            ],
            vec![(14, 1), (13, 1), (11, 1), (10, 1), (8, 1), (7, 1)],
            vec![(14, 1), (13, 1), (11, 1), (10, 1), (8, 1), (6, 1)],
        ),
        (
            "01",
            vec!["flush beats straight", "71 61 51 41 21 > A1 K2 Q3 J4 T1"],
            vec![(7, 1), (6, 1), (5, 1), (4, 1), (2, 1)],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1)],
        ),
        (
            "80",
            vec!["A1 K2 Q3 J4 T1 81 71 61 = A1 T1 81 71 61"],
            vec![
                (14, 1),
                (13, 2),
                (12, 3),
                (11, 4),
                (10, 1),
                (8, 1),
                (7, 1),
                (6, 1),
            ],
            vec![(14, 1), (10, 1), (8, 1), (7, 1), (6, 1)],
        ),
        (
            "80",
            vec![
                "straight with higher kicker ties",
                "A1 K2 Q3 J4 T1 92 = A1 K2 Q3 J4 T1 22",
            ],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (9, 2)],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (2, 2)],
        ),
        (
            "80",
            vec![
                "straights of different suits tie",
                "A1 K2 Q3 J4 T1 = A2 K3 Q4 J1 T2",
            ],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1)],
            vec![(14, 2), (13, 3), (12, 4), (11, 1), (10, 2)],
        ),
        (
            "01",
            vec![
                "higher straight beats lower straight",
                "A1 K2 Q3 J4 T1 > 61 52 43 34 21",
            ],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1)],
            vec![(6, 1), (5, 2), (4, 3), (3, 4), (2, 1)],
        ),
        (
            "80",
            vec!["A1 K2 Q3 J4 T1 92 83 = A1 K2 Q3 J4 T1"],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (10, 1), (9, 2), (8, 3)],
            vec![(14, 2), (13, 3), (12, 4), (11, 1), (10, 2)],
        ),
        (
            "01",
            vec![
                "lower (2-6) straight beats ace to four straight",
                "61 52 43 34 21 > A1 52 43 34 21",
            ],
            vec![(6, 1), (5, 2), (4, 3), (3, 4), (2, 1)],
            vec![(14, 1), (5, 2), (4, 3), (3, 4), (2, 1)],
        ),
        (
            "80",
            vec!["A1 62 53 44 31 22 = 62 53 44 31 22"],
            vec![(14, 1), (6, 2), (5, 3), (4, 4), (3, 1), (2, 2)],
            vec![(6, 2), (5, 3), (4, 4), (3, 1), (2, 2)],
        ),
        (
            "80",
            vec![
                "ace to four straight with higher kicker ties",
                "A1 52 43 34 21 K2 = A1 52 43 34 21 72",
            ],
            vec![(14, 1), (5, 2), (4, 3), (3, 4), (2, 1), (13, 2)],
            vec![(14, 1), (5, 2), (4, 3), (3, 4), (2, 1), (7, 2)],
        ),
        (
            "80",
            vec![
                "ace to fours of different suits tie",
                "A1 52 43 34 21 = A2 53 44 31 22",
            ],
            vec![(14, 1), (5, 2), (4, 3), (3, 4), (2, 1)],
            vec![(14, 2), (5, 3), (4, 4), (3, 1), (2, 2)],
        ),
        (
            "01",
            vec![
                "ace to four straight beats set",
                "A1 52 43 34 21 > A1 A2 A3 K1 Q2",
            ],
            vec![(14, 1), (5, 2), (4, 3), (3, 4), (2, 1)],
            vec![(14, 1), (14, 2), (14, 3), (13, 1), (12, 2)],
        ),
        (
            "80",
            vec!["A1 A2 A3 52 43 34 21 = A1 52 43 34 21"],
            vec![(14, 1), (14, 2), (14, 3), (5, 2), (4, 3), (3, 4), (2, 1)],
            vec![(14, 1), (5, 2), (4, 3), (3, 2), (2, 1)],
        ),
        (
            "01",
            vec!["higher set wins", "71 72 73 34 21 > 51 52 53 A4 K1"],
            vec![(7, 1), (7, 2), (7, 3), (3, 4), (2, 1)],
            vec![(5, 1), (5, 2), (5, 3), (14, 4), (13, 1)],
        ),
        (
            "01",
            vec![
                "set with higher first kicker wins",
                "71 72 73 A1 22 > 71 72 73 K1 Q2",
            ],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (2, 2)],
            vec![(7, 1), (7, 2), (7, 3), (13, 1), (12, 2)],
        ),
        (
            "80",
            vec!["71 72 73 A1 K2 J3 54 43 = 71 72 73 A1 K2"],
            vec![
                (7, 1),
                (7, 2),
                (7, 3),
                (14, 1),
                (13, 2),
                (11, 3),
                (5, 4),
                (4, 3),
            ],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (13, 2)],
        ),
        (
            "01",
            vec![
                "set with higher second kicker wins",
                "71 72 73 A1 K2 > 71 72 73 A1 Q2",
            ],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (13, 2)],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (12, 2)],
        ),
        (
            "80",
            vec![
                "set with higher third kicker ties",
                "71 72 73 A1 K2 Q3 = 71 72 73 A1 K2 J3",
            ],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (13, 2), (12, 3)],
            vec![(7, 1), (7, 2), (7, 3), (14, 1), (13, 2), (11, 3)],
        ),
        (
            "01",
            vec!["set beats two pair", "71 72 73 34 21 > A1 A2 K3 K4 Q1"],
            vec![(7, 1), (7, 2), (7, 3), (3, 4), (2, 1)],
            vec![(14, 1), (14, 2), (13, 3), (13, 4), (12, 1)],
        ),
        (
            "01",
            vec![
                "two pair with higher high pair wins",
                "K1 K2 33 34 21 > Q1 Q2 J3 J4 A1",
            ],
            vec![(13, 1), (13, 2), (3, 3), (3, 4), (2, 1)],
            vec![(12, 1), (12, 2), (11, 3), (11, 4), (14, 1)],
        ),
        (
            "80",
            vec!["A1 A2 K1 K2 J1 J2 = A1 A2 K1 K2 J3"],
            vec![(14, 1), (14, 2), (13, 1), (13, 2), (11, 1), (11, 2)],
            vec![(14, 1), (14, 2), (13, 1), (13, 2), (11, 3)],
        ),
        (
            "01",
            vec![
                "two pair with tied higher pair and higher lower pair wins",
                "K1 K2 71 72 23 > K1 K2 63 64 A1",
            ],
            vec![(13, 1), (13, 2), (7, 1), (7, 2), (2, 3)],
            vec![(13, 1), (13, 2), (6, 3), (6, 4), (14, 1)],
        ),
        (
            "01",
            vec![
                "two pair with higher kicker wins",
                "K1 K2 Q3 Q4 J1 > K1 K2 Q3 Q4 T1",
            ],
            vec![(13, 1), (13, 2), (12, 3), (12, 4), (11, 1)],
            vec![(13, 1), (13, 2), (12, 3), (12, 4), (10, 1)],
        ),
        (
            "80",
            vec!["K1 K2 Q3 Q4 A1 T1 92 63 = K1 K2 Q3 Q4 A1"],
            vec![
                (13, 1),
                (13, 2),
                (12, 3),
                (12, 4),
                (14, 1),
                (10, 1),
                (9, 2),
                (6, 3),
            ],
            vec![(13, 1), (13, 2), (12, 3), (12, 4), (14, 1)],
        ),
        (
            "80",
            vec![
                "two pair with higher second kicker ties",
                "K1 K2 Q3 Q4 J1 T2 = K1 K2 Q3 Q4 J1 92",
            ],
            vec![(13, 1), (13, 2), (12, 3), (12, 4), (11, 1), (10, 2)],
            vec![(13, 1), (13, 2), (12, 3), (12, 4), (11, 1), (9, 2)],
        ),
        (
            "01",
            vec!["two pair beats pair", "41 42 33 34 21 > A1 A2 K3 Q4 J1"],
            vec![(4, 1), (4, 2), (3, 3), (3, 4), (2, 1)],
            vec![(14, 1), (14, 2), (13, 3), (12, 4), (11, 1)],
        ),
        (
            "01",
            vec!["higher pair wins", "71 72 53 44 31 > 61 62 A3 K4 Q1"],
            vec![(7, 1), (7, 2), (5, 3), (4, 4), (3, 1)],
            vec![(6, 1), (6, 2), (14, 3), (13, 4), (12, 1)],
        ),
        (
            "01",
            vec![
                "tied pair with higher first kicker wins",
                "91 92 A3 34 21 > 91 92 K3 Q4 J1",
            ],
            vec![(9, 1), (9, 2), (14, 3), (3, 4), (2, 1)],
            vec![(9, 1), (9, 2), (13, 3), (12, 4), (11, 1)],
        ),
        (
            "80",
            vec!["21 22 A1 Q2 J3 94 81 = 21 22 A1 Q2 J3"],
            vec![(2, 1), (2, 2), (14, 1), (12, 2), (11, 3), (9, 4), (8, 1)],
            vec![(2, 1), (2, 2), (14, 1), (12, 2), (11, 3)],
        ),
        (
            "01",
            vec![
                "tied pair with higher second kicker wins",
                "91 92 A3 K4 21 > 91 92 A3 Q4 J1",
            ],
            vec![(9, 1), (9, 2), (14, 3), (13, 4), (2, 1)],
            vec![(9, 1), (9, 2), (14, 3), (12, 4), (11, 1)],
        ),
        (
            "01",
            vec![
                "tied pair with higher third kicker wins",
                "91 92 A3 K4 Q1 > 91 92 A3 K4 J1",
            ],
            vec![(9, 1), (9, 2), (14, 3), (13, 4), (12, 1)],
            vec![(9, 1), (9, 2), (14, 3), (13, 4), (11, 1)],
        ),
        (
            "80",
            vec![
                "tied pair with higher fourth kicker ties",
                "91 92 A3 K4 Q1 J2 = 91 92 A3 K4 Q1 T2",
            ],
            vec![(9, 1), (9, 2), (14, 3), (13, 4), (12, 1), (11, 2)],
            vec![(9, 1), (9, 2), (14, 3), (13, 4), (12, 1), (10, 2)],
        ),
        (
            "01",
            vec!["pair beats high card", "21 22 33 44 51 > A1 Q2 J3 T4 91"],
            vec![(2, 1), (2, 2), (3, 3), (4, 4), (5, 1)],
            vec![(14, 1), (12, 2), (11, 3), (10, 4), (9, 1)],
        ),
        (
            "01",
            vec!["higher high card wins", "A1 22 33 44 61 > K1 Q2 J3 T4 81"],
            vec![(14, 1), (2, 2), (3, 3), (4, 4), (6, 1)],
            vec![(13, 1), (12, 2), (11, 3), (10, 4), (8, 1)],
        ),
        (
            "80",
            vec!["A1 K2 J3 T4 81 72 53 = A1 K2 J3 T4 81"],
            vec![(14, 1), (13, 2), (11, 3), (10, 4), (8, 1), (7, 2), (5, 3)],
            vec![(14, 1), (13, 2), (11, 3), (10, 4), (8, 1)],
        ),
        (
            "01",
            vec!["higher second card wins", "A1 K2 23 34 41 > A1 Q2 J3 T4 91"],
            vec![(14, 1), (13, 2), (2, 3), (3, 4), (4, 1)],
            vec![(14, 1), (12, 2), (11, 3), (10, 4), (9, 1)],
        ),
        (
            "01",
            vec!["higher third card wins", "A1 K2 Q3 24 41 > A1 K2 J3 T4 91"],
            vec![(14, 1), (13, 2), (12, 3), (2, 4), (4, 1)],
            vec![(14, 1), (13, 2), (11, 3), (10, 4), (9, 1)],
        ),
        (
            "01",
            vec!["higher fourth card wins", "A1 K2 Q3 J4 31 > A1 K2 Q3 T4 91"],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (3, 1)],
            vec![(14, 1), (13, 2), (12, 3), (10, 4), (9, 1)],
        ),
        (
            "01",
            vec!["higher fifth card wins", "A1 K2 Q3 J4 91 > A1 K2 Q3 J4 81"],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (9, 1)],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (8, 1)],
        ),
        (
            "80",
            vec![
                "higher sixth card ties",
                "A1 K2 Q3 J4 91 22 = A1 K2 Q3 J4 91 82",
            ],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (9, 1), (2, 2)],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (9, 1), (8, 2)],
        ),
        (
            "80",
            vec![
                "high cards of different suits ties",
                "A1 K2 Q3 J4 91 = A2 K3 Q4 J1 92",
            ],
            vec![(14, 1), (13, 2), (12, 3), (11, 4), (9, 1)],
            vec![(14, 2), (13, 3), (12, 4), (11, 1), (9, 2)],
        ),
    ];

    let program =
        read_hex_puzzle(&mut allocator, "clsp/test/test_handcalc_micro.hex").expect("should read");
    let deep_compare =
        read_hex_puzzle(&mut allocator, "clsp/test/deep_compare.hex").expect("should read");

    let mut test_handcalc_with_example =
        |(expected_relationship, explanation, ex_data_1, ex_data_2)| {
            let source_data_1 = ("handcalc", (ex_data_1, ()))
                .to_clvm(&mut allocator)
                .expect("should build");
            let source_data_2 = ("handcalc", (ex_data_2, ()))
                .to_clvm(&mut allocator)
                .expect("should build");
            let program_clvm = program.to_clvm(&mut allocator).expect("should do");
            let result_1 = run_program(
                allocator.allocator(),
                &chia_dialect(),
                program_clvm,
                source_data_1,
                0,
            )
            .expect("should run")
            .1;
            let hc_prog = Program::from_nodeptr(&mut allocator, program_clvm).unwrap();
            let hc_args = Program::from_nodeptr(&mut allocator, source_data_2).unwrap();
            let o = Command::new("/bin/sh")
                .args(["cldb", "-x", "-p", &hc_prog.to_hex(), &hc_args.to_hex()])
                .output()
                .expect("failed to execute process");
            let out_str: String = o.stdout.from_utf_unchecked();
            debug!("cldb print\n{}", decode_string(&out_str));
            let result_2 = run_program(
                allocator.allocator(),
                &chia_dialect(),
                program_clvm,
                source_data_2,
                0,
            )
            .expect("should run")
            .1;
            debug!("{explanation:?}");

            let check_result_len = |allocator: &mut AllocEncoder, result| {
                let result_list = proper_list(allocator.allocator(), result, true).unwrap();
                let result_check_l = proper_list(allocator.allocator(), result_list[1], true).unwrap();
                assert_eq!(result_check_l.len(), 5);
            };
            debug!("check length 1");
            check_result_len(&mut allocator, result_1);
            debug!("check length 2");
            check_result_len(&mut allocator, result_2);

            let deep_compare_args = [
                Node(first(allocator.allocator(), result_1).expect("ok")),
                Node(first(allocator.allocator(), result_2).expect("ok")),
            ]
            .to_clvm(&mut allocator)
            .expect("should build");
            let deep_compare_program = deep_compare.to_clvm(&mut allocator).expect("should work");
            let compare_result = run_program(
                allocator.allocator(),
                &chia_dialect(),
                deep_compare_program,
                deep_compare_args,
                0,
            )
            .expect("should run")
            .1;
            let compare_res_hex = Node(compare_result).to_hex(&mut allocator).expect("cvt");
            assert_eq!(compare_res_hex, expected_relationship);
        };

    for test in examples.into_iter() {
        debug!("test {test:?}");
        test_handcalc_with_example(test);
    }
}
