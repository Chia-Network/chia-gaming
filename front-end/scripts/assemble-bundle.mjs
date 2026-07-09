// Assembles the deployable player-app bundle into front-end/dist/app.
//
// `build:deploy` has already emitted index.js / index.css there. This step
// adds the artifacts produced outside the front-end build (the wasm pair, plus
// the open-ended images/ and clsp/*.hex sets), then floor-checks the result so
// an incomplete bundle fails the build loudly instead of shipping silently.

import {
  cpSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(FE, "dist", "app");

// Where wasm-pack wrote chia_gaming_wasm.js / _bg.wasm, and where the compiled
// chialisp hex live. Defaults match tools/build-deploy.sh; overridable via env.
const WASM_OUT_DIR = process.env.WASM_OUT_DIR || join(FE, "dist");
const CLSP_DIR = process.env.CLSP_DIR || resolve(FE, "..", "clsp");

mkdirSync(APP, { recursive: true });

// Fixed wasm pair (a genuinely fixed 2-file set, so naming it is not fragile).
const WASM_FILES = ["chia_gaming_wasm.js", "chia_gaming_wasm_bg.wasm"];
for (const f of WASM_FILES) {
  const src = join(WASM_OUT_DIR, f);
  if (!existsSync(src)) {
    throw new Error(`assemble-bundle: wasm artifact not found: ${src}`);
  }
  copyFileSync(src, join(APP, f));
}

// Open-ended: copy the whole images dir verbatim.
const imagesSrc = join(FE, "public", "images");
if (existsSync(imagesSrc)) {
  cpSync(imagesSrc, join(APP, "images"), { recursive: true });
}

// Open-ended: copy every compiled clsp hex, preserving directory structure.
function copyHex(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      copyHex(p);
    } else if (p.endsWith(".hex")) {
      const dst = join(APP, "clsp", relative(CLSP_DIR, p));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(p, dst);
    }
  }
}
if (existsSync(CLSP_DIR)) {
  copyHex(CLSP_DIR);
}

// Floor checks: fail loudly if the bundle is incomplete.
const dirIsEmpty = (d) => !existsSync(d) || readdirSync(d).length === 0;
const errors = [];

for (const f of ["index.js", "index.css", ...WASM_FILES]) {
  if (!existsSync(join(APP, f))) {
    errors.push(`missing required file: ${f}`);
  }
}
if (dirIsEmpty(join(APP, "clsp"))) {
  errors.push("clsp/ is missing or empty (no compiled .hex)");
}
if (dirIsEmpty(join(APP, "images"))) {
  errors.push("images/ is missing or empty");
}

if (errors.length) {
  throw new Error(`assemble-bundle: incomplete bundle in ${APP}:\n  - ${errors.join("\n  - ")}`);
}

console.log(`assemble-bundle: ok -> ${APP}`);
