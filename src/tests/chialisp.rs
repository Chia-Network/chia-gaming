use clvmr::run_program;
use clvmr::allocator::Allocator;
use clvm_traits::ToClvm;

use crate::common::types::AllocEncoder;
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::chia_dialect;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

#[test]
fn run_map_enumerate_test() {
    let mut allocator = AllocEncoder::new();
    let source_data =
        (["A", "B", "C"], ()).to_clvm(&mut allocator).expect("should build");
    let program = read_hex_puzzle(&mut allocator, "resources/test_map_enumerate.hex").expect("should read");
    let nil = allocator.allocator().null();
    let result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        program.to_nodeptr(),
        source_data,
        0
    ).expect("should run").1;
    assert_eq!(
        disassemble(allocator.allocator(), result, None),
        "((65 ()) (66 1) (67 2))"
    );
}
