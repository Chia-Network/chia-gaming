---
name: modularization
description: Design, review, and refactor code architecture, module boundaries, ownership, and API contracts to minimize code and coupling. Use for initial architecture and API design as well as modularization and removal of redundant layers in existing code.
---

# Architecture, Modularization, and API Design

These principles apply both to designing new code and to refactoring existing
code. Establish clear ownership and narrow contracts from the start; use the
same criteria to evaluate and improve an existing design.

## What We Are Optimizing

The goals are future maintainability and a lower likelihood of unknown current
bugs. Prefer designs with less code: fewer places to hide bugs, less machinery
for tests to cover, and less to understand or change during future maintenance.

Minimize the code and coordination needed to meet the requirements, including
mutable state, forwarding, and conversions. Line count is useful evidence, not
a substitute for judgment. Code golf, deleting useful validation, weakening
tests, or hiding a large protocol inside one generic method does not make a
design smaller. Cross-language moves can add lines through verbosity while
removing real complexity. Compare the added implementation with the coordination
it replaces; added abstractions need to earn their cost.

The desired result is a small number of boundaries with narrow APIs, each call
having minimal preconditions and clear postconditions. Related functionality
belongs together so its invariants can be tested together and likely future
changes stay local. Finding those groupings requires understanding the operations
and invariants, and reading the implementation where one exists. Names, file
sizes, and architectural fashions are weak substitutes.

## Choose Ownership and Boundaries

Trace or sketch representative operations end to end before choosing or changing
a boundary. Include the failure or recovery paths that exercise it. Identify:

- Who creates, owns, and retires each object, and which lifetimes differ.
- Which component is authoritative for each fact and enforces each invariant.
- Who schedules work, orders side effects, and makes results visible.
- What callers must know or do in sequence to use the API correctly.

For new code, start with the smallest concrete arrangement of owners and
contracts that supports the required operations. Add boundaries where they
isolate meaningful responsibilities or invariants. Avoid frameworks, extension
points, and layers whose only justification is hypothetical future needs.

In existing code, look first for tightly coupled objects with the same lifetime
and redundant layers. If two objects are always created together, call back into
each other, and require coordinated teardown, consolidating them may remove an
entire coordination protocol. Identify which fields, callbacks, registries, and
transitions would disappear. Merely replacing two names with one is a smaller win.

Shared lifetime is evidence, not a proof that everything belongs in one class.
A cohesive algorithm, independently useful component, or private state grouping
needed for borrowing or synchronization scopes can justify separation. Moving
methods into another file does not create a module boundary if they still reach
through the same object's internals.

Respect different lifetimes. A short-lived operation can use a shared resource
without owning that resource's lifetime. Replacing a connection or consumer
should not require replacing unrelated state unless the contract calls for it.
Group by shared invariants and likely changes, not merely by things that happen
at the same time.

## Design Narrow, Hard-to-Misuse APIs

Measure width by what crosses a boundary and what each side must understand.
Count operations, data shapes, callbacks, lifecycle obligations, and required
call ordering. A single `dispatch(any)` or a large context object can expose a
wider protocol than several well-typed domain operations.

Prefer complete operations whose owner establishes its internal invariants.
Callers should supply intent and required inputs, not manipulate the owner's
fields or reproduce its state machine. Instead of requiring callers to set
fields, register callbacks, invoke work, and finalize changes in the right order,
see whether one owner can carry out the whole operation.

For each operation, make the following clear to a caller without reading its
implementation:

- **Preconditions:** What must already be true? Eliminate requirements the
  callee can establish or enforce internally. Do not invent readiness queues,
  retries, or silent no-ops just to accept calls in more states.
- **Success:** What is guaranteed on return? Does success mean validated,
  queued, applied, or durably stored? Do not blur those distinct promises.
- **Failure:** Which errors can occur, and what state or externally visible
  effects, if any, remain? Do not claim atomicity unless the implementation
  provides it. When refactoring, preserve the established failure contract.
- **Ordering and lifetime:** When may results or events arrive, can callbacks
  reenter, and what happens to outstanding work on cancellation or teardown?
  Keep those obligations inside the owner wherever possible.

Use explicit inputs and typed results or events. Pass a value when a value is
all that is needed, such as configuration at construction, instead of installing
a callback for retrieving it. Keep a callback or provider when repeated access,
freshness, or asynchronous delivery is actually part of the contract.

Keep one authority for each mutable fact. Other components may maintain derived
views, but they should not independently decide the same transition. Results and
events must reflect the state reached by the authoritative operation. A rejected
operation must not already have been published as successful. Distinct return
and event paths are reasonable when they serve distinct consumers.

