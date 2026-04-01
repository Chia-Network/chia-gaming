# Code Health Audit

This document tracks dead code, likely bugs, and high-risk patterns found during
manual audits. Entries are evidence-first and intended for one-by-one review.

## Status Legend

- `open`: found, not yet triaged
- `confirmed`: validated issue, pending fix
- `false-positive`: investigated, not an issue
- `fixed`: resolved in code
- `deferred`: accepted for later

## Severity Legend

- `Critical`: likely loss/corruption/security issue
- `High`: likely behavioral bug in normal operation
- `Medium`: concrete correctness or maintainability risk
- `Low`: cleanup/safety improvement with low immediate impact
- `Needs Verification`: plausible issue that needs intent confirmation

## Entry Template

### AUD-XXX: <short title>

- **Status:** `<open|confirmed|false-positive|fixed|deferred>`
- **Severity:** `<Critical|High|Medium|Low|Needs Verification>`
- **Category:** `<dead-code|state-machine|error-path|performance|other>`
- **Symptom:** What looks wrong.
- **Evidence:** File/symbol references.
- **Impact:** Why this matters.
- **Confidence:** `<high|medium|low>`
- **Repro/Check:** How to validate quickly.
- **Fix Options:** 1-2 practical options.
- **Decision:** Filled during review.

---

## Current Findings

### AUD-001: `initiated_on_chain` appears dead

- **Status:** `fixed`
- **Severity:** `Medium`
- **Category:** `dead-code`
- **Symptom:** `ChannelHandler::initiated_on_chain` is declared and has accessor
  methods, but no runtime callsites read or set it.
- **Evidence:** `src/channel_handler/mod.rs` (`initiated_on_chain` field,
  `initiated_on_chain()`, `set_initiated_on_chain()`).
- **Impact:** Dead state flag increases cognitive load and can mislead future
  maintenance/audits.
- **Confidence:** `high`
- **Repro/Check:** Search callsites for `initiated_on_chain` and
  `set_initiated_on_chain`.
- **Fix Options:**
  1. Remove field and both methods.
  2. If still intended, add real callsites and tests documenting behavior.
- **Decision:** Removed field and accessors from `ChannelHandler`.

### AUD-002: `on_chain_for_error` appears write-only dead state

- **Status:** `fixed`
- **Severity:** `Medium`
- **Category:** `dead-code`
- **Symptom:** `on_chain_for_error` is set via `set_on_chain_for_error()`
  during `go_on_chain(got_error=true)` but never read.
- **Evidence:** `src/channel_handler/mod.rs` (`on_chain_for_error` field,
  `set_on_chain_for_error()`), `src/potato_handler/mod.rs` (`go_on_chain`).
- **Impact:** Stale field suggests behavior that no longer exists and can hide
  true error-propagation paths.
- **Confidence:** `high`
- **Repro/Check:** Search callsites for `on_chain_for_error`.
- **Fix Options:**
  1. Remove field and setter.
  2. If intended for UI/advisory behavior, wire explicit read path and tests.
- **Decision:** Removed field/setter and removed `go_on_chain(got_error)` setter callsite.

### AUD-003: Guarded `unwrap()` in proposal accept path

- **Status:** `open`
- **Severity:** `Low`
- **Category:** `error-path`
- **Symptom:** `proposal.unwrap()` is currently guarded by `is_none()` in the
  same block, so safe today but brittle under refactors.
- **Evidence:** `src/potato_handler/mod.rs` in `QueuedAcceptProposal` handling.
- **Impact:** Low immediate risk, but fragile style in protocol-critical path.
- **Confidence:** `high`
- **Repro/Check:** Inspect control flow around `find_proposal`.
- **Fix Options:**
  1. Replace with `let Some(proposal) = ... else { ... };`.
  2. Keep as-is with comment about invariant (less preferred).
- **Decision:** pending

---

## State-Machine Pass (peer/container/potato)

Reviewed:
- `src/peer_container.rs`
- `src/potato_handler/mod.rs`
- `src/potato_handler/on_chain.rs`
- `src/potato_handler/unroll_watch_handler.rs`
- `src/potato_handler/shutdown_handler.rs`
- `src/channel_handler/mod.rs`

