// Verify deploy archives produced by tools/build-deploy.sh.
//
// Usage: node tools/verify-deploy-archives.mjs [--platform=linux|macos]
//        node tools/verify-deploy-archives.mjs --release-version=X.Y.Z[-PRERELEASE]
//
// Discovers tgz/zip pairs in deploy_player_app/ and deploy_hub/, extracts
// each format, runs verify-stage + floor checks, compares tgz vs zip trees,
// and smoke-tests HTTP serving from the extracted player/hub trees.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_STAGE = join(ROOT, "tools", "verify-stage.mjs");

let platform = "";
let releaseVersion = "";
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--platform=")) {
    platform = arg.slice("--platform=".length);
  } else if (arg.startsWith("--release-version=")) {
    releaseVersion = arg.slice("--release-version=".length);
  } else {
    console.error(`verify-deploy-archives: unknown argument: ${arg}`);
    process.exit(2);
  }
}
if (platform && releaseVersion) {
  console.error("verify-deploy-archives: choose either --platform or --release-version");
  process.exit(2);
}
if (
  releaseVersion &&
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    releaseVersion,
  )
) {
  console.error(`verify-deploy-archives: invalid release version: ${releaseVersion}`);
  process.exit(2);
}

function fail(msg) {
  console.error(`verify-deploy-archives: ${msg}`);
  process.exit(1);
}

function playerPrefix() {
  if (releaseVersion) return `chia-gaming-${releaseVersion}`;
  return platform ? `chia-gaming-${platform}-` : "chia-gaming-";
}

function hubPrefix() {
  if (releaseVersion) return `chia-gaming-hub-${releaseVersion}`;
  return platform ? `chia-gaming-hub-${platform}-` : "chia-gaming-hub-";
}

function findOneArchive(dir, prefix, ext) {
  if (!existsSync(dir)) {
    fail(`directory not found: ${dir}`);
  }
  const matches = readdirSync(dir)
    .filter((f) =>
      releaseVersion ? f === `${prefix}${ext}` : f.startsWith(prefix) && f.endsWith(ext),
    )
    .sort();
  if (matches.length === 0) {
    fail(`no ${prefix}*${ext} in ${dir}`);
  }
  if (matches.length > 1) {
    fail(`ambiguous ${prefix}*${ext} in ${dir}: ${matches.join(", ")}`);
  }
  return join(dir, matches[0]);
}

function extractArchive(archive, dest) {
  if (archive.endsWith(".tgz")) {
    execFileSync("tar", ["-xzf", archive, "-C", dest], { stdio: "inherit" });
  } else if (archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive, "-d", dest], { stdio: "inherit" });
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

