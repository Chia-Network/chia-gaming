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

## Required modularization skill

For initial architecture and API design, modularization, or refactoring ownership
and module boundaries, read and follow
[Architecture, Modularization, and API Design](.agents/skills/modularization/SKILL.md).
Read it directly if your agent does not discover repository skills. It guides
the requested work; it does not authorize unrelated architectural changes.

---

# Read Project Overview First

At the start of each conversation, read `OVERVIEW.md` in full before diving
into the task. It provides the conceptual foundation and links to detailed
docs. Read the linked docs as they become relevant to the task at hand.

Before reading, reviewing, or editing Chialisp (`.clsp` / `.clinc`), read
[Shapes and pack](clsp/std/shapes.md). It explains the construction, invocation,
dispatch, and field-access macros used throughout the referee and games,
including their compile-time checks and runtime assumptions.

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

# shadcn components come from the CLI

Never hand-write shadcn/ui components. Add or update them with the CLI from
`front-end/`: `pnpm dlx shadcn@latest add <component>` (`--overwrite` to
update). Keep the generated code as-is apart from Prettier formatting. Theme
them by mapping shadcn tokens (`input`, `ring`, `primary`, ...) to the app
palette in the `@theme` block of `front-end/src/index.css`, and adjust usage
through `className` or `data-slot` selectors at the call site.

Verify every icon, logo, and colored UI element against both light and dark
themes before handing it off. Brand marks with light colors (like the lime Chia
leaf) need a backing tile or a theme-specific variant to keep contrast.

When a field takes free-form input but should also offer presets (hub URLs,
amounts), use one editable field with suggestions (Base UI `Autocomplete`), not
a select with a "Custom…" option that reveals a second input.

---

# Early-release compatibility and versioning

During early deployment, releases may break compatibility with earlier peer
protocol and app-owned persistence formats. Revisit this policy when the project
moves to stable releases. Keep explicit browser envelope versions, WASM cradle
schemas, IndexedDB upgrade boundaries, and peer capability hooks for migration
and negotiation.

- Leave the peer protocol version unchanged throughout development. If the
  release breaks peer compatibility, bump the protocol version as one of the
  final changes immediately before publishing the release.
- Advance app-owned format versions during release preparation when the release
  changes those formats. Decode only the current format unless the release
  explicitly requires migration from a supported predecessor.
- Keep encoders and decoders symmetric so data written by a build round-trips
  and restores in that build.

Preserve deployed external contracts, including wallet RPC and simulator JSON
behavior, Chia offer compression dictionaries and bech32 handling, on-chain
protocol behavior, and historical signed-unroll recognition.
