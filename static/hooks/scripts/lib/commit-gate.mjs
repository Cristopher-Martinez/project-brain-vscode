/**
 * commit-gate.mjs — BLOCKING commit policy enforcement for loop sessions.
 *
 * Tracks file edits since last commit and BLOCKS synthesis (loopAwaitInput)
 * until the agent makes a commit via commitCheckpoint tool.
 *
 * Triggers (any of these -> DENY synthesis):
 *   1. 5+ files edited since last commit
 *   2. 15+ minutes since last commit with pending edits
 *
 * Uses commit-state.json in .project-brain/loops/{sessionId}/.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { getLoopDir } from "./brain-paths.mjs";

/** Strip UTF-8 BOM — PowerShell writes BOM by default, crashes JSON.parse. */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ===============================================================
// Constants
// ===============================================================

/** Minimum edited files before BLOCKING synthesis. */
const FILE_THRESHOLD = 5;

/** Minutes since last commit before BLOCKING (with pending edits). */
const TIME_THRESHOLD_MS = 15 * 60 * 1000;

/** Known code file extensions for heuristic detection. */
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".vue",
  ".svelte",
  ".astro",
]);

/** Paths that are NEVER code (always excluded). */
const ALWAYS_EXCLUDED = [
  ".project-brain/",
  ".brain-loops/",
  "docs/memory/",
  "node_modules/",
  "dist/",
  ".git/",
];

/**
 * Detect source code directories for this workspace.
 * Priority: discipline.json config > auto-detect from project files > extension heuristic.
 * @param {string} cwd
 * @returns {{ paths: string[], files: string[] }}
 */
function detectSourceCodePaths(cwd) {
  // Level 1: Explicit config in discipline.json
  try {
    const disciplinePaths = [
      join(cwd, ".github", "hooks", "discipline.json"),
      join(cwd, "discipline.json"),
    ];
    for (const fp of disciplinePaths) {
      if (existsSync(fp)) {
        const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
        if (data.commitGate?.sourceCodePaths) {
          return {
            paths: data.commitGate.sourceCodePaths,
            files: data.commitGate.sourceCodeFiles || [
              "package.json",
              "tsconfig.json",
            ],
          };
        }
      }
    }
  } catch {
    /* config read failed — fall through */
  }

  // Level 2: Auto-detect from project structure
  const detected = [];
  const markers = [
    { check: "tsconfig.json", dirs: ["src/"] },
    { check: "package.json", dirs: ["src/", "lib/"] },
    { check: "pyproject.toml", dirs: ["src/", "app/"] },
    { check: "setup.py", dirs: ["src/", "app/"] },
    { check: "Cargo.toml", dirs: ["src/"] },
    { check: "go.mod", dirs: ["cmd/", "pkg/", "internal/"] },
    { check: "pom.xml", dirs: ["src/"] },
    { check: "build.gradle", dirs: ["src/"] },
  ];
  for (const m of markers) {
    if (existsSync(join(cwd, m.check))) {
      for (const d of m.dirs) {
        if (existsSync(join(cwd, d)) && !detected.includes(d)) {
          detected.push(d);
        }
      }
    }
  }
  // Also check for common additional source dirs that exist
  const extraDirs = [
    "server/",
    "saas/src/",
    "webview-ui/src/",
    "scripts/",
    "test/",
    "tests/",
  ];
  for (const d of extraDirs) {
    if (existsSync(join(cwd, d)) && !detected.includes(d)) {
      detected.push(d);
    }
  }

  if (detected.length > 0) {
    return {
      paths: detected,
      files: ["package.json", "tsconfig.json", "package-lock.json"],
    };
  }

  // Level 3: No structure detected — return empty (will use extension heuristic)
  return { paths: [], files: [] };
}

/**
 * Check if a file path represents a code change worth blocking for.
 * Uses detected source paths or falls back to extension-based heuristic.
 * @param {string} filePath
 * @param {{ paths: string[], files: string[] }} detected
 * @returns {boolean}
 */
