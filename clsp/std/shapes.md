# Shapes and pack

Import `(import std.shapes)` for `defun-shape`, `make`, `invoke`, `if-shape`, and `get-field`.
Shapes describe pair structure once, for both constructing and reading values.
The macros expand at compile time; there is no runtime shape registry. Import
the whole bundle without `exposing`: inward expansion also uses its helper macros.

```
(defun-shape point #(x y z))
(defun total (point a b c) (+ a b c))

(make (point X Y Z))       ; (X . (Y . Z)), evaluated values, no outer list
(invoke total (point X Y Z))
(invoke total #(X Y Z))    ; same call: tree is the entire argument environment
```

A named shape with no arguments uses its declared names: `(point)` expands to
`#(x y z)`. Field names in a declaration must be unique. Arguments replace them left to right. Shapes can nest inside
other shapes, including at dotted tails. `#(...)` is the language's native
balanced-tree reader syntax, not a different kind of runtime value.

```
(defun-shape branches #((point) (left . right)))
(make (branches A B C D E))
(make #((point A B C) (D . E)))   ; same tree
```

Templates treat pairs as structure, not executable expressions. Bind a compound
expression to a name before putting it in a template. Literal `nil` and `()`
construct nil; `(a b c)` includes its usual terminating nil, exactly like
`(a b c . nil)`. `(a b . c)` has no terminating nil. Literal `nil`, `atom`, and
`optional` are reserved as declaration/destructuring field names. Macro
expansion rejects reserved field and shape names, malformed annotations, and
duplicate names in declarations or dispatch patterns. `atom` takes exactly one
leaf; in a binding pattern that leaf must be a non-reserved field name.
`optional` takes one or more template arguments in a proper list. `if-shape`
branches require exactly a template and one body. Consumers check expanded
named shapes, so substitution cannot bypass their checks.

`make` and `invoke` check annotation syntax but allow bare `atom` and `optional`
as value expressions at leaf positions, including inside valid annotations.
Literal `nil` always constructs nil. The macros cannot distinguish valid
annotation syntax from an accidentally identical pair template. All validation
happens during macro expansion and adds no runtime checks.

Ordinary field names must not collide
with macros that the compiler would expand in that position.

## Raw construction with pack

Import `(import std.pack)` when you just want to construct the written tree,
without shape annotations or field-name rules:

```
(pack (d . (a . b)))  ; equivalent to (c d (c a b))
(pack (a b c))        ; proper list
(pack #(a b c d))     ; balanced tree
(pack (atom a))       ; ordinary list of the values atom and a
```

`pack` has no dependency on `std.shapes`. Every pair in its input is structure;
leaves are ordinary Chialisp expressions. In particular, `nil` is an ordinary
identifier here, not a shape annotation: use `()` for a literal empty atom.
Bind compound expressions before using them as leaves.

Construction uses the inline `li` argument-identity idiom, with `&rest` for a
dotted tail. For example, `(pack (d a . b))` emits the equivalent of
`(li d a &rest b)`. `make` first strips its shape annotations and uses the same
builder. No shape checks are added to the runtime program.

## Constraints and optional subtrees

- `a` names an unrestricted value at a required position.
- `(atom a)` names an atom, including nil.
- `nil` or `()` requires nil and binds no name.
- `(optional TREE)` names the fields inside TREE but supplies **no constraints**
  anywhere under it, including its pairs, atom labels, and implicit nils.
- `(optional a b)` is shorthand for `(optional (a b))`.

For example, `(a b . (optional c d))` requires the first two list cells. It names
paths for `c` and `d` without requiring the remaining list cells to exist.
Reading either name is the branch's responsibility: establish that the path is
safe first. Unused bindings need not be read. A failed access aborts the whole
CLVM evaluation; it cannot be caught or used to try another shape.

`make` constructs the full described template, including optional structure.
Optional means "no matching guarantees," not "omit this constructor argument."

## Dispatch and destructuring

```
(defun-shape left ((a . b) . (atom c)))
(defun-shape right ((atom d) . (e . f)))

(if-shape VALUE
    ((left) (+ a b c))
    ((right) (+ d e f)))
```

Each branch is `(SHAPE BODY)`. Inline shapes work too:

