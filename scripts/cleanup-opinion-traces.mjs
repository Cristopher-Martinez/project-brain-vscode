#!/usr/bin/env node
/**
 * cleanup-opinion-traces.mjs — One-shot purge of mechanical [auto-promoted]
 * traces from 14_OPINIONS.md. Keeps op_* opinions and any [auto-promoted]
 * entry that is NOT a mechanical activity trace.
 *
 * Usage: node scripts/cleanup-opinion-traces.mjs [--dry-run] [path-to-file]
 *
 * @author Jasper 🏴‍☠️
 */
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const dryRun = process.argv.includes("--dry-run");
const fileArg = process.argv.find((a) => a.endsWith("14_OPINIONS.md"));
const FILE =
  fileArg || join(process.cwd(), ".project-brain", "memory", "14_OPINIONS.md");

// Same blocklist as temporal-mailbox.mjs promotion gate.
const TRACE_BLOCKLIST = [
  /^Read→Edit:/i,
  /^Editado:/i,
  /^Resumen calls/i,
  /^Edited:/i,
  /^Read→/i,
];

const raw = readFileSync(FILE, "utf8");
const lines = raw.split("\n");

// Split into blocks: header preamble + opinion blocks (each starts with "### ").
const blocks = [];
let current = null;
for (const line of lines) {
  if (line.startsWith("### ")) {
    if (current) blocks.push(current);
    current = { header: line, body: [line] };
  } else if (current) {
    current.body.push(line);
  } else {
    (blocks.preamble ||= []).push(line);
  }
}
if (current) blocks.push(current);

let opCount = 0;
let autoKept = 0;
let purged = 0;
const kept = [];

for (const b of blocks) {
  const m = b.header.match(/^###\s+\[auto-promoted\]\s+(.*)$/i);
  if (!m) {
    if (/^###\s+op_/.test(b.header)) opCount++;
    kept.push(b);
    continue;
  }
  const text = m[1].trim();
  const isTrace = TRACE_BLOCKLIST.some((re) => re.test(text));
  if (isTrace) {
    purged++;
  } else {
    autoKept++;
    kept.push(b);
  }
}

const preamble = (blocks.preamble || []).join("\n");
const total = opCount + autoKept;
// Update header count if present.
const newPreamble = preamble.replace(
  /(\d+)\s+opinions tracked/,
  `${total} opinions tracked`,
);

const rebuilt =
  newPreamble.replace(/\n+$/, "") +
  "\n\n" +
  kept.map((b) => b.body.join("\n").replace(/\n+$/, "")).join("\n\n") +
  "\n";

console.log(`📊 Opinion Bank cleanup report`);
console.log(`   op_* opinions kept:        ${opCount}`);
console.log(`   [auto-promoted] kept:      ${autoKept}`);
console.log(`   [auto-promoted] purged:    ${purged} (mechanical traces)`);
console.log(`   total after:               ${total}`);

if (dryRun) {
  console.log("\n(dry-run — no file written)");
} else {
  copyFileSync(FILE, FILE + ".bak");
  writeFileSync(FILE, rebuilt, "utf8");
  console.log(`\n✓ Wrote ${FILE} (backup at 14_OPINIONS.md.bak)`);
}