function dirHasClvmBinaries(dir) {
  if (!existsSync(dir)) return false;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (p.endsWith(".clvm.bin")) {
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
  for (const f of ["index.html", "oauth/callback/index.html", "build-meta.json", "static-server.js"]) {
    if (!existsSync(join(stageDir, f))) {
      errors.push(`missing ${f}`);
    }
  }
  const nonceDir = resolveNonceDir(stageDir);
  for (const f of [
    "index.js",
    "index.css",
    "favicon.svg",
    "chia_gaming_wasm.js",
    "chia_gaming_wasm_bg.wasm",
  ]) {
    if (!existsSync(join(nonceDir, f))) {
      errors.push(`missing app bundle file: ${f}`);
    }
  }
  if (!dirHasClvmBinaries(join(nonceDir, "clsp"))) {
    errors.push("clsp/ is missing or has no binary CLVM files");
  }
  if (!dirHasClvmBinaries(join(nonceDir, "games"))) {
    errors.push("games/ is missing or has no binary CLVM files");
  }
  if (!dirIsNonempty(join(nonceDir, "images"))) {
    errors.push("images/ is missing or empty");
  }
  if (errors.length) {
    fail(`player floor check failed for ${stageDir}:\n  - ${errors.join("\n  - ")}`);
  }
}

function floorCheckHub(stageDir) {
  const errors = [];
  for (const f of ["index.html", "build-meta.json", "service.js"]) {
    if (!existsSync(join(stageDir, f))) {
      errors.push(`missing ${f}`);
    }
  }
  const nonceDir = resolveNonceDir(stageDir);
  for (const f of ["index.js", "index.css", "favicon.svg"]) {
    if (!existsSync(join(nonceDir, f))) {
      errors.push(`missing app bundle file: ${f}`);
    }
  }
  if (errors.length) {
    fail(`hub floor check failed for ${stageDir}:\n  - ${errors.join("\n  - ")}`);
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

async function smokeTestPlayer(stageDir, subdirectory = false) {
  const port = await freePort();
  const host = "127.0.0.1";
  const serverJs = join(stageDir, "static-server.js");
  const child = spawn(process.execPath, [serverJs, subdirectory ? dirname(stageDir) : stageDir, String(port), host], {
    cwd: stageDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const base = `http://${host}:${port}${subdirectory ? "/" + basename(stageDir) : ""}`;
    await waitForHttp(`${base}/`);

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok) fail(`player GET / -> ${indexRes.status}`);
    const ct = indexRes.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      fail(`player GET / content-type: ${ct}`);
    }

    const callback = await fetch(`${base}/oauth/callback?code=test&state=test`);
    if (!callback.ok || new URL(callback.url).search !== "?code=test&state=test") {
      fail("player OAuth callback did not preserve its query through directory redirect");
    }
    if ((await callback.text()) !== readFileSync(join(stageDir, "index.html"), "utf8")) {
      fail("player OAuth callback did not serve the player entrypoint");
    }

    const metaRes = await fetch(`${base}/build-meta.json`);
    if (!metaRes.ok) fail(`player GET /build-meta.json -> ${metaRes.status}`);
    const meta = await metaRes.json();
    const basePath = meta.basePath || "/";

    for (const asset of ["index.js", "index.css", "favicon.svg", "chia_gaming_wasm_bg.wasm"]) {
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

async function smokeTestHub(stageDir, mountPath = "") {
  const port = await freePort();
  const host = "127.0.0.1";
  const child = spawn(
    process.execPath,
    ["service.js", "--self", `http://${host}:${port}${mountPath}`, "--dir", "."],
    {
      cwd: stageDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const base = `http://${host}:${port}${mountPath}`;
    await waitForHttp(`${base}/`);

    const indexRes = await fetch(`${base}/`);
    if (!indexRes.ok) fail(`hub GET / -> ${indexRes.status}`);

    const metaRes = await fetch(`${base}/build-meta.json`);
    if (!metaRes.ok) fail(`hub GET /build-meta.json -> ${metaRes.status}`);
    const meta = await metaRes.json();
    const basePath = meta.basePath || "/";

    for (const asset of ["index.js", "index.css", "favicon.svg"]) {
      const url = `${base}${basePath}${asset}`;
      const res = await fetch(url);
      if (!res.ok) fail(`hub GET ${url} -> ${res.status}`);
    }
    console.log(`verify-deploy-archives: hub HTTP smoke ok (port ${port})`);
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
    floorCheckHub(stageDir);
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
      await smokeTestPlayer(tgzDir, true);
    } else {
      await smokeTestHub(tgzDir);
      await smokeTestHub(tgzDir, "/hubs/beta");
    }

    console.log(`verify-deploy-archives: ${label} ok`);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

async function smokeTestProductionRunner(playerStage, hubStage, playerPath, hubPath) {
  const gamePort = await freePort();
  const hubPort = await freePort();
  const child = spawn("bash", [join(ROOT, "tools", "run-production.sh")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PUBLIC_HOST: "localhost",
      GAME_PORT: String(gamePort),
      HUB_PORT: String(hubPort),
      PLAYER_STAGE: playerStage,
      HUB_STAGE: hubStage,
      PLAYER_PATH: playerPath,
      HUB_PATH: hubPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const player = `http://127.0.0.1:${gamePort}${playerPath}`;
  const hub = `http://127.0.0.1:${hubPort}${hubPath}`;
  try {
    await waitForHttp(player + "/");
    await waitForHttp(hub + "/");
    for (const [url, stage] of [[player, playerStage], [hub, hubStage]]) {
      const metaResponse = await fetch(url + "/build-meta.json");
      if (metaResponse.headers.get("cache-control") !== "no-store") fail("metadata must not be cached");
      const meta = await metaResponse.json();
      for (const asset of ["index.js", "index.css", "favicon.svg"]) {
        const response = await fetch(url + meta.basePath + asset);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!response.ok || !bytes.equals(readFileSync(join(stage, meta.basePath, asset)))) {
          fail(`production runner asset mismatch: ${url}/${asset}`);
        }
        if (!response.headers.get("cache-control")?.includes("immutable")) {
          fail("nonce assets must be immutable under a mount");
        }
      }
    }
    const callback = await fetch(player + "/oauth/callback?code=test", { redirect: "manual" });
    if (callback.headers.get("location") !== playerPath + "/oauth/callback/?code=test") {
      fail("mounted OAuth callback redirect lost its path or query");
    }
    const redirect = await fetch(hub + "/", {
      headers: { "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    if (redirect.headers.get("location") !== `http://localhost:${gamePort}${playerPath}/`) {
      fail("hub redirect must use PUBLIC_HOST and PLAYER_PATH");
    }
    if (playerPath) {
      const slash = await fetch(player + "?test=1", { redirect: "manual" });
      if (slash.headers.get("location") !== playerPath + "/?test=1") fail("missing mount slash redirect");
      if ((await fetch(player + "-other/index.html")).status !== 404) fail("player mount leaked");
      if ((await fetch(`http://127.0.0.1:${gamePort}/build-meta.json`)).status !== 404) {
        fail("player must not serve outside its mount");
      }
    }
    console.log(`verify-deploy-archives: run-production ok (${playerPath || "/"}, ${hubPath || "/"})`);
  } finally {
    await new Promise((resolveExit, reject) => {
      if (child.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => reject(new Error("run-production did not shut down")), 15000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(); });
      child.kill("SIGTERM");
    });
  }
}

async function main() {
  const playerDir = join(ROOT, "deploy_player_app");
  const hubDir = join(ROOT, "deploy_hub");

  const playerTgz = findOneArchive(playerDir, playerPrefix(), ".tgz");
  const playerZip = findOneArchive(playerDir, playerPrefix(), ".zip");
  const hubTgz = findOneArchive(hubDir, hubPrefix(), ".tgz");
  const hubZip = findOneArchive(hubDir, hubPrefix(), ".zip");

  console.log("verify-deploy-archives: archives:");
  console.log(`  player tgz: ${playerTgz}`);
  console.log(`  player zip: ${playerZip}`);
  console.log(`  hub  tgz: ${hubTgz}`);
  console.log(`  hub  zip: ${hubZip}`);

  await verifyArtifactPair({
    label: "player app",
    kind: "player",
    tgz: playerTgz,
    zip: playerZip,
  });
  await verifyArtifactPair({
    label: "hub",
    kind: "hub",
    tgz: hubTgz,
    zip: hubZip,
  });

  const runnerStage = mkdtempSync(join(tmpdir(), "verify-production-runner-"));
  try {
    const player = join(runnerStage, "player");
    const hub = join(runnerStage, "hub");
    mkdirSync(player);
    mkdirSync(hub);
    extractArchive(playerTgz, player);
    extractArchive(hubTgz, hub);
    await smokeTestProductionRunner(player, hub, "", "");
    await smokeTestProductionRunner(player, hub, "/testing/player", "/testing/hub");
    const invalid = spawnSync("bash", [join(ROOT, "tools", "run-production.sh")], {
      env: { ...process.env, PLAYER_PATH: "../player" },
      encoding: "utf8",
    });
    if (invalid.status === 0 || !invalid.stderr.includes("Mount paths must")) {
      fail("run-production must reject a relative mount path");
    }
  } finally {
    rmSync(runnerStage, { recursive: true, force: true });
  }

  console.log("verify-deploy-archives: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
