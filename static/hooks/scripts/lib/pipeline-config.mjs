/**
 * pipeline-config.mjs — Pipeline enforcement configuration loader.
 * Reads pipeline-config.json from .project-brain/memory/ and provides:
 * - Config loading with safe fallbacks
 * - Auto-detection of build/deploy/test commands from package.json/Makefile/etc.
 * - Config-driven gap detection
 * - Config-driven pipeline file info (siblings, role, hints)
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CONFIG_FILE = "pipeline-config.json";

/**
 * Load pipeline-config.json from .project-brain/memory/.
 * Returns null if not found or invalid.
 * @param {string} cwd - Workspace root
 * @returns {object|null} Parsed config or null
 */
export function loadPipelineConfig(cwd) {
  try {
    const configPath = join(cwd, "docs", "memory", CONFIG_FILE);
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Auto-detect build/deploy/test commands from the project and update
 * pipeline-config.json. Only updates the `commands` and `lastDetected` fields.
 * Creates a minimal config if none exists.
 * Detects: package.json scripts, Makefile targets, Cargo.toml, pyproject.toml.
 * @param {string} cwd - Workspace root
 */
export function refreshPipelineCommands(cwd) {
  try {
    const memDir = join(cwd, "docs", "memory");
    if (!existsSync(memDir)) return;

    const detected = detectCommands(cwd);
    if (!detected.build && !detected.deploy && !detected.test) return;

    const configPath = join(memDir, CONFIG_FILE);
    let config;
    try {
      config = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf8"))
        : { version: 1, pipelines: [], gapAction: { onBuild: "warn", onDeploy: "deny" } };
    } catch {
      config = { version: 1, pipelines: [], gapAction: { onBuild: "warn", onDeploy: "deny" } };
    }

    const prev = config.commands || {};
    const changed =
      prev.build !== detected.build ||
      prev.deploy !== detected.deploy ||
      prev.test !== detected.test;

    if (changed) {
      config.commands = detected;
      config.lastDetected = new Date().toISOString();
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    }
  } catch {
    
  }
}

/**
 * Detect build/deploy/test commands from project files.
 * @param {string} cwd
 * @returns {{ build: string, deploy: string, test: string }}
 */
function detectCommands(cwd) {
  const result = { build: "", deploy: "", test: "" };

  // 1. Node.js — package.json scripts
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const scripts = pkg.scripts || {};
      // Build: prioritize compile > build > watch
      result.build =
        scripts.compile ? "npm run compile" :
        scripts.build ? "npm run build" :
        "";
      // Deploy: deploy > publish
      result.deploy =
        scripts.deploy ? "npm run deploy" :
        scripts.publish ? "npm run publish" :
        "";
      // Test: test > test:unit
      result.test = scripts.test ? "npm test" : "";
    }
  } catch {  }

  // 2. Makefile
  if (!result.build) {
    try {
      if (existsSync(join(cwd, "Makefile"))) {
        const mk = readFileSync(join(cwd, "Makefile"), "utf8");
        if (/^build:/m.test(mk)) result.build = "make build";
        if (/^deploy:/m.test(mk)) result.deploy = "make deploy";
        if (/^test:/m.test(mk)) result.test = "make test";
      }
    } catch {  }
  }

  // 3. Cargo (Rust)
  if (!result.build) {
    try {
      if (existsSync(join(cwd, "Cargo.toml"))) {
        result.build = "cargo build";
        result.test = result.test || "cargo test";
      }
    } catch {  }
  }

  // 4. Python
  if (!result.build) {
    try {
      if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
        result.build = "python -m build";
        result.test = result.test || "pytest";
      }
    } catch {  }
  }

  // 5. Go
  if (!result.build) {
    try {
      if (existsSync(join(cwd, "go.mod"))) {
        result.build = "go build ./...";
        result.test = result.test || "go test ./...";
      }
    } catch {  }
  }

  return result;
}

/**
 * Get pipeline info for a file basename, reading from config.
 * Falls back to null if no config or no match.
 * @param {string} basename - File basename (e.g., "messages.ts")
 * @param {object} config - Loaded pipeline config
 * @returns {object|null} { pipeline, siblings, role, hint } or null
 */