function isSourceCodeFile(filePath, detected) {
  const trimmed = filePath.trim();
  if (!trimmed) return false;

  // Always exclude known non-code paths
  if (ALWAYS_EXCLUDED.some((p) => trimmed.includes(p))) return false;

  // If we have detected source paths, use them
  if (detected.paths.length > 0) {
    return (
      detected.paths.some((p) => trimmed.includes(p)) ||
      detected.files.some((f) => trimmed.endsWith(f))
    );
  }

  // Fallback: extension-based heuristic
  const ext = trimmed.substring(trimmed.lastIndexOf(".")).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// ===============================================================
// State I/O
// ===============================================================

/**
 * Get the commit state file path for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function getCommitStatePath(cwd, sessionId) {
  const dir = getLoopDir(cwd, sessionId || "_default");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return join(dir, "commit-state.json");
}

/**
 * Read the current commit state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ editedSinceCommit: string[], lastCommitTs: number|null, commitCount: number }}
 */
export function readCommitState(cwd, sessionId) {
  const defaults = {
    editedSinceCommit: [],
    lastCommitTs: null,
    commitCount: 0,
  };

  try {
    const fp = getCommitStatePath(cwd, sessionId);
    if (!existsSync(fp)) return defaults;
    const data = JSON.parse(stripBom(readFileSync(fp, "utf8")));
    return { ...defaults, ...data };
  } catch {
    return defaults;
  }
}

/**
 * Write the commit state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {object} state
 */
export function writeCommitState(cwd, sessionId, state) {
  try {
    const fp = getCommitStatePath(cwd, sessionId);
    writeFileSync(fp, JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}

// ===============================================================
// File tracking (called from post-tool-checks)
// ===============================================================

/**
 * Record that a file was edited (for commit tracking).
 * @param {string} cwd
 * @param {string} sessionId
 * @param {string|string[]} filePaths
 */
export function recordCommitEdit(cwd, sessionId, filePaths) {
  if (!sessionId) return;

  const state = readCommitState(cwd, sessionId);
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  for (const fp of paths) {
    const short = fp ? basename(fp) : "";
    if (short && !state.editedSinceCommit.includes(short)) {
      state.editedSinceCommit.push(short);
    }
  }

  writeCommitState(cwd, sessionId, state);
}

/**
 * Record that a commit was just made (resets tracking).
 * @param {string} cwd
 * @param {string} sessionId
 */
export function recordCommitDone(cwd, sessionId) {
  const state = readCommitState(cwd, sessionId);
  state.editedSinceCommit = [];
  state.lastCommitTs = Date.now();
  state.commitCount += 1;
  writeCommitState(cwd, sessionId, state);
}

/**
 * Set the commit bypass toggle for a session.
 * When true, commit-gate will allow all synthesis without requiring commits.
 * @param {string} cwd
 * @param {string} sessionId
 * @param {boolean} enabled
 */
export function setCommitBypass(cwd, sessionId, enabled) {
  const state = readCommitState(cwd, sessionId);
  state.commitBypass = !!enabled;
  writeCommitState(cwd, sessionId, state);
}

/**
 * Read the commit bypass state for a session.
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {boolean}
 */
export function getCommitBypass(cwd, sessionId) {
  const state = readCommitState(cwd, sessionId);
  return !!state.commitBypass;
}

// ===============================================================
// Git helpers
// ===============================================================

/**
 * @param {string} cwd
 * @returns {string[]}
 */
export function getGitStatus(cwd) {
  try {
    const out = execFileSync("git", ["status", "--short"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function getCurrentBranch(cwd) {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Generate a conventional commit message from git status.
 * @param {string} cwd
 * @returns {string}
 */
export function generateCommitMessage(cwd) {
  const status = getGitStatus(cwd);
  if (status.length === 0) return "";

  const categories = { feat: [], fix: [], refactor: [], docs: [], chore: [] };

  for (const line of status) {
    const file = line.substring(3).trim().split(" -> ").pop() || "";
    const lower = file.toLowerCase();

    if (lower.includes("docs/") || lower.endsWith(".md")) {
      categories.docs.push(file);
    } else if (lower.includes("hooks/") || lower.includes("static/hooks/")) {
      categories.chore.push(file);
    } else if (lower.startsWith("src/")) {
      categories.feat.push(file);
    } else {
      categories.chore.push(file);
    }
  }

  let dominant = "chore";
  let maxCount = 0;
  for (const [cat, files] of Object.entries(categories)) {
    if (files.length > maxCount) {
      maxCount = files.length;
      dominant = cat;
    }
  }

  const allFiles = status.map((l) => basename(l.substring(3).trim()));
  const scope =
    allFiles.length <= 3 ? allFiles.join(", ") : `${allFiles.length} files`;

  return `${dominant}(${scope.substring(0, 40)}): session changes`;
}

// ===============================================================
// Evaluation (BLOCKING — called from PreToolUse at loopAwaitInput)
// ===============================================================

/**
 * Evaluate whether a commit is REQUIRED before synthesis.
 * Returns { decision, context } where decision is "deny" or "allow".
 *
 * BLOCKING: returns "deny" to force the agent to commit first.
 * The agent MUST call commitCheckpoint() before sending synthesis.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ decision: "deny"|"allow", context: string }}
 */
export function evaluateCommitGate(cwd, sessionId) {
  const state = readCommitState(cwd, sessionId);

  // ── Bypass toggle: if user deliberately enabled bypass, allow on any branch ──
  if (state.commitBypass) {
    return { decision: "allow", context: "" };
  }

  // ── Protected branch guard: require bypass OR commit before synthesis ──
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const protectedBranches = ["main", "master", "production", "prod"];
    if (
      protectedBranches.some((p) => branch === p || branch.startsWith(`${p}/`))
    ) {
      // On protected branch without bypass — check for uncommitted changes
      const diff = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();
      const untracked = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard"],
        { cwd, encoding: "utf8" },
      ).trim();
      // Smart source detection: config > auto-detect > extension heuristic
      const detected = detectSourceCodePaths(cwd);
      const isCodeChange = (line) => isSourceCodeFile(line, detected);
      const diffLines = diff ? diff.split("\n").filter(isCodeChange) : [];
      const untrackedLines = untracked
        ? untracked.split("\n").filter(isCodeChange)
        : [];
      const blockingFiles = [...diffLines, ...untrackedLines].filter(Boolean);
      if (blockingFiles.length > 0) {
        const fileList = blockingFiles.map((f) => `  - ${f}`).join("\n");
        const detectedInfo =
          detected.paths.length > 0
            ? detected.paths.join(", ")
            : "(heuristic mode)";
        return {
          decision: "deny",
          context: `⛔ QUALITY GATE BLOCKED — BRANCH PROTECTION: Rama protegida "${branch}" — hay cambios sin commit.\n\nArchivos pendientes (${blockingFiles.length}):\n${fileList}\n\nACCIÓN REQUERIDA (elige UNA):\n1. Haz commit con commitCheckpoint(sessionId, description)\n2. Activa el bypass: setCommitBypass(cwd, sessionId, true) — desactiva esta gate para la sesión\n3. Si ves archivos que NO son código (temp, config, docs), agrégalos a ALWAYS_EXCLUDED en commit-gate.mjs o configura commitGate.sourceCodePaths en discipline.json\n\nRamas protegidas: ${protectedBranches.join(", ")}.\nDetected source paths: ${detectedInfo}`,
        };
      }
    }
  } catch {
    /* git not available — skip branch check */
  }

  const now = Date.now();

  // Check actual git status (more reliable than tracked edits alone)
  const gitStatus = getGitStatus(cwd);
  const detectedPaths = detectSourceCodePaths(cwd);
  const uncommittedCount = gitStatus.filter((l) => {
    const file = l.substring(3).trim();
    return isSourceCodeFile(file, detectedPaths);
  }).length;

  // No uncommitted code changes -> allow
  if (uncommittedCount === 0) {
    return { decision: "allow", context: "" };
  }

  const editCount = state.editedSinceCommit.length;
  const timeSinceCommit = state.lastCommitTs
    ? now - state.lastCommitTs
    : Infinity;

  // -- Trigger 1: File threshold -> DENY --
  if (editCount >= FILE_THRESHOLD || uncommittedCount >= FILE_THRESHOLD) {
    const fileList = state.editedSinceCommit.slice(0, 8).join(", ");
    return {
      decision: "deny",
      context: buildDenyMessage(
        `${uncommittedCount} archivos sin commit (${editCount} editados esta sesion: ${fileList})`,
        cwd,
      ),
    };
  }

  // -- Trigger 2: Time threshold -> DENY --
  if (editCount > 0 && timeSinceCommit > TIME_THRESHOLD_MS) {
    const mins = Math.round(timeSinceCommit / 60000);
    return {
      decision: "deny",
      context: buildDenyMessage(
        `${mins} min desde el ultimo commit con ${editCount} archivo(s) pendiente(s)`,
        cwd,
      ),
    };
  }

  return { decision: "allow", context: "" };
}

/**
 * Build the blocking deny message for commit gate.
 * @param {string} reason
 * @param {string} cwd
 * @returns {string}
 */
function buildDenyMessage(reason, cwd) {
  const branch = getCurrentBranch(cwd);
  const suggested = generateCommitMessage(cwd);

  return (
    `⛔ QUALITY GATE BLOCKED — COMMIT CHECKPOINT: ${reason}\n` +
    `Branch: ${branch}\n\n` +
    `ACCIÓN REQUERIDA: Haz commit ANTES de enviar síntesis:\n` +
    `1. Llama commitCheckpoint con sessionId y description (OBLIGATORIO)\n` +
    `2. description: explica QUE hiciste, POR QUE, y contexto relevante. Ejemplo:\n` +
    `   "Implementado sistema de commit-gate bloqueante. Se creo commit-gate.mjs con evaluacion de thresholds y lm-tools-commit.ts con generacion de mensajes."\n` +
    `3. Mensaje sugerido para subject line: "${suggested}"\n` +
    `4. El description se convierte en el body del commit — cuanto mas rico, mejor el checkpoint\n\n` +
    `NO puedes continuar sin hacer commit. Esta es una política obligatoria.`
  );
}