Where event ordering and batching matter, preserve them through the boundary.
A batch-completion notification belongs in the ordered flow it governs. Streams
with different contracts and destinations do not need to become one universal
event bus.

Cross-cutting work can have a clear owner without becoming a collection of
callbacks spread across every object. A coordinator can order operations across
components while those components own their resources. Keep domain decisions
with their domain owner; coordination should depend on explicit contracts rather
than knowledge of every component's private state.

## Finish Moving the Responsibility

A large object shoved halfway through a small pipe is worse than having it
entirely on either side. Moving an operation while leaving its state, validation,
retry decisions, or lifecycle control behind often widens the interface.

Move the responsibility with the state and invariants it needs. Update callers
to use the resulting complete operation, then remove the old forwarding,
callbacks, aliases, conversions, duplicate state, and synchronization that the
move makes unnecessary. Do not preserve an internal wrapper merely because it
used to be an API. Preserve compatibility where an external contract requires it.

Trace the operation again after the change. Does either side still tell the
other how to implement its half? Is an old object being passed through the new
interface so callers can reach inside it? Does a round trip now exist solely to
finish an operation that could remain within one owner? These indicate unfinished
work, even if the public method list looks short.

Coherent incremental steps are fine. Each completed step should have clear
authority and a working contract; temporary migration glue needs an explicit
removal point. Complete each selected boundary change before expanding into
unrelated redesigns.

## Fail Fast on Broken Invariants

Avoid adding fallbacks for conditions that should never occur, and generally
remove existing ones. Fail visibly at the violated invariant, with enough context
to diagnose it, instead of continuing with invented defaults or switching to an
obsolete code path. Bespoke fallbacks tend to mask bugs while adding more code
and states to maintain. Remove old, unused functionality rather than preserving
it as a fallback "just in case."

A generic exception catch that logs failures at the application root or another
appropriate production boundary is reasonable. It can contain a failed
operation without each internal layer pretending it succeeded. Fail fast does
not require crashing the entire application; it requires exposing the failure
and stopping the affected work before invalid state propagates.

Distinguish broken invariants from expected operational failures. Invalid user
input, unavailable services, and supported compatibility cases may require
explicit recovery behavior. Establish from callers, contracts, and tests why a
fallback is unnecessary; its age or infrequent use alone is not proof.

Apply judgment about the codebase's overall quality. In a deeply tangled,
persistently buggy system that cannot reasonably be repaired within the task,
localized fallbacks may be necessary containment for concrete, known failures.
That exception should not become a habit in a codebase where invariants can be
established and bugs fixed at their source.

## Smells Worth Investigating

Investigate these warning signs case by case. Trace the actual cost and preserve
a structure when its purpose outweighs that cost.

- **Paired objects with one lifetime.**
  **Warning sign:** Two objects require reciprocal callbacks and coordinated
  install/replace/retire methods despite sharing a lifetime.
  **Assessment:** Consider one owner; retain meaningful private state or
  algorithm boundaries.
- **Forward-only controllers, drivers, and managers.**
  **Warning sign:** An object only forwards calls and maps identical arguments,
  with no responsibility of its own.
  **Assessment:** Real adaptation, validation, isolation, or policy can justify
  a thin layer.
- **Handles and registries for objects already in hand.**
  **Warning sign:** Callers register, look up, and retire handles for objects
  they could own directly.
  **Assessment:** Direct ownership may remove that machinery. Stable external
  identities, serialization, and genuine FFI constraints can still require handles.
- **Internal serialization round trips.**
  **Warning sign:** Values are encoded just to be decoded in a cooperating
  object, adding conversions and failure paths.
  **Assessment:** Keep serialization at real wire, persistence, or language
  boundaries; verify numeric precision and ownership requirements before replacing it.
- **Large context objects or callback bundles.**
  **Warning sign:** A narrow-looking constructor gives a component access to
  the entire application.
  **Assessment:** Pass only the inputs or capabilities it needs; do not merely
  wrap the same broad access in another type.
- **Mirrored state and parallel flags.**
  **Warning sign:** Multiple readiness, attachment, or lifecycle flags represent
  the same fact but can disagree.
  **Assessment:** Derive facts or choose one owner. Caches and durable recovery
  markers need a specific correctness purpose, update rule, and retirement rule;
  similarity alone is not duplication.
- **Setter choreography and half-initialized objects.**
  **Warning sign:** Correctness depends on callers remembering an undocumented
  sequence to establish invariants.
  **Assessment:** Prefer construction or a complete domain operation. Genuine
  multi-step protocols still need explicit states.
