/**
 * test-pipeline-contracts.ts — T0: Contrato Universal de Testing
 *
 * Auto-detects project test infrastructure (framework, commands, core modules)
 * and persists a contract to `.project-brain/loops/test-contract.json`.
 *
 * The contract tells downstream gates (T2, T4, T6) what to run and check.
 * Hook scripts read the JSON cache — they never import this file directly.
 *
 * @see .project-brain/memory/plans/TESTING_PIPELINE_DAG.md
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { log, logWarn } from "./logger";
import {
  CoreModuleEntry,
  CoreReason,
  DetectedCommands,
  PkgJson,
  ProjectTestContract,
  TestFramework,
} from "./test-pipeline-types";

// Re-export types for consumer convenience
export type {
  ContractCache,
  CoreModuleEntry,
  CoreReason,
  DetectedCommands,
  GateCheck,
  GateResult,
  PkgJson,
  ProjectTestContract,
  TestFramework,
} from "./test-pipeline-types";

// ─── Constants ───────────────────────────────────────────────

/** Patterns that signal core module reasons in file content. */
const CORE_PATTERNS: Array<{ pattern: RegExp; reason: CoreReason }> = [
  // persistence — import/require-aware + direct API usage
  {
    pattern:
      /(?:import|require|from)\s.*\b(sequelize|mongoose|prisma|drizzle|typeorm|knex|sql\.js|leveldb|redis)\b/i,
    reason: "persistence",
  },
  {
    pattern:
      /\b(readFile|writeFile|createWriteStream|Database|\.db\b|\.sqlite)\b/,
    reason: "persistence",
  },
  // external-api — framework setup + HTTP clients
  {
    pattern:
      /(?:import|require|from)\s.*\b(express|fastify|hono|koa|restify)\b/i,
    reason: "external-api",
  },
  {
    pattern: /\b(createServer|router\.(get|post|put|delete|patch))\b/i,
    reason: "external-api",
  },
  {
    pattern:
      /(?:import|require|from)\s.*\b(axios|got|superagent|node-fetch)\b/i,
    reason: "external-api",
  },
  { pattern: /\b(fetch\(|https?\.request)\b/, reason: "external-api" },
  // auth
  {
    pattern:
      /(?:import|require|from)\s.*\b(passport|bcrypt|argon2|jsonwebtoken)\b/i,
    reason: "auth",
  },
  {
    pattern:
      /\b(authenticate|authorization|session\.(create|destroy)|OAuth)\b/i,
    reason: "auth",
  },
  // money — import-aware to reduce false positives
  {
    pattern: /(?:import|require|from)\s.*\b(stripe|paypal|braintree|square)\b/i,
    reason: "money",
  },
  {
    pattern: /\b(payment|billing|invoice|charge|refund|subscription)\b/i,
    reason: "money",
  },
  // shared-state
  {
    pattern: /(?:import|require|from)\s.*\b(redux|zustand|mobx)\b/i,
    reason: "shared-state",
  },
  {
    pattern:
      /\b(createStore|useReducer|EventEmitter|SharedArrayBuffer|Atomics|mutex|semaphore)\b/i,
    reason: "shared-state",
  },
  // user-data
  { pattern: /\b(personalData|userData|gdpr|pii)\b/i, reason: "user-data" },
  {
    pattern: /\b(email|password|phone|ssn|creditCard)\b/i,
    reason: "user-data",
  },
];

/** Extensions to scan for core module detection. */
const SCANNABLE_EXT = /\.(ts|js|tsx|jsx|py|rb|go|rs)$/;

/** Directories to skip during scan. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".brain-loops",
  ".project-brain",
  "vendor",
  "__pycache__",
  ".next",
  ".nuxt",
  "out",
]);

// ─── Framework Detection ─────────────────────────────────────

const FRAMEWORK_MAP: Array<{ dep: string; framework: TestFramework }> = [
  { dep: "vitest", framework: "vitest" },
  { dep: "jest", framework: "jest" },
  { dep: "mocha", framework: "mocha" },
  { dep: "ava", framework: "ava" },
  { dep: "tap", framework: "tap" },
  { dep: "@playwright/test", framework: "playwright" },
  { dep: "cypress", framework: "cypress" },
];

export function detectFramework(pkg: PkgJson): TestFramework {
  // Priority 1: scripts.test — most reliable signal (user explicitly configured)
  const testScript = pkg.scripts?.test || "";
  if (testScript && !testScript.includes("no test specified")) {
    for (const { dep, framework } of FRAMEWORK_MAP) {
      if (testScript.includes(dep)) {
        return framework;
      }
    }
  }
  // Priority 2: devDependencies — fallback when script doesn't mention framework
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const { dep, framework } of FRAMEWORK_MAP) {
    if (allDeps[dep]) {
      return framework;
    }
  }
  return "unknown";
}

// ─── Command Detection ───────────────────────────────────────

export function detectCommands(pkg: PkgJson, wsRoot: string): DetectedCommands {
  const scripts = pkg.scripts || {};
  const result: DetectedCommands = {
    test: null,
    coverage: null,
    lint: null,
    mutation: null,
  };

  // Test
  if (scripts.test && !scripts.test.includes("no test specified")) {
    result.test = "npm test";
  } else if (scripts["test:unit"]) {
    result.test = "npm run test:unit";
  }

  // Coverage
  if (scripts.coverage) {
    result.coverage = "npm run coverage";
  } else if (scripts["test:coverage"]) {
    result.coverage = "npm run test:coverage";
  } else if (result.test) {
    const fw = detectFramework(pkg);
    if (["jest", "vitest"].includes(fw)) {
      result.coverage = `${result.test} -- --coverage`;
    } else if (
      fw === "mocha" &&
      (existsSync(join(wsRoot, ".nycrc")) ||
        existsSync(join(wsRoot, ".nycrc.json")))
    ) {
      result.coverage = "npx nyc npm test";
    }
  }

  // Lint
  if (scripts.lint) {
    result.lint = "npm run lint";
  } else if (scripts["lint:check"]) {
    result.lint = "npm run lint:check";
  }

  // Mutation
  if (scripts.mutation) {
    result.mutation = "npm run mutation";
  } else if (scripts["test:mutation"]) {
    result.mutation = "npm run test:mutation";
  } else {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps["stryker-mutator"] || allDeps["@stryker-mutator/core"]) {
      result.mutation = "npx stryker run";
    }
  }

  // Language-specific fallbacks (no package.json test)
  if (!result.test) {
    result.test = detectNonNodeTest(wsRoot);
    if (!result.coverage) {
      result.coverage = detectNonNodeCoverage(wsRoot);
    }
  }

  return result;
}

function detectNonNodeTest(wsRoot: string): string | null {
  if (existsSync(join(wsRoot, "Makefile"))) {
    return detectMakeTarget(wsRoot, "test");
  }
  if (existsSync(join(wsRoot, "go.mod"))) {
    return "go test ./...";
  }
  if (existsSync(join(wsRoot, "Cargo.toml"))) {
    return "cargo test";
  }
  if (existsSync(join(wsRoot, "Gemfile"))) {
    return "bundle exec rspec";
  }
  if (
    existsSync(join(wsRoot, "pyproject.toml")) ||
    existsSync(join(wsRoot, "setup.py"))
  ) {
    return "pytest";
  }
  return null;
}

function detectNonNodeCoverage(wsRoot: string): string | null {
  if (existsSync(join(wsRoot, "go.mod"))) {
    return "go test -cover ./...";
  }
  if (
    existsSync(join(wsRoot, "pyproject.toml")) ||
    existsSync(join(wsRoot, "setup.py"))
  ) {
    return "pytest --cov";
  }
  return null;
}

function detectMakeTarget(wsRoot: string, target: string): string | null {
  try {
    const makefile = readFileSync(join(wsRoot, "Makefile"), "utf8");
    return makefile.includes(`${target}:`) ? `make ${target}` : null;
  } catch {
    return null;
  }
}

// ─── Core Module Detection ───────────────────────────────────

export function detectCoreModules(wsRoot: string): CoreModuleEntry[] {
  const seen = new Map<string, CoreReason[]>();
  scanDirectory(wsRoot, wsRoot, seen);
  return [...seen.entries()].map(([path, reasons]) => ({
    path,
    reasons,
    autoDetected: true,
  }));
}

function scanDirectory(
  dir: string,
  wsRoot: string,
  seen: Map<string, CoreReason[]>,
): void {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const d of dirents) {
    if (d.isDirectory() && !SKIP_DIRS.has(d.name)) {
      scanDirectory(join(dir, d.name), wsRoot, seen);
    } else if (d.isFile() && SCANNABLE_EXT.test(d.name)) {
      scanFile(join(dir, d.name), wsRoot, seen);
    }
  }
}

function scanFile(
  filePath: string,
  wsRoot: string,
  seen: Map<string, CoreReason[]>,
): void {
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf8");
    // < 100KB → full content; ≥ 100KB → first 1000 lines
    const scanContent =
      stat.size < 102400
        ? content
        : content.split("\n").slice(0, 1000).join("\n");
    const relPath = relative(wsRoot, filePath).replace(/\\/g, "/");

    const reasons: CoreReason[] = [];
    for (const { pattern, reason } of CORE_PATTERNS) {
      if (pattern.test(scanContent) && !reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
    if (reasons.length > 0) {
      seen.set(relPath, reasons);
    }
  } catch {
    /* permission errors */
  }
}

