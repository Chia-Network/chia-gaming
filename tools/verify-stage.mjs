// Framing verification for a staged deploy tree.
//
// Usage: node tools/verify-stage.mjs <stage-dir>
//
// Parses the staged index.html, extracts every asset-looking reference, and
// asserts each one resolves to a file in the stage. Absolute refs (e.g.
// /favicon.svg, /build-meta.json) resolve under the stage root; relative refs
// (index.js, index.css, ./chia_gaming_wasm.js) resolve under the runtime
// basePath read from build-meta.json. Exits non-zero if anything is missing.
//
// This catches framing rot and renamed entrypoints. Open-ended bundle content
// (images/, clsp/*.hex) is not referenced by index.html and is instead floor-
// checked by front-end/scripts/assemble-bundle.mjs.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const stage = process.argv[2];
if (!stage) {
  console.error("verify-stage: usage: node tools/verify-stage.mjs <stage-dir>");
  process.exit(2);
}
const STAGE = resolve(stage);

const indexHtml = join(STAGE, "index.html");
if (!existsSync(indexHtml)) {
  console.error(`verify-stage: missing index.html in ${STAGE}`);
  process.exit(1);
}

const metaPath = join(STAGE, "build-meta.json");
if (!existsSync(metaPath)) {
  console.error(`verify-stage: missing build-meta.json in ${STAGE}`);
  process.exit(1);
}
const basePath = JSON.parse(readFileSync(metaPath, "utf8")).basePath || "/";

const html = readFileSync(indexHtml, "utf8");

// Extract quoted strings that look like asset references (have a known
// extension). Covers href/src attributes as well as JS string literals.
const ASSET_RE = /["'`]([^"'`]+\.(?:js|mjs|css|svg|json|wasm|png|jpe?g|ico|woff2?|ttf|map))["'`]/g;
const refs = new Set();
for (const m of html.matchAll(ASSET_RE)) {
  refs.add(m[1]);
}

const stripBase = (p) => p.replace(/^\/+/, "");
const missing = [];

for (const ref of refs) {
  if (/^[a-z]+:\/\//i.test(ref) || ref.startsWith("data:")) {
    continue; // external / inline; not our file
  }
  let filePath;
  if (ref.startsWith("/")) {
    filePath = join(STAGE, stripBase(ref));
  } else {
    const rel = ref.replace(/^\.\//, "");
    filePath = join(STAGE, stripBase(basePath), rel);
  }
  if (!existsSync(filePath)) {
    missing.push(`${ref} -> ${filePath}`);
  }
}

if (missing.length) {
  console.error(
    `verify-stage: ${STAGE} references files that are not present:\n  - ${missing.join("\n  - ")}`,
  );
  process.exit(1);
}

console.log(`verify-stage: ok (${refs.size} refs) -> ${STAGE}`);
