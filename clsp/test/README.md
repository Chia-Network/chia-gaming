# Test fixtures

`chialisp.toml` lists the fixtures built for the Gaming test suite. Game/referee
fixtures and the `shapes`/`pack` contract tests stay here because they exercise
code used by Gaming.

Standalone compiler fixtures have moved to
[chialisp's local regression corpus](https://github.com/Chia-Network/chialisp/pull/600)
and `src/tests/compiler/library` tests:
the sort, deep-compare, and permutations smoke tests; map/enumerate; and the old
unused prepend, range, reverse, sort, and permutations tests. They now compile
and run in the compiler's own Cargo test suite, without checking out Gaming.
Their exclusive helpers, `std.all_in_list` and `std.factorial`, moved with them.
Other standard-library modules remain here, including modules used transitively
by game code and the retained poker fixtures.
