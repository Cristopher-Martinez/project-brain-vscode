#!/usr/bin/env node
/**
 * Validate frontmatter of all SKILL.md and .agent.md files.
 *
 * Checks:
 *  - Frontmatter exists (starts with --- on line 1)
 *  - `name` field present
 *  - `description` field present and non-empty
 *  - `name` is lowercase-hyphens only, ≤64 chars
 *  - No code-fence wrappers (```skill, ```yaml, ```chatagent)
 *  - description is ≤1024 chars
 *
 * Usage:
 *   node scripts/validate-skills-agents.mjs          # validate all
 *   node scripts/validate-skills-agents.mjs --fix     # (future) auto-fix mode
 *
 * Exit code: 0 = OK, 1 = issues found
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);

// ── Collect files ──────────────────────────────────────────────────
function collectSkills() {
  const skillsDir = join(ROOT, ".project-brain", "memory", "skills");
  const results = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, "SKILL.md");
      try {
        statSync(skillFile);
        results.push({ path: skillFile, type: "skill", dirName: entry.name });
      } catch {
        /* no SKILL.md in this dir */
      }
    }
  } catch {
    /* skills dir doesn't exist */
  }
  return results;
}

function collectAgents() {
  const agentsDir = join(ROOT, ".github", "agents");
  const results = [];
  try {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".agent.md")) continue;
      results.push({
        path: join(agentsDir, entry.name),
        type: "agent",
        dirName: entry.name,
      });
    }
  } catch {
    /* agents dir doesn't exist */
  }
  return results;
}

// ── Parse frontmatter ──────────────────────────────────────────────
function parseFrontmatter(content) {
  // Strip UTF-8 BOM if present
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const codeFenceMatch = content.match(/^```\w*\s*\n/);
  if (codeFenceMatch) {
    return {
      error: `code-fence wrapper detected: "${codeFenceMatch[0].trim()}"`,
      fields: {},
    };
  }

  if (!content.startsWith("---")) {
    return {
      error: "missing frontmatter (file must start with ---)",
      fields: {},
    };
  }

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { error: "unclosed frontmatter (no closing ---)", fields: {} };
  }

  const yaml = content.slice(4, endIdx);
  const fields = {};
  for (const line of yaml.split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) {
      fields[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return { error: null, fields };
}

// ── Validate ───────────────────────────────────────────────────────
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function validate(file) {
  const issues = [];
  const content = readFileSync(file.path, "utf-8");
  const { error, fields } = parseFrontmatter(content);

  if (error) {
    issues.push(error);
    return issues; // can't validate fields if frontmatter is broken
  }

  // name
  if (!fields.name) {
    issues.push("missing `name` field");
  } else if (file.type === "skill") {
    // Skills: name must be lowercase-hyphens per spec
    if (!NAME_RE.test(fields.name)) {
      issues.push(
        `name "${fields.name}" must be lowercase-hyphens only (a-z, 0-9, -)`,
      );
    }
    if (fields.name.length > 64) {
      issues.push(
        `name "${fields.name}" exceeds 64 chars (${fields.name.length})`,
      );
    }
  }
  // Agents: name is a display name (emojis, spaces OK). File name is the identifier.

  // description
  if (!fields.description) {
    issues.push("missing `description` field");
  } else if (fields.description.length > 1024) {
    issues.push(
      `description exceeds 1024 chars (${fields.description.length})`,
    );
  }

  return issues;
}

// ── Main ───────────────────────────────────────────────────────────
const files = [...collectSkills(), ...collectAgents()];
let totalIssues = 0;

console.log(`Validating ${files.length} files...\n`);

for (const file of files) {
  const issues = validate(file);
  if (issues.length > 0) {
    const rel = relative(ROOT, file.path);
    console.log(`❌ ${rel}`);
    for (const issue of issues) {
      console.log(`   → ${issue}`);
    }
    totalIssues += issues.length;
  }
}

if (totalIssues === 0) {
  console.log(`✅ All ${files.length} files passed validation.`);
  process.exit(0);
} else {
  console.log(
    `\n❌ ${totalIssues} issue(s) found across ${files.length} files.`,
  );
  process.exit(1);
}