```
(if-shape VALUE
    (((a . b) . (atom c)) (+ a b c))
    (((atom d) . (e . f)) (+ d e f)))
```

`if-shape` assumes VALUE belongs to one of the alternatives. It distinguishes
cases; it does not validate the whole input. Once only one alternative remains,
it enters that branch without checking its remaining constraints. The final
alternative depends on the generated decision tree, not textual branch order.
Overlapping or indistinguishable alternatives produce a compilation error.
There is no catch-all clause.

The planner first prefers a safe atom/pair or nil test that singles out one
alternative. Otherwise it prefers a split with the smallest worst-case group,
then recurses. If those tests are all too deep to read safely, it first checks a
parent pair, even when that outcome does not eliminate any alternatives. This is
a greedy heuristic, not a globally optimal search.
Accesses are only generated when every ancestor is known to be a pair, from the
remaining shapes or earlier tests. Optional structure never supplies that fact.

The selected branch uses `assign` to destructure the value. Generated temporary
names avoid names occurring in the input and branch bodies. Constraints are
consumed by `make` and `if-shape`; an ordinary `defun` parameter pattern can use
an unannotated named shape, as in `point` above.

## Reading one field

```
(defun-shape record ((a . b) . c))
(get-field (record) b VALUE)        ; expands to (r (f VALUE))
(get-field ((a . b) . c) b VALUE)   ; same with an inline shape
(get-field (record x y z) y VALUE) ; renamed fields work too
```

The shape macro expands first, just as in `if-shape`. `get-field` finds the
requested field and emits its `f`/`r` path, or the value itself for a root field.
Unknown, reserved, or ambiguous field names are compile-time errors. It assumes
the value has the declared shape and emits no runtime validation. Fields under
`optional` can be selected, but their paths must exist when accessed; unrelated
optional fields are not read.

## Referee

`clsp/referee/onchain/shapes.clinc` declares the referee's layouts. Its curried arguments
remain the native eleven-field `#(...)` tree. The three solutions have no list
terminators:

```
timeout: (mover_payout_ph . waiter_payout_ph)
move:    ((new_move . infohash_c) . (new_mover_share . new_max_move_size))
slash:   ((previous_state previous_validation_program . evidence) . mover_payout_ph)
```

Timeout is two atoms, move is two pairs, slash is a pair followed by an atom.
The classifier needs two pair tests and never inspects evidence. Rust's encoder,
signature hashing, decoder, and validator argument builders use the same layouts.

## On-chain game records

The games' `clsp/onchain/shapes.clinc` bundles declare their fixed state records and
shared helper results with `#`. Inline `make-...` constructors evaluate field
expressions before passing their names to `make`. Validators and off-chain
handlers import these on-chain declarations when reading the same records.
Shared game layouts belong under `onchain`: off-chain code may import them,
but on-chain code must not import off-chain modules. UI-facing
lists and handler calling conventions are unchanged.

Card sequences, hand rankings consumed by list comparison, Krunk's guess/clue
histories, and conditions remain lists: these are traversed sequences, not
fixed records. Currying is unchanged.

Validator results use the explicit pair layout `referee-result`:
`((next_validator_hash . new_state) . (max_move_size . extra_conditions))`.
`validator-transition` supplies an empty conditions list; `validator-result`
accepts the conditions explicitly. Terminal success is
`(validator-transition 0 0 0)`; bare nil means slash. Referee distinguishes nil
from the result record with `if-shape`. Rust decodes the same pair layout.

## Library tests

`src/tests/shapes.rs` tests the bundle independently of any game or referee.
`clsp/test/test_shapes.clsp` and `test_make.clsp` provide production-built
constructor, invocation, destructuring, hygiene, and dispatch fixtures.
The Rust tests also compile generated unions with the production compiler
options and execute their exported programs. They cover every ordering of a
four-way atom/pair matrix, eight-way dispatch requiring three checks, guarded
nested paths, nil tests, and absent or malformed optional subtrees. Compile-time
negative cases check overlapping alternatives and invalid declarations/calls.

`src/tests/pack.rs` tests `std.pack` independently, including proper lists,
dotted and balanced trees, and names that are reserved only by shapes. It also
compares `pack` and `make` outputs and runtime costs with explicit constructors.

Run `./ct-automation.sh` to include these tests in the full suite.
