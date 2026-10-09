/**
 * immunity-gate.mjs — Structural immunity gate for PreToolUse pipeline.
 * Detects known error patterns BEFORE the agent repeats them.
 * Phase 1: 5 deterministic rules, binary matching, no heuristics.
 *
 * @see .project-brain/memory/immunity/IMPLEMENTATION_PLAN.md
 * @see .github/hooks/scripts/lib/core-error-index.json
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

/** @type {{ errors: Array<import('./types').ImmunityRule> } | null} */
let cachedIndex = null;
/** @type {number} */
let cachedMtime = 0;

/**
 * Load core-error-index.json with mtime-based caching.
 * @param {string} cwd
 * @returns {Array<Object>}
 */
function loadErrorIndex(cwd) {
  const indexPath = join(
    cwd,
    ".github",
    "hooks",
    "scripts",
    "lib",
    "core-error-index.json",
  );
  if (!existsSync(indexPath)) return [];

  try {
    const mtime = statSync(indexPath).mtimeMs;
    if (cachedIndex && mtime === cachedMtime) return cachedIndex.errors;

    const raw = readFileSync(indexPath, "utf8");
    cachedIndex = JSON.parse(raw);
    cachedMtime = mtime;
    return cachedIndex.errors || [];
  } catch {
    return [];
  }
}

/**
 * Check if a file path matches any of the trigger path patterns.
 * Supports simple globs: * (any segment), ** (any depth), *.ext
 * @param {string} filePath - Normalized file path (forward slashes)
 * @param {string[]} triggerPaths - Glob patterns from the rule
 * @returns {boolean}
 */
function matchesPath(filePath, triggerPaths) {
  if (!filePath || !triggerPaths || triggerPaths.length === 0) return false;

  const normalized = filePath.replace(/\\/g, "/");

  for (const pattern of triggerPaths) {
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // Convert glob to regex (anchored)
    const regexStr = normalizedPattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "§DOUBLESTAR§")
      .replace(/\*/g, "[^/]*")
      .replace(/§DOUBLESTAR§/g, ".*");

    const regex = new RegExp("(^|/)" + regexStr + "($|/)");
    if (regex.test(normalized)) return true;
  }

  return false;
}

/**
 * Check if content matches any of the trigger patterns.
 * @param {string} content - The tool input content to check
 * @param {string[]} triggerPatterns - Regex patterns from the rule
 * @returns {boolean}
 */
function matchesPattern(content, triggerPatterns) {
  if (!content || !triggerPatterns || triggerPatterns.length === 0)
    return false;

  for (const pattern of triggerPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(content)) return true;
    } catch {
      // Invalid regex in index — skip silently
    }
  }

  return false;
}

/**
 * Check negative patterns — if ANY match, the rule should NOT fire.
 * Used for E-DEPLOY-01: if command includes package.json, it's fine.
 * @param {string} content - Full command/content text
 * @param {string[]} negativePatterns - Regex patterns that cancel the match
 * @returns {boolean} true if a negative pattern matches (= rule should NOT fire)
 */
function matchesNegative(content, negativePatterns) {
  if (!content || !negativePatterns || negativePatterns.length === 0)
    return false;

  for (const pattern of negativePatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(content)) return true;
    } catch {
      // skip
    }
  }

  return false;
}

/**
 * Extract the relevant file path from tool input.
 * @param {string} toolName
 * @param {Object} toolInput
 * @returns {string|null}
 */
function extractFilePath(toolName, toolInput) {
  if (toolName === "replace_string_in_file" || toolName === "create_file") {
    return toolInput.filePath || null;
  }
  if (toolName === "multi_replace_string_in_file") {
    // Return first replacement path — we'll check all in evaluateImmunityGate
    const replacements = toolInput.replacements || [];
    return replacements.length > 0 ? replacements[0].filePath : null;
  }
  if (toolName === "run_in_terminal") {
    return toolInput.command || null; // For terminal, "path" is the command text
  }
  return null;
}

/**
 * Extract all relevant content for pattern matching.
 * @param {string} toolName
 * @param {Object} toolInput
 * @returns {string}
 */
function extractContent(toolName, toolInput) {
  const parts = [];

  if (toolInput.filePath) parts.push(toolInput.filePath);
  if (toolInput.content) parts.push(toolInput.content);
  if (toolInput.newString) parts.push(toolInput.newString);
  if (toolInput.oldString) parts.push(toolInput.oldString);
  if (toolInput.command) parts.push(toolInput.command);

  // multi_replace_string_in_file
  if (toolInput.replacements) {
    for (const r of toolInput.replacements) {
      if (r.filePath) parts.push(r.filePath);
      if (r.newString) parts.push(r.newString);
      if (r.oldString) parts.push(r.oldString);
    }
  }

  return parts.join("\n");
}

