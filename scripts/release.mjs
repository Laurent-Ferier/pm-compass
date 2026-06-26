#!/usr/bin/env node
/**
 * Prepare a plugin release.
 *
 * Usage:  node scripts/release.mjs <version> [--dry-run]
 * Example: node scripts/release.mjs 0.2.0
 *          node scripts/release.mjs 0.2.0 --dry-run
 *
 * What it does:
 *  1. Validates the version is semver (X.Y.Z)
 *  2. Checks the git working tree is clean
 *  3. Checks the tag does not already exist
 *  4. Bumps version in manifest.json and packages/plugin/package.json
 *  5. Updates packages/plugin/versions.json (created on first run)
 *  6. Runs: typecheck → test → lint → build
 *  7. Commits the version bump and creates a git tag
 *  8. Copies main.js / manifest.json / styles.css to release/ and zips them
 *  9. Prints the push + GitHub release commands
 *
 * With --dry-run: skips steps 4, 7, 8 (no file writes, no git mutations, no zip).
 * With --force: skips the "already at this version" check and the version bump, goes
 *               straight to build → commit (if anything staged) → tag → package.
 *               Useful when a previous run was interrupted after the version bump.
 */

import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(root, "packages/plugin");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const force = process.argv.includes("--force") || process.argv.includes("-f");

function run(cmd, opts = {}) {
  console.log(`\n  > ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
}

function dryLog(msg) {
  console.log(`  [dry-run] ${msg}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate argument
// ---------------------------------------------------------------------------

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const version = args[0];

if (!version) {
  console.error("Usage: node scripts/release.mjs <version> [--dry-run]");
  console.error("Example: node scripts/release.mjs 0.2.0");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`"${version}" is not a valid semver version (expected X.Y.Z)`);
}

const tag = `v${version}`;

if (dryRun) console.log("\n[DRY RUN] No files will be written, no git mutations.\n");
if (force) console.log("\n[FORCE] Skipping version bump — assuming files are already at the target version.\n");

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
if (dirty && !dryRun) {
  fail("working tree has uncommitted changes — commit or stash first.");
}
if (dirty && dryRun) {
  console.log("  [dry-run] skipping dirty-tree check (uncommitted changes present).");
}

const existingTags = execSync("git tag", { cwd: root }).toString().split("\n");
if (existingTags.includes(tag)) {
  fail(`tag ${tag} already exists.`);
}

const currentVersion = readJson(resolve(pluginDir, "manifest.json")).version;
console.log(`Preparing release ${tag}  (current: ${currentVersion})`);

if (currentVersion === version && !force) {
  fail(
    `manifest.json is already at version ${version}. ` +
      `If a previous release run was interrupted after the version bump, ` +
      `re-run with --force to skip the bump and continue from build.`,
  );
}

// ---------------------------------------------------------------------------
// Bump versions
// ---------------------------------------------------------------------------

console.log("\nBumping versions…");

const manifest = readJson(resolve(pluginDir, "manifest.json"));
const versionsPath = resolve(pluginDir, "versions.json");
const versions = existsSync(versionsPath) ? readJson(versionsPath) : {};

if (force) {
  console.log("  [force] skipping version bump.");
} else if (dryRun) {
  dryLog(`would set manifest.json version: ${currentVersion} → ${version}`);
  dryLog(`would set package.json version: ${currentVersion} → ${version}`);
  dryLog(
    `would write versions.json: { ..., "${version}": "${manifest.minAppVersion}" }`,
  );
} else {
  manifest.version = version;
  writeJson(resolve(pluginDir, "manifest.json"), manifest);

  const pkgJson = readJson(resolve(pluginDir, "package.json"));
  pkgJson.version = version;
  writeJson(resolve(pluginDir, "package.json"), pkgJson);

  versions[version] = manifest.minAppVersion;
  writeJson(versionsPath, versions);
}

// ---------------------------------------------------------------------------
// Quality checks + build
// ---------------------------------------------------------------------------

console.log("\nRunning checks and build…");
run("pnpm typecheck");
run("pnpm test");
run("pnpm lint");
run("pnpm build");

// ---------------------------------------------------------------------------
// Commit + tag
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log("\nCommitting version bump…");
  dryLog(
    `would: git add packages/plugin/manifest.json packages/plugin/package.json packages/plugin/versions.json`,
  );
  dryLog(`would: git commit -m "chore: release ${tag}"`);
  dryLog(`would: git tag ${tag}`);
} else {
  console.log("\nCommitting version bump…");
  run(
    `git add packages/plugin/manifest.json packages/plugin/package.json packages/plugin/versions.json`,
  );
  const nothingToCommit = execSync("git diff --cached --quiet; echo $?", { cwd: root })
    .toString()
    .trim() === "0";
  if (nothingToCommit) {
    console.log("  (nothing to commit — version files already staged/committed, skipping)");
  } else {
    run(`git commit -m "chore: release ${tag}"`);
  }
  run(`git tag ${tag}`);
}

// ---------------------------------------------------------------------------
// Package artifacts
// ---------------------------------------------------------------------------

console.log("\nPackaging release artifacts…");

const releaseDir = resolve(root, "release");
if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true });
mkdirSync(releaseDir);

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(resolve(pluginDir, file), resolve(releaseDir, file));
}

const zipName = `pm-compass-${version}.zip`;
run(`zip -j ${zipName} main.js manifest.json styles.css`, { cwd: releaseDir });

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log(`
${dryRun ? "[DRY RUN] " : ""}Release ${tag} is ready.

   Artifacts: release/${zipName}

   Next steps:
     git push && git push origin ${tag}
     gh release create ${tag} release/${zipName} \\
       --title "PM Compass ${tag}" \\
       --notes ""
`);