export function getPipelineInfoFromConfig(basename, config) {
  if (!config?.pipelines?.length) return null;
  const lower = basename.toLowerCase();

  for (const pipeline of config.pipelines) {
    const files = pipeline.files || {};
    const entry = files[lower];
    if (entry) {
      return {
        pipeline: pipeline.name,
        siblings: entry.siblings || [],
        role: entry.role || "unknown",
        hint: entry.hint || "",
      };
    }
    // Check handler pattern
    if (pipeline.handlerPattern) {
      const rx = new RegExp(pipeline.handlerPattern);
      if (rx.test(lower)) {
        return {
          pipeline: pipeline.name,
          siblings: pipeline.handlerSiblings || [],
          role: "handler",
          hint: `Check: Are ALL new message types added to the routing switch?`,
        };
      }
    }
  }
  return null;
}

/**
 * Detect pipeline gaps using config-driven rules.
 * Falls back to empty array if no config.
 * @param {string} cwd - Workspace root
 * @param {string[]} pipelineEdits - List of edited pipeline basenames
 * @returns {string[]} Gap warning strings
 */
export function detectPipelineGapsFromConfig(cwd, pipelineEdits) {
  if (pipelineEdits.length < 2) return [];
  const config = loadPipelineConfig(cwd);
  if (!config?.pipelines?.length) return [];

  const editSet = new Set(pipelineEdits.map((f) => f.toLowerCase()));
  const gaps = [];

  for (const pipeline of config.pipelines) {
    // Check explicit gap rules
    for (const rule of pipeline.gapRules || []) {
      if (!editSet.has(rule.if.toLowerCase())) continue;

      // withoutAny: gap only if NONE of the alternatives were edited
      if (Array.isArray(rule.withoutAny)) {
        const satisfied = rule.withoutAny.some(f => editSet.has(f.toLowerCase()));
        if (!satisfied) gaps.push(rule.warn);
      // without: gap if the specific file was not edited
      } else if (rule.without && !editSet.has(rule.without.toLowerCase())) {
        gaps.push(rule.warn);
      }
    }
    // Check handler pattern vs routing file
    if (pipeline.handlerPattern) {
      const rx = new RegExp(pipeline.handlerPattern);
      const routingFile = Object.entries(pipeline.files || {}).find(
        ([, v]) => v.role === "routing",
      );
      if (routingFile) {
        const hasHandler = [...editSet].some(
          (f) => rx.test(f) && f !== routingFile[0].toLowerCase(),
        );
        if (hasHandler && !editSet.has(routingFile[0].toLowerCase())) {
          gaps.push(`Handler file editado sin ${routingFile[0]} (routing)`);
        }
      }
    }
  }
  return gaps;
}

/**
 * Check if a command matches the configured build or deploy command.
 * @param {string} cmd - Terminal command string
 * @param {object} config - Loaded pipeline config
 * @returns {"build"|"deploy"|null} Which config command matched
 */
export function matchConfigCommand(cmd, config) {
  if (!config?.commands) return null;
  const lower = cmd.toLowerCase();
  // Check deploy first (more specific action)
  if (config.commands.deploy && lower.includes(config.commands.deploy.toLowerCase())) {
    return "deploy";
  }
  if (config.commands.build && lower.includes(config.commands.build.toLowerCase())) {
    return "build";
  }
  return null;
}

/**
 * Get all pipeline file basenames from config (for tracking).
 * @param {object} config - Loaded pipeline config
 * @returns {Set<string>} Lowercase basenames
 */
export function getPipelineBasenamesFromConfig(config) {
  const basenames = new Set();
  if (!config?.pipelines) return basenames;
  for (const pipeline of config.pipelines) {
    for (const key of Object.keys(pipeline.files || {})) {
      basenames.add(key.toLowerCase());
    }
    // Handler pattern basenames can't be pre-enumerated,
    // but the regex will be checked at tracking time
  }
  return basenames;
}