/**
 * Record immunity activation to metrics file.
 * Non-critical — fire and forget.
 * @param {string} cwd
 * @param {string} ruleId
 * @param {string} decision
 */
function recordActivation(cwd, ruleId, decision) {
  // Temporary calibration log — remove after 30-day validation window
  // MUST use stderr — stdout is the JSON protocol channel for hooks
  console.error(`[IMMUNITY] ${ruleId} → ${decision}`);
  const metricsPath = join(
    cwd,
    "docs",
    "memory",
    "immunity",
    "immunity-metrics.json",
  );

  try {
    let metrics = {
      totalActivations: 0,
      deniesIssued: 0,
      asksIssued: 0,
      rulesTriggered: {},
      lastEvaluation: null,
    };

    if (existsSync(metricsPath)) {
      metrics = {
        ...metrics,
        ...JSON.parse(readFileSync(metricsPath, "utf8")),
      };
    }

    metrics.totalActivations++;
    if (decision === "deny") metrics.deniesIssued++;
    if (decision === "ask") metrics.asksIssued++;
    metrics.rulesTriggered[ruleId] = (metrics.rulesTriggered[ruleId] || 0) + 1;
    metrics.lastEvaluation = new Date().toISOString();

    writeFileSync(metricsPath, JSON.stringify(metrics));
  } catch {
    // Metrics are non-critical — never block on failure
  }
}

/**
 * Evaluate the immunity gate for a tool call.
 * Binary matching: pathMatch required, patternMatch if applicable.
 * Returns first matching rule (max 1 activation per call).
 *
 * @param {{ toolName: string, toolInput: Object, cwd: string }} params
 * @returns {{ decision: "allow" | "ask" | "deny", message?: string, ruleId?: string }}
 */
export function evaluateImmunityGate({ toolName, toolInput, cwd }) {
  const rules = loadErrorIndex(cwd);
  if (rules.length === 0) return { decision: "allow" };

  // Check if the tool is relevant to any rule
  const relevantRules = rules.filter(
    (r) =>
      !r.triggerTools ||
      r.triggerTools.length === 0 ||
      r.triggerTools.includes(toolName),
  );
  if (relevantRules.length === 0) return { decision: "allow" };

  // Extract file path(s) and content
  const content = extractContent(toolName, toolInput);

  // For multi_replace_string_in_file, check ALL file paths
  const filePaths = [];
  if (toolName === "multi_replace_string_in_file" && toolInput.replacements) {
    for (const r of toolInput.replacements) {
      if (r.filePath) filePaths.push(r.filePath);
    }
  } else {
    const fp = extractFilePath(toolName, toolInput);
    if (fp) filePaths.push(fp);
  }

  // Evaluate each rule — first match wins
  for (const rule of relevantRules) {
    // Terminal tools: match by patterns only, skip path matching
    if (toolName === "run_in_terminal") {
      const hasPatterns =
        rule.triggerPatterns && rule.triggerPatterns.length > 0;
      if (!hasPatterns) continue;
      if (!matchesPattern(content, rule.triggerPatterns)) continue;
      // Negative pattern check
      if (rule.negativePatterns && rule.negativePatterns.length > 0) {
        if (matchesNegative(content, rule.negativePatterns)) continue;
      }
      const decision = rule.decision || "ask";
      recordActivation(cwd, rule.id, decision);
      return {
        decision,
        message: rule.message || `🧬 IMMUNITY ${rule.id}: ${rule.title}`,
        ruleId: rule.id,
      };
    }

    // File-edit tools: path match required
    const pathMatch = filePaths.some((fp) =>
      matchesPath(fp, rule.triggerPaths),
    );
    if (!pathMatch) continue;

    // Step 2: Pattern match (if rule has patterns)
    const hasPatterns = rule.triggerPatterns && rule.triggerPatterns.length > 0;
    const patternMatch = hasPatterns
      ? matchesPattern(content, rule.triggerPatterns)
      : true;
    if (!patternMatch) continue;

    // Step 3: Negative pattern check (cancels match)
    if (rule.negativePatterns && rule.negativePatterns.length > 0) {
      if (matchesNegative(content, rule.negativePatterns)) continue;
    }

    // Match confirmed — record and return decision
    const decision = rule.decision || "ask";
    recordActivation(cwd, rule.id, decision);

    return {
      decision,
      message: rule.message || `🧬 IMMUNITY ${rule.id}: ${rule.title}`,
      ruleId: rule.id,
    };
  }

  return { decision: "allow" };
}
