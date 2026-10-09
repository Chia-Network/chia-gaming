# Repository agent instructions

These instructions apply throughout this repository. Maintain shared rules here
so Codex, Cursor, and other agents that support `AGENTS.md` use the same source.
`CLAUDE.md` imports this file for Claude Code compatibility. Cursor's Bugbot
review instructions remain in `.cursor/BUGBOT.md`.

## Required debugging skills

For bug fixes, failing tests, stalls, hangs, or unexpected behavior, read and
follow both shared skills before investigating or changing code:

- [Debugging techniques](.agents/skills/debugging/SKILL.md)
- [Debugging delegation](.agents/skills/debugging-delegation/SKILL.md)

The delegation skill permits a direct fix when tracing yields a confident
diagnosis; otherwise delegate as it describes. Use the equivalent delegation
tools supported by your agent. If delegation is unavailable, follow the same
structured diagnosis directly and state that limitation. Provide both skills
to debugging sub-agents; do not assume they inherit the parent's instructions.

These skills are required for debugging even if your agent does not automatically
discover `.agents/skills/`. Read the linked files directly in that case.

---

# Read Project Overview First

At the start of each conversation, read `OVERVIEW.md` in full before diving
into the task. It provides the conceptual foundation and links to detailed
docs. Read the linked docs as they become relevant to the task at hand.

**Build/test commands:** Use `./cb.sh` for builds, `./ct.sh` for targeted or
interactive test runs, and `./ct-automation.sh` for automated/LLM full-suite
runs. Never use `cargo test` directly.

---

# Use git for file operations

When adding, removing, or moving files in this repo, always use git commands:

- **Remove files:** `git rm <path>` (not `rm` or the Delete tool)
- **Move/rename files:** `git mv <old> <new>` (not `mv`)
- **Add new files:** create the file, then `git add <path>`

This keeps the index in sync and avoids forgetting to stage changes.

---

# Unreleased app formats and deployed compatibility

No player app or hub persistence format has been released. Keep explicit
browser envelope versions, WASM cradle schemas, IndexedDB upgrade boundaries,
and peer capability hooks so future released formats have centralized migration
and negotiation points.

For unreleased app-owned persistence and internal schemas:
- Advance the relevant version only when preparing a release that changes the
  format. Do not bump versions for individual changes during development.
- Decode only the current format unless a released predecessor explicitly
  requires migration.
- Do not add migrations, fallback decoders, aliases, dual reads, or
  compatibility-only serde defaults for formats that never shipped.
- Keep the current encoder and decoder symmetric: data written by this build
  must round-trip and restore in this build.

This policy does not relax compatibility with deployed external contracts.
Preserve wallet RPC and simulator JSON behavior, Chia offer compression
dictionaries and bech32 handling, on-chain and peer protocol behavior, and
historical signed-unroll recognition. Treat changes to those contracts as
compatibility-sensitive even while app-owned save formats remain unreleased.

---

# Karpathy behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