// ─── Invariants Pattern ──────────────────────────────────────

function detectInvariantsPattern(framework: TestFramework): string {
  switch (framework) {
    case "pytest":
      return "@pytest.mark.invariant";
    case "rspec":
      return ":invariant";
    case "go-test":
      return "// @invariant";
    default:
      return "@invariant";
  }
}

// ─── Contract Detection (Main) ───────────────────────────────

export function detectTestContract(wsRoot: string): ProjectTestContract {
  log("[TestContract] Detecting test contract...");

  let pkg: PkgJson = {};
  const pkgPath = join(wsRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      logWarn("[TestContract] Failed to parse package.json");
    }
  }

  const framework = detectFramework(pkg);
  const commands = detectCommands(pkg, wsRoot);
  const coreModules = detectCoreModules(wsRoot);

  const contract: ProjectTestContract = {
    test: commands.test,
    coverage: commands.coverage,
    lint: commands.lint,
    mutation: commands.mutation,
    framework,
    invariantsPattern: detectInvariantsPattern(framework),
    coreModules,
  };

  log(
    `[TestContract] framework=${framework}, test=${commands.test ?? "null"}, coreModules=${coreModules.length}`,
  );
  return contract;
}
// Re-export cache API
export {
  getOrDetectContract,
  mergeContractOverrides,
  readContractCache,
  refreshContract,
  writeContractCache,
} from "./test-pipeline-cache";
