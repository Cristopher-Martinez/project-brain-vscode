#!/usr/bin/env node
/**
 * sync-hooks.mjs — Synchronize .github/hooks/scripts/ → static/hooks/scripts/
 *
 * Source of truth: .github/hooks/scripts/ (active in this repo)
 * Target: static/hooks/scripts/ (template shipped with extension)
 *
 * Usage: node scripts/sync-hooks.mjs [--dry-run]
 *
 * @since 2026-02-18
 * @author Jasper 🏴‍☠️
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const SOURCE = join(ROOT, ".github", "hooks", "scripts");
const TARGET = join(ROOT, "static", "hooks", "scripts");
const HOOKS_JSON_SRC = join(ROOT, ".github", "hooks", "hooks.json");
const HOOKS_JSON_DEST = join(ROOT, "static", "hooks", "hooks.json");
const HOOKS_VERSION_SRC = join(ROOT, ".github", "hooks", "hooks-version.json");
const HOOKS_VERSION_DEST = join(ROOT, "static", "hooks", "hooks-version.json");

const dryRun = process.argv.includes("--dry-run");

function syncDir(src, dest, indent = "") {
  if (!existsSync(src)) {
    console.error(`Source not found: ${src}`);
    process.exit(1);
  }

  if (!existsSync(dest)) {
    if (dryRun) {
      console.log(`${indent}[mkdir] ${relative(ROOT, dest)}`);
    } else {
      mkdirSync(dest, { recursive: true });
      console.log(`${indent}[mkdir] ${relative(ROOT, dest)}`);
    }
  }

  const entries = readdirSync(src, { withFileTypes: true });
  let synced = 0;

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      syncDir(srcPath, destPath, indent + "  ");
      continue;
    }

    if (entry.isFile()) {
      const relPath = relative(ROOT, destPath);
      if (dryRun) {
        console.log(`${indent}[copy] ${relPath}`);
      } else {
        cpSync(srcPath, destPath, { force: true });
        console.log(`${indent}[copy] ${relPath}`);
      }
      synced++;
    }
  }

  return synced;
}

console.log(dryRun ? "=== DRY RUN ===" : "=== Syncing hooks ===");

/** Recursively collect all file paths from a directory */
function collectFiles(dir) {
  const result = [];
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

console.log(`Source: ${relative(ROOT, SOURCE)}`);
console.log(`Target: ${relative(ROOT, TARGET)}`);
console.log("");

const count = syncDir(SOURCE, TARGET);

// Vendor the portable quality-gate engine into the hook bundle so the
// PreToolUse hook can import it on hosts that only have the shipped mirror.
// Only the runtime .mjs files travel (no __tests__, no .d.ts).
const ENGINE_SRC = join(ROOT, "quality-gate");
const ENGINE_DEST = join(TARGET, "lib", "quality-gate");
const engineFiles = existsSync(ENGINE_SRC)
  ? readdirSync(ENGINE_SRC, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
      .map((e) => e.name)
  : [];

if (engineFiles.length > 0) {
  if (!dryRun && !existsSync(ENGINE_DEST)) {
    mkdirSync(ENGINE_DEST, { recursive: true });
  }
  for (const name of engineFiles) {
    const from = join(ENGINE_SRC, name);
    const to = join(ENGINE_DEST, name);
    if (dryRun) {
      console.log(`[vendor] ${relative(ROOT, to)}`);
    } else {
      cpSync(from, to, { force: true });
      console.log(`[vendor] ${relative(ROOT, to)}`);
    }
  }
}

// Sync hooks.json
if (existsSync(HOOKS_JSON_SRC)) {
  if (dryRun) {
    console.log("[copy] static/hooks/hooks.json");
  } else {
    cpSync(HOOKS_JSON_SRC, HOOKS_JSON_DEST, { force: true });
    console.log("[copy] static/hooks/hooks.json");
  }
}

// Auto-generate hooks-version.json from content hash
const hashFiles = collectFiles(SOURCE);
// Include the vendored engine so a gate-engine change bumps the hook version.
for (const name of engineFiles) {
  hashFiles.push(join(ENGINE_SRC, name));
}
const hash = createHash("sha256");
for (const f of hashFiles.sort()) {
  hash.update(readFileSync(f));
}
const contentHash = hash.digest("hex").slice(0, 12);
const versionPayload = JSON.stringify(
  { version: contentHash, updated: new Date().toISOString().slice(0, 10) },
  null,
  2,
) + "\n";

if (dryRun) {
  console.log(`[generate] hooks-version.json (hash: ${contentHash})`);
} else {
  writeFileSync(HOOKS_VERSION_SRC, versionPayload);
  writeFileSync(HOOKS_VERSION_DEST, versionPayload);
  console.log(`[generate] hooks-version.json (hash: ${contentHash})`);
}

console.log(
  `\nDone. ${count} scripts + hooks.json ${dryRun ? "would be" : ""} synced.`,
);
