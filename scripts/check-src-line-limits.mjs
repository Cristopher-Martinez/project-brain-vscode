import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const DEFAULT_LIMIT = 400;

// Temporary debt ceiling for known legacy files.
// Keep this list short and reduce values over time.
const LEGACY_LIMITS = {
  "src/admin-panel.ts": 628,
  "src/agent-identity.ts": 1563,
  "src/auto-vectorizer.ts": 630,
  "src/bootstrapper.ts": 1174,
  "src/chat-handlers.ts": 1793,
  "src/cloud-sync.ts": 662,
  "src/code-intelligence.ts": 738,
  "src/cron-engine.ts": 740,
  "src/dual-opinion-bank.ts": 459,
  "src/dynamic-tool-set.ts": 629,
  "src/graph-utils.ts": 637,
  "src/i18n.ts": 1528,
  "src/identity-types.ts": 858,
  "src/lm-tools-search.ts": 805,
  "src/lm-tools-shared.ts": 510,
  "src/lm-tools-strategy.ts": 899,
  "src/login-webview.ts": 487,
  "src/loop-engine.ts": 677,
  "src/mcp-gateway-tools.ts": 439,
  "src/mcp-smoke-loop.ts": 401,
  "src/memory-fs.ts": 610,
  "src/orchestration-session.ts": 975,
  "src/pattern-detector.ts": 559,
  "src/plan-approval.ts": 486,
  "src/saas-client.ts": 1273,
  "src/saas-init.ts": 424,
  "src/self-learning-context.ts": 455,
  "src/session-manager.ts": 869,
  "src/session-spawner.ts": 809,
  "src/session-summarizer.ts": 533,
  "src/skill-manager.ts": 1029,
  "src/slave-protocol.ts": 856,
  "src/swarm-mailbox.ts": 544,
  "src/swarm-tool-dispatch.ts": 422,
  "src/swarm-worker.ts": 418,
  "src/templates.ts": 1344,
  "src/tree-view.ts": 1345,
};

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function getTrackedSourceFiles() {
  const out = execSync("rg --files src", { encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => normalize(p).endsWith(".ts"))
    .filter((p) => !normalize(p).startsWith("src/test/"));
}

function countLines(filePath) {
  const raw = fs.readFileSync(path.join(ROOT, filePath), "utf8");
  return raw.split(/\r?\n/).length;
}

function main() {
  const files = getTrackedSourceFiles();
  const violations = [];

  for (const file of files) {
    const normalized = normalize(file);
    const max = LEGACY_LIMITS[normalized] ?? DEFAULT_LIMIT;
    const lines = countLines(file);
    if (lines > max) {
      violations.push({ file: normalized, lines, max });
    }
  }

  if (violations.length === 0) {
    console.log(
      `OK: src/ line limits enforced (default ${DEFAULT_LIMIT}, legacy exceptions ${Object.keys(LEGACY_LIMITS).length}).`,
    );
    return;
  }

  console.error("Line limit violations detected:");
  for (const v of violations) {
    console.error(`- ${v.file}: ${v.lines} lines (max ${v.max})`);
  }
  process.exit(1);
}

main();