### Observations

1. **Peer disconnect gating is intentional and consistently applied**
   (`send_message` and `deliver_message` no-op when disconnected).
2. **On-chain action queue draining behavior is coherent** (`OnChainGameHandler`
   processes from `game_action_queue` via `next_action`).
3. **No clear action-loss bug found** in current queue/transition paths.

### AUD-004: Status re-emission policy may hide advisory/coin updates outside `Active`

- **Status:** `false-positive`
- **Severity:** `Needs Verification`
- **Category:** `state-machine`
- **Symptom:** `should_emit_status` only re-emits same-state updates in
  `ChannelState::Active`; same-state changes in other states are suppressed.
- **Evidence:** `src/peer_container.rs` (`should_emit_status`,
  `emit_channel_status_if_changed`).
- **Impact:** Possible UI observability gap if product expects advisory/coin
  refreshes during `Unrolling`/terminal states.
- **Confidence:** `medium`
- **Repro/Check:** Simulate same-state advisory changes outside `Active` and
  inspect emitted `ChannelStatus`.
- **Fix Options:**
  1. Keep behavior and document "only Active repeats".
  2. Emit on advisory/coin deltas in selected non-Active states.
- **Decision:** Current behavior is appropriate. Repeated `Active` emissions are used for balance/allocation refreshes; suppressing same-state re-emits outside `Active` is intentional.

---

## Error-Path Robustness Pass

Scope: runtime (non-test) `panic!/unwrap/expect` in hot protocol modules.

### Findings

- No non-test `panic!` found in `peer_container`, `potato_handler`,
  `channel_handler`, `referee` core runtime flow.
- Runtime `expect(...)` appears in handshake transition internals where
  invariant is checked immediately before use (`has_channel_coin` guard).
- One runtime `unwrap()` noted in `PotatoHandler` (AUD-003).

### AUD-005: Handshake `expect(...)` under checked invariant

- **Status:** `open`
- **Severity:** `Low`
- **Category:** `error-path`
- **Symptom:** `expect("has_channel_coin was true")` in initiator/receiver
  handshake `coin_created` handlers.
- **Evidence:** `src/potato_handler/handshake_initiator.rs`,
  `src/potato_handler/handshake_receiver.rs`.
- **Impact:** Likely safe now; panic risk if future refactor separates guard and
  dereference.
- **Confidence:** `medium`
- **Repro/Check:** Review guard + dereference locality in both handlers.
- **Fix Options:**
  1. Replace `expect` with explicit `ok_or_else(...)` propagation.
  2. Keep current pattern and add invariant comment/tests.
- **Decision:** pending

---

## Prioritized Remediation Plan

## 1) Low-risk cleanup (do first)

1. Remove confirmed dead fields/state:
   - `initiated_on_chain`
   - `on_chain_for_error`
2. Replace guarded `unwrap()` in proposal acceptance with exhaustive matching.
3. Optionally replace handshake `expect(...)` with error returns for defensive
   robustness.

### Test coverage for step 1

- Existing integration suite via `./ct.sh` should remain green.
- Targeted checks:
  - handshake completion paths (initiator + receiver)
  - go-on-chain-from-error path
  - proposal accept/cancel flows

## 2) Behavior decision (needs product intent)

4. Decide whether non-`Active` `ChannelStatus` re-emissions should include
   advisory/coin deltas (AUD-004).

### Test coverage for step 2

- Add/adjust notification assertions in simulator integration tests to codify
  chosen behavior.

## 3) Rollout order

1. Dead code removal (`AUD-001`, `AUD-002`)
2. `unwrap` cleanup (`AUD-003`)
3. Handshake `expect` hardening (`AUD-005`)
4. Optional notification emission policy change (`AUD-004`)

---

## Review Workflow (one finding at a time)

1. Pick highest-priority `open`/`confirmed` item.
2. Confirm intended behavior and choose fix option.
3. Implement smallest safe change.
4. Run focused tests, then full `./ct.sh`.
5. Mark item `fixed` or `deferred` with rationale.