- **Caller-managed success and rollback.**
  **Warning sign:** Callers announce transitions before the authoritative
  operation validates them, then maintain compensating state.
  **Assessment:** Look for an authoritative result or event. Intentional
  optimistic presentation can be legitimate; do not remove product behavior
  under the name of refactoring.
- **Lifecycle controlled by the wrong layer.**
  **Warning sign:** Short-lived consumers destroy shared resources, or replacing
  a dependency rebuilds unrelated state.
  **Assessment:** Separate resource lifetime from the lifetime of its current
  consumer. A consumer may appropriately own its own subscriptions or other
  exclusive resources.
- **Event ping-pong and competing schedulers.**
  **Warning sign:** Multiple queues, overlapping work loops, or callbacks back
  into the caller distribute one operation across owners.
  **Assessment:** Consolidate its ordering where appropriate; independent work
  and distinct endpoints do not automatically need a common queue.
- **Side effects hidden in queries or conversions.**
  **Warning sign:** Reading a getter or serializing a snapshot unexpectedly
  initiates work or publishes events.
  **Assessment:** Make effects explicit. Lazy loading can be reasonable when
  it is part of the contract.
- **Timing patches and defensive guards.**
  **Warning sign:** Sleeps, deferred microtasks, repeated reattachment, silent
  catches, or idempotency checks conceal incorrect call ownership.
  **Assessment:** Trace the cause. Necessary external retries and duplicate
  delivery handling are different from masking a duplicated internal call.
- **Boolean modes and calls that change meaning by context.**
  **Warning sign:** Predicting an operation's behavior requires knowledge of
  hidden state or combinations of flags.
  **Assessment:** Distinct domain operations or an explicit typed choice may
  make the contract smaller in practice.
- **Abstractions whose only job is to enable another abstraction.**
  **Warning sign:** Single-use factories, interfaces that mirror an entire class
  for mocks, or manager chains add more plumbing than isolation.
  **Assessment:** A small test seam or real replaceable implementation can
  justify an interface; hypothetical reuse alone cannot.
- **File extraction without reduced coupling.**
  **Warning sign:** New files still share internals, import each other, and
  require coordinated edits for ordinary changes.
  **Assessment:** Find a better ownership boundary or keep the code together.
  Vanilla relocation can be useful housekeeping without removing an
  architectural knot.
- **Tests that must reconstruct the whole application.**
  **Warning sign:** Testing a supposedly local invariant requires extensive
  setup and orchestration.
  **Assessment:** Investigate misplaced responsibilities before adding more
  mocks. True integration tests legitimately exercise several components together.

## Verify the Design and Preserve Existing Behavior

For new code, verify that the implementation satisfies the intended contracts,
including failure behavior and lifecycle boundaries. Exercise representative
operations through those APIs to check that callers can use them without
reaching into private state or reproducing internal coordination.

Refactoring preserves behavior unless a behavior change is part of the task.
That includes event ordering, batching, error propagation, persistence,
reconnect, shutdown, and late asynchronous completions, not just the happy-path
return value. Do not silently add a new policy or redesign a protocol to make
the refactor easier.

Bugs uncovered by the cleanup can be fixed alongside it when the evidence is
clear. Establish the root cause and required behavior before changing it.
A suspicious structure alone is not evidence of a behavioral bug.

Refactoring can also uncover suspicious or suboptimal behavior without proving
a bug. When reconsidering it could be worthwhile, propagate the finding to the
appropriate decision-making level: the broader task, the parent process that
delegated the work, or the user. Include the observed behavior, supporting
evidence, remaining uncertainty, and the possible change for consideration.
Keep that behavior unchanged while the question remains open, and continue
cleanup that does not depend on its resolution.

Test observable contracts. When refactoring, retain those tests and adapt
fixtures and calls when an internal API is deliberately removed, while
preserving the behavioral assertions. Do not rewrite expectations merely to
match changed behavior, or add tests that only mirror the new arrangement.
Exercise the affected failure and lifecycle paths, including reentrancy or stale
completions where those are relevant, and complete the applicable project checks.

Review the implementation for unnecessary machinery and verify that documentation
matches its contracts. Check whether ownership and caller obligations are as
small as the requirements allow, and whether tests verify their behavior. For a
refactor, also check which obligations disappeared and remove obsolete machinery
and temporary bridges.
Measure production-code line changes separately from tests, documentation, and
generated code so additions cannot hide behind deletions elsewhere. Evaluate
material growth against the complexity it removes.
Smaller APIs and fewer states make correctness easier to assess; they do not
prove the absence of bugs.
