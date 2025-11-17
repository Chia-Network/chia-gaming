# Tailwind Theme Tokens

This project exposes the design system variables (from DesignRift) as CSS variables and maps them into Tailwind's `colors` via `tailwind.config.cjs`.

Available groups and example tokens (use as `bg-<group>-<token>` or `text-<group>-<token>`):

- `canvas`: `base`, `bg-subtle`, `bg`, `bg-hover`, `bg-active`, `line`, `border`, `border-hover`, `solid`, `solid-hover`, `text`, `text-contrast`, `on-canvas`
- `primary`: `base`, `bg-subtle`, `bg`, `bg-hover`, `bg-active`, `line`, `border`, `border-hover`, `solid`, `solid-hover`, `text`, `text-contrast`, `on-primary`
- `secondary`: same tokens as `primary` (prefix `secondary-...`)
- `success`, `warning`, `alert`, `info`: same token set as above

Examples

- Background using primary background: `bg-primary-bg`
- Text using primary text color: `text-primary-text`
- Border using canvas border: `border-canvas-border`
- Hover state (inline style or Tailwind `hover:` with custom utilities):
  - You can use `hover:[background:var(--color-primary-bg-hover)]` in Tailwind v3+ JIT, or create utility classes.

Usage notes

- Dark mode: add the `.dark` class to the document root (e.g. `<html class="dark">`) to switch the theme variables to the dark palette.
- These color tokens map directly to CSS variables defined in `src/index.css`.
- If you want shorthand tokens (e.g. `bg-primary` -> `bg-primary-bg`) we can add aliases to `tailwind.config.cjs`.

Quick check

Run the build to regenerate CSS after changes:

```powershell
cd resources\gaming-fe
yarn build
```
