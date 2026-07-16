// Verify deploy archives produced by tools/build-deploy.sh.
//
// Usage: node tools/verify-deploy-archives.mjs [--platform=linux|macos|windows]
//
// Discovers tgz/zip pairs in deploy_player_app/ and deploy_tracker/, extracts
// each format, runs verify-stage + floor checks, compares tgz vs zip trees,
// and smoke-tests HTTP serving from the extracted player/lobby trees.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_STAGE = join(ROOT, "tools", "verify-stage.mjs");

let platform = "";
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--platform=")) {
    platform = arg.slice("--platform=".length);
  } else {
    console.error(`verify-deploy-archives: unknown argument: ${arg}`);
    process.exit(2);
  }
}

function fail(msg) {
  console.error(`verify-deploy-archives: ${msg}`);
  process.exit(1);
}

function playerPrefix() {
  return platform ? `chia-gaming-${platform}-` : "chia-gaming-";
}

function lobbyPrefix() {
  return platform ? `chia-gaming-lobby-${platform}-` : "chia-gaming-lobby-";
}

function findOneArchive(dir, prefix, ext) {
  if (!existsSync(dir)) {
    fail(`directory not found: ${dir}`);
  }
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort();
  if (matches.length === 0) {
    fail(`no ${prefix}*${ext} in ${dir}`);
  }
  if (matches.length > 1) {
    fail(`ambiguous ${prefix}*${ext} in ${dir}: ${matches.join(", ")}`);
  }
  return join(dir, matches[0]);
}

// On Windows, use the built-in bsdtar explicitly: it handles drive-letter
// paths (Git Bash's GNU tar treats `C:` as a remote host) and extracts zip
// archives too, so no `unzip` is needed.
const WINDOWS_TAR = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "tar.exe",
);

function extractArchive(archive, dest) {
  if (archive.endsWith(".tgz")) {
    const tar = process.platform === "win32" ? WINDOWS_TAR : "tar";
    execFileSync(tar, ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  } else if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      execFileSync(WINDOWS_TAR, ["-xf", archive, "-C", dest], {
        stdio: "inherit",
      });
    } else {
      execFileSync("unzip", ["-q", archive, "-d", dest], { stdio: "inherit" });
    }
  } else {
    fail(`unsupported archive: ${archive}`);
  }
}

function runVerifyStage(stageDir) {
  const r = spawnSync(process.execPath, [VERIFY_STAGE, stageDir], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    fail(`verify-stage failed for ${stageDir}`);
  }
}

function readBasePath(stageDir) {
  const meta = JSON.parse(
    readFileSync(join(stageDir, "build-meta.json"), "utf8"),
  );
  const basePath = meta.basePath || "/";
  return basePath.startsWith("/") ? basePath : `/${basePath}`;
}

function resolveNonceDir(stageDir) {
  const basePath = readBasePath(stageDir);
  const nonceDir = join(stageDir, basePath.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!existsSync(nonceDir)) {
    fail(`nonce dir missing: ${nonceDir}`);
  }
  return nonceDir;
}

function dirHasHexFiles(dir) {
  if (!existsSync(dir)) return false;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (p.endsWith(".hex")) {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}

function dirIsNonempty(dir) {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function floorCheckPlayer(stageDir) {
  const errors = [];
  for (const f of ["index.html", "build-meta.json", "static-server.js"]) {
    if (!existsSync(join(stageDir, f))) {
      errors.push(`missing ${f}`);
    }
  }
  const nonceDir = resolveNonceDir(stageDir);
  for (const f of [
    "index.js",
    "index.css",
    "chia_gaming_wasm.js",
    "chia_gaming_wasm_bg.wasm",
  ]) {
    if (!existsSync(join(nonceDir, f))) {
      errors.push(`missing app bundle file: ${f}`);
    }
  }
  if (!dirHasHexFiles(join(nonceDir, "clsp"))) {
    errors.push("clsp/ is missing or has no .hex files");
  }
  if (!dirIsNonempty(join(nonceDir, "images"))) {
    errors.push("images/ is missing or empty");
  }
  if (errors.length) {
    fail(`player floor check failed for ${stageDir}:\n  - ${errors.join("\n  - ")}`);
  }
}

function floorCheckLobby(stageDir) {
  const errors = [];
  for (const f of ["index.html", "build-meta.json", "service.js"]) {
    if (!existsSync(join(stageDir, f))) {
      errors.push(`missing ${f}`);
    }
  }
  const nonceDir = resolveNonceDir(stageDir);
  for (const f of ["index.js", "index.css"]) {
    if (!existsSync(join(nonceDir, f))) {
      errors.push(`missing app bundle file: ${f}`);
    }
  }
  if (errors.length) {
    fail(`lobby floor check failed for ${stageDir}:\n  - ${errors.join("\n  - ")}`);
  }
}

function fileTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else {
        const rel = relative(root, p);
        files.set(rel, statSync(p).size);
      }
    }
  };
  walk(root);
  return files;
}

