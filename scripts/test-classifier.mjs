/**
 * Test the auto-classifier against ALL real skills in the project.
 * Reads every SKILL.md, extracts frontmatter + body, runs classifySkill().
 *
 * Usage: node scripts/test-classifier.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Import the compiled classifier
const { classifySkill } = await import(
  "file://" + path.join(ROOT, "dist", "skill-manager.js").replace(/\\/g, "/")
);

// ─── Collect all skills ──────────────────────────────────────────────

const SKILL_DIRS = [
  path.join(ROOT, "docs", "memory", "skills"),
  path.join(ROOT, "static", "skills"),
  path.join(ROOT, ".github", "skills"),
];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const fm = match[1];
  const nameMatch = fm.match(/name:\s*(.+)/);
  const descMatch = fm.match(/description:\s*(.+)/);
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    description: descMatch ? descMatch[1].trim() : "",
  };
}

function getBody(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

const results = [];
const seen = new Set();

for (const dir of SKILL_DIRS) {
  if (!fs.existsSync(dir)) continue;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip strategies subfolder
    if (entry.name === "strategies") continue;

    const skillPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;

    // Deduplicate by name
    const content = fs.readFileSync(skillPath, "utf-8");
    const { name, description } = parseFrontmatter(content);
    const skillName = name || entry.name;

    if (seen.has(skillName)) continue;
    seen.add(skillName);

    const body = getBody(content);
    const category = classifySkill(skillName, description, body);

    const relPath = path.relative(ROOT, dir);
    results.push({
      skillName,
      category,
      source: relPath,
      description: description.slice(0, 80),
    });
  }
}

// ─── Print results grouped by category ───────────────────────────────

const grouped = {};
for (const r of results) {
  if (!grouped[r.category]) grouped[r.category] = [];
  grouped[r.category].push(r);
}

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  SKILL AUTO-CLASSIFIER — REAL SKILLS AUDIT");
console.log("═══════════════════════════════════════════════════════════\n");

const categoryOrder = [
  "workflow",
  "diagnostic",
  "reference",
  "agent-internal",
  "user-facing",
  "strategy",
  "security",
  "custom",
];

for (const cat of categoryOrder) {
  const skills = grouped[cat] || [];
  if (skills.length === 0) continue;

  console.log(`\n┌─── ${cat.toUpperCase()} (${skills.length}) ───`);
  for (const s of skills) {
    console.log(`│  ${s.skillName}`);
    console.log(`│    └─ ${s.description}...`);
  }
  console.log(`└───────────────────────────────────────────`);
}

console.log(`\n📊 Total: ${results.length} skills clasificados`);
console.log(
  `   ${Object.entries(grouped)
    .map(([k, v]) => `${k}: ${v.length}`)
    .join(" | ")}`,
);
console.log("");
