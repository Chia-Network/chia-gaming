//! Coarse success-path comparison: `cargo bench --bench clvm_success`.
//!
//! This reports timings without a threshold assertion because scheduler and
//! optimizer variance make tight wall-clock guards flaky.

use std::hint::black_box;
use std::time::{Duration, Instant};

use chia_gaming::clvm_execution::{run_clvm, run_clvm_with_runtime_prints};
use chia_gaming::common::types::AllocEncoder;
use clvmr::allocator::{Allocator, NodePtr};
use clvmr::{run_program, ChiaDialect};

const ITERATIONS: u32 = 250_000;

fn elapsed(mut run: impl FnMut()) -> Duration {
    let start = Instant::now();
    for _ in 0..ITERATIONS {
        run();
    }
    start.elapsed()
}

fn main() {
    let mut bare_allocator = Allocator::new();
    let bare_program = bare_allocator.one();
    // This low-level benchmark intentionally calls clvmr directly to quantify
    // the success-path overhead of the application wrapper.
    let bare = elapsed(|| {
        black_box(
            run_program(
                &mut bare_allocator,
                &ChiaDialect::default(),
                bare_program,
                NodePtr::NIL,
                100,
            )
            .expect("bare successful execution"),
        );
    });

    let mut wrapped_allocator = Allocator::new();
    let wrapped_program = wrapped_allocator.one();
    let wrapped = elapsed(|| {
        black_box(
            run_clvm(&mut wrapped_allocator, wrapped_program, NodePtr::NIL, 100)
                .expect("wrapped successful execution"),
        );
    });

    let mut print_allocator = AllocEncoder::new();
    let print_program = print_allocator.allocator().one();
    let print_aware = elapsed(|| {
        black_box(
            run_clvm_with_runtime_prints(&mut print_allocator, print_program, NodePtr::NIL, 100)
                .expect("print-aware successful execution"),
        );
    });

    let bare_ns = bare.as_nanos() as f64 / f64::from(ITERATIONS);
    let wrapped_ns = wrapped.as_nanos() as f64 / f64::from(ITERATIONS);
    let print_ns = print_aware.as_nanos() as f64 / f64::from(ITERATIONS);
    println!(
        "CLVM success path ({ITERATIONS} iterations): bare={bare_ns:.1} ns/op, \
         wrapped={wrapped_ns:.1} ns/op ({:.3}x), \
         print-aware={print_ns:.1} ns/op ({:.3}x)",
        wrapped_ns / bare_ns,
        print_ns / bare_ns,
    );
}