function compareTrees(dirA, dirB, label) {
  const treeA = fileTree(dirA);
  const treeB = fileTree(dirB);
  const allPaths = new Set([...treeA.keys(), ...treeB.keys()]);
  const mismatches = [];
  for (const p of [...allPaths].sort()) {
    const a = treeA.get(p);
    const b = treeB.get(p);
    if (a === undefined) {
      mismatches.push(`only in zip: ${p}`);
    } else if (b === undefined) {
      mismatches.push(`only in tgz: ${p}`);
    } else if (a !== b) {
      mismatches.push(`size mismatch for ${p}: tgz=${a} zip=${b}`);
    }
  }
  if (mismatches.length) {
    fail(`${label} tgz/zip parity failed:\n  - ${mismatches.join("\n  - ")}`);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`server not ready: ${url}`);
}

async function killServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (!child.killed) {
    child.kill("SIGKILL");
  }
}

async function smokeTestPlayer(stageDir) {
  const port = await freePort();
  const host = "127.0.0.1";
  const serverJs = join(stageDir, "static-server.js");
  const child = spawn(process.execPath, [serverJs, ".", String(port), host], {
    cwd: stageDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const base = `http://${host}:${port}`;
    await waitForHttp(`${base}/`);

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok) fail(`player GET / -> ${indexRes.status}`);
    const ct = indexRes.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      fail(`player GET / content-type: ${ct}`);
    }

    const metaRes = await fetch(`${base}/build-meta.json`);
    if (!metaRes.ok) fail(`player GET /build-meta.json -> ${metaRes.status}`);
    const meta = await metaRes.json();
    const basePath = meta.basePath || "/";

    for (const asset of ["index.js", "index.css", "chia_gaming_wasm_bg.wasm"]) {
      const url = `${base}${basePath}${asset}`;
      const res = await fetch(url);
      if (!res.ok) fail(`player GET ${url} -> ${res.status}`);
      if (asset.endsWith(".wasm")) {
        const wasmCt = res.headers.get("content-type") || "";
        if (!wasmCt.includes("application/wasm")) {
          fail(`player wasm content-type: ${wasmCt}`);
        }
      }
    }
    console.log(`verify-deploy-archives: player HTTP smoke ok (port ${port})`);
  } finally {
    await killServer(child);
  }
}

async function smokeTestLobby(stageDir) {
  const port = await freePort();
  const host = "127.0.0.1";
  const child = spawn(
    process.execPath,
    ["service.js", "--self", `http://${host}:${port}`, "--dir", "."],
    {
      cwd: stageDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const base = `http://${host}:${port}`;
    await waitForHttp(`${base}/`);

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok) fail(`lobby GET / -> ${indexRes.status}`);

    const metaRes = await fetch(`${base}/build-meta.json`);
    if (!metaRes.ok) fail(`lobby GET /build-meta.json -> ${metaRes.status}`);
    const meta = await metaRes.json();
    const basePath = meta.basePath || "/";

    for (const asset of ["index.js", "index.css"]) {
      const url = `${base}${basePath}${asset}`;
      const res = await fetch(url);
      if (!res.ok) fail(`lobby GET ${url} -> ${res.status}`);
    }
    console.log(`verify-deploy-archives: lobby HTTP smoke ok (port ${port})`);
  } finally {
    await killServer(child);
  }
}

function verifyExtracted(stageDir, kind, format) {
  console.log(`verify-deploy-archives: ${kind} (${format}) -> ${stageDir}`);
  runVerifyStage(stageDir);
  if (kind === "player") {
    floorCheckPlayer(stageDir);
  } else {
    floorCheckLobby(stageDir);
  }
}

async function verifyArtifactPair({ label, kind, tgz, zip }) {
  const tmpBase = mkdtempSync(join(tmpdir(), "verify-deploy-"));
  const tgzDir = join(tmpBase, "tgz");
  const zipDir = join(tmpBase, "zip");
  mkdirSync(tgzDir, { recursive: true });
  mkdirSync(zipDir, { recursive: true });
  try {
    extractArchive(tgz, tgzDir);
    extractArchive(zip, zipDir);

    verifyExtracted(tgzDir, kind, "tgz");
    verifyExtracted(zipDir, kind, "zip");
    compareTrees(tgzDir, zipDir, label);

    if (kind === "player") {
      await smokeTestPlayer(tgzDir);
    } else {
      await smokeTestLobby(tgzDir);
    }

    console.log(`verify-deploy-archives: ${label} ok`);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

async function main() {
  const playerDir = join(ROOT, "deploy_player_app");
  const lobbyDir = join(ROOT, "deploy_tracker");

  const playerTgz = findOneArchive(playerDir, playerPrefix(), ".tgz");
  const playerZip = findOneArchive(playerDir, playerPrefix(), ".zip");
  const lobbyTgz = findOneArchive(lobbyDir, lobbyPrefix(), ".tgz");
  const lobbyZip = findOneArchive(lobbyDir, lobbyPrefix(), ".zip");

  console.log("verify-deploy-archives: archives:");
  console.log(`  player tgz: ${playerTgz}`);
  console.log(`  player zip: ${playerZip}`);
  console.log(`  lobby  tgz: ${lobbyTgz}`);
  console.log(`  lobby  zip: ${lobbyZip}`);

  await verifyArtifactPair({
    label: "player app",
    kind: "player",
    tgz: playerTgz,
    zip: playerZip,
  });
  await verifyArtifactPair({
    label: "lobby",
    kind: "lobby",
    tgz: lobbyTgz,
    zip: lobbyZip,
  });

  console.log("verify-deploy-archives: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
