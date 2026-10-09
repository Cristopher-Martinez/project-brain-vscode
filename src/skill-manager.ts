/**
 * Skill Manager — Plan-gated skill loading, install, and execution.
 *
 * Manages three types of skills:
 * 1. Bundled (core) — Always available, shipped with extension
 * 2. Local custom — In .project-brain/memory/skills/, user-created
 * 3. Remote marketplace — Downloaded from SaaS backend, plan-gated
 *
 * Skills are gated by plan tier:
 * - free: bundled only (core category)
 * - pro: + marketplace skills, up to 5 custom
 * - team: + collaboration skills, up to 20 custom
 * - enterprise: everything, unlimited custom
 */

import * as fs from "fs";
import matter from "gray-matter";
import * as path from "path";
import { ContentHashCache, computeContentHash } from "./content-hash-cache";
import type { FeatureKey, Plan, SaaSClient, SkillListing } from "./saas-client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillCategory =
  | "core"
  | "workflow"
  | "diagnostic"
  | "reference"
  | "agent-internal"
  | "user-facing"
  | "strategy"
  | "security"
  | "custom"
  // Legacy (remote marketplace compat — do not use for local skills)
  | "development"
  | "devops"
  | "ai"
  | "collaboration";

export type SkillPermission =
  | "read_files"
  | "write_files"
  | "execute_commands"
  | "network_access"
  | "git_operations";

export type SkillType = "skill" | "strategy";

export interface SkillManifest {
  name: string;
  slug: string;
  description: string;
  version: string;
  tier: Plan;
  category: SkillCategory;
  type: SkillType;
  author: string;
  isOfficial: boolean;
  dependencies?: string[];
  permissions?: SkillPermission[];
  tags?: string[];
  refinementQuestions?: string[];
}

export interface LoadedSkill {
  manifest: SkillManifest;
  content: string;
  source: "bundled" | "local" | "remote";
  filePath?: string;
}

export interface SkillCheckResult {
  allowed: boolean;
  reason?: string;
}

interface SkillManagerOptions {
  memoryPath: string;
  extensionPath: string;
  saasClient?: SaaSClient;
  log: (msg: string) => void;
}

// ─── Security ───────────────────────────────────────────────────────────────

/** Permissions that require the skill to come from a trusted source (bundled + official). */
const DANGEROUS_PERMISSIONS: SkillPermission[] = [
  "execute_commands",
  "network_access",
];

// ─── Plan Hierarchy ─────────────────────────────────────────────────────────

const TIER_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

const PLAN_LIMITS: Record<Plan, { maxCustomSkills: number }> = {
  free: { maxCustomSkills: 0 },
  pro: { maxCustomSkills: 5 },
  team: { maxCustomSkills: 20 },
  enterprise: { maxCustomSkills: Infinity },
};

// ─── Auto-Classifier ────────────────────────────────────────────────────────

/**
 * Keyword-weighted scoring for automatic skill classification.
 * Analyzes name + description + first 500 chars of body.
 * Each keyword match adds weight to the associated category.
 */
interface ClassifierRule {
  category: SkillCategory;
  /** Keywords that strongly indicate this category (weight 3) */
  strong: string[];
  /** Keywords that weakly indicate this category (weight 1) */
  weak: string[];
}

const CLASSIFIER_RULES: ClassifierRule[] = [
  {
    category: "workflow",
    strong: [
      "deploy",
      "build",
      "compile",
      "release",
      "ci/cd",
      "pipeline",
      "git-workflow",
      "commit",
      "branch",
      "session-recap",
      "doc-updater",
      "embedding-setup",
    ],
    weak: [
      "git",
      "workflow",
      "session",
      "merge",
      "publish",
      "ship",
      "install",
      "changelog",
      "setup",
      "configure",
      "bootstrap",
    ],
  },
  {
    category: "diagnostic",
    strong: [
      "debug",
      "troubleshoot",
      "audit",
      "qa-master",
      "test-generator",
      "cross-platform",
      "dependency-audit",
      "vulnerability",
      "code-review",
    ],
    weak: [
      "test",
      "error",
      "bug",
      "fix",
      "scan",
      "validate",
      "smoke",
      "lint",
      "diagnos",
    ],
  },
  {
    category: "reference",
    strong: [
      "refactoring-guru",
      "catalog",
      "mastery",
      "reference",
      "copilot-source",
      "graph-patterns",
      "mcp-tools-pattern",
      "specification",
    ],
    weak: [
      "pattern",
      "technique",
      "guide",
      "encyclopedia",
      "cheatsheet",
      "documentation",
      "api",
    ],
  },
  {
    category: "agent-internal",
    strong: [
      "identity",
      "orchestration",
      "delegate",
      "model-router",
      "context-management",
      "session-spawn",
      "auto-recall",
      "batch-mode",
      "slave",
      "completion-guard",
      "agent-handoff",
      "self-upgrade",
      "skill-creator",
      "workspace-awareness",
      "review-loop",
    ],
    weak: [
      "agent",
      "context",
      "personality",
      "recall",
      "capture",
      "spawn",
      "batch",
      "router",
      "handoff",
      "multiplexer",
      "toolbox",
      "subagent",
      "quick pick",
      "ask_questions",
    ],
  },
  {
    category: "user-facing",
    strong: [
      "teach-brain",
      "remember-this",
      "what-changed",
      "project-status",
      "onboarding",
    ],
    weak: [
      "teach",
      "remember",
      "status",
      "dashboard",
      "show",
      "overview",
      "explain",
    ],
  },
  {
    category: "strategy",
    strong: [
      "tdd-first",
      "prototype-fast",
      "incremental-safe",
      "refactor-extract",
      "research-then-build",
      "security-first",
      "strategy-picker",
    ],
    weak: [
      "strategy",
      "approach",
      "methodology",
      "tdd",
      "prototype",
      "incremental",
    ],
  },
  {
    category: "security",
    strong: [
      "injection",
      "sanitize",
      "authentication",
      "authorization",
      "permission",
    ],
    weak: [
      "security",
      "auth",
      "token",
      "credential",
      "encrypt",
      "vulnerability",
    ],
  },
];

/**
 * Auto-classify a skill based on its name, description, and content.
 * Returns the best-matching category, or "custom" if no strong match.
 */
export function classifySkill(
  name: string,
  description: string,
  body: string,
): SkillCategory {
  // Build a single text blob: name (weight x3), description (weight x2), body preview (weight x1)
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();
  const bodyPreview = body.slice(0, 500).toLowerCase();

  const scores = new Map<SkillCategory, number>();

  for (const rule of CLASSIFIER_RULES) {
    let score = 0;

    for (const kw of rule.strong) {
      // Name match = strongest signal
      if (nameLower.includes(kw)) score += 6;
      if (descLower.includes(kw)) score += 4;
      if (bodyPreview.includes(kw)) score += 2;
    }

    for (const kw of rule.weak) {
      if (nameLower.includes(kw)) score += 3;
      if (descLower.includes(kw)) score += 2;
      if (bodyPreview.includes(kw)) score += 1;
    }

    if (score > 0) {
      scores.set(rule.category, score);
    }
  }

  if (scores.size === 0) return "custom";

  // Pick highest-scoring category
  let best: SkillCategory = "custom";
  let bestScore = 0;
  for (const [cat, s] of scores) {
    if (s > bestScore) {
      bestScore = s;
      best = cat;
    }
  }

  // Require a minimum confidence threshold (score >= 3) to avoid weak classifications
  return bestScore >= 3 ? best : "custom";
}

// ─── Discovery Validation ───────────────────────────────────────────────────

/** Basic suffix stemming (mirrors lm-tools.ts stemWord) */
function stemForDiscovery(word: string): string {
  if (word.length < 5) return word;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4)
    return word.slice(0, -1);
  return word;
}

/** Stopwords that cause false positives in name matching (mirrors lm-tools.ts) */
const DISCOVERY_STOPWORDS = new Set([
  "end",
  "are",
  "use",
  "set",
  "the",
  "for",
  "and",
  "not",
  "all",
  "any",
  "has",
  "had",
  "was",
  "get",
  "put",
  "run",
  "let",
  "var",
  "new",
  "try",
  "can",
  "may",
  "did",
  "its",
  "own",
  "add",
  "now",
  "top",
  "log",
  "raw",
]);

interface DiscoveryResult {
  query: string;
  score: number;
  wouldBeFound: boolean;
}

/**
 * Simulate how the keyword matcher would score this skill for given queries.
 * Returns whether the skill would be found (score > 0) and the score.
 * Use this to validate skill descriptions before saving.
 */
export function simulateDiscovery(
  name: string,
  description: string,
  testQueries: string[],
): { results: DiscoveryResult[]; warnings: string[] } {
  const results: DiscoveryResult[] = [];
  const warnings: string[] = [];
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();

  for (const query of testQueries) {
    const words = query
      .toLowerCase()
      .split(/[\s\-_,]+/)
      .filter((w) => w.length > 1);
    let score = 0;
    let coverage = 0;

    for (const word of words) {
      const stemmed = stemForDiscovery(word);
      let wscore = 0;

      // Name matching (mirrors skillMatchScore with isNameField=true)
      if (!(word.length <= 3 && DISCOVERY_STOPWORDS.has(word))) {
        if (nameLower.includes(word) || nameLower.includes(stemmed))
          wscore += 3;
      }

      // Description matching (mirrors skillMatchScore with isNameField=false)
      if (descLower.includes(word) || descLower.includes(stemmed)) wscore += 1;

      score += wscore;
      if (wscore > 0) coverage++;
    }

    results.push({ query, score, wouldBeFound: score > 0 });
  }

  // Check for zero-discovery queries
  const unfound = results.filter((r) => !r.wouldBeFound);
  if (unfound.length > 0 && unfound.length === results.length) {
    warnings.push(
      `Skill "${name}" is INVISIBLE — none of the test queries match. ` +
        `Add trigger phrases to the description: "${unfound.map((r) => r.query).join('", "')}"`,
    );
  } else if (unfound.length > 0) {
    warnings.push(
      `These queries won't find the skill: "${unfound.map((r) => r.query).join('", "')}". ` +
        `Consider adding related keywords to the description.`,
    );
  }

  // Check for weak scores (would be found but might lose to competitors)
  const weak = results.filter((r) => r.wouldBeFound && r.score < 4);
  if (weak.length > 0) {
    warnings.push(
      `Low match scores for: ${weak.map((r) => `"${r.query}"(${r.score})`).join(", ")}. ` +
        `Strengthen by using skill name keywords in the description.`,
    );
  }

  return { results, warnings };
}

// ─── SkillManager ───────────────────────────────────────────────────────────

export class SkillManager {
  private localSkills: Map<string, LoadedSkill> = new Map();
  private remoteSkills: Map<string, LoadedSkill> = new Map();
  private bundledSkills: Map<string, LoadedSkill> = new Map();
  private currentPlan: Plan = "free";
  private memoryPath: string;
  private extensionPath: string;
  private saasClient?: SaaSClient;
  private log: (msg: string) => void;
  private contentCache = new ContentHashCache<string>(500);

  constructor(options: SkillManagerOptions) {
    this.memoryPath = options.memoryPath;
    this.extensionPath = options.extensionPath;
    this.saasClient = options.saasClient;
    this.log = options.log;
  }

  /** Initialize: load all skills, sync remote if authenticated. */
  async initialize(plan: Plan): Promise<void> {
    this.currentPlan = plan;

    // 1. Always load bundled skills
    await this.loadBundledSkills();

    // 2. Load local custom skills (.project-brain/memory/skills/)
    await this.loadLocalCustomSkills();

    // 3. Sync remote skills if connected + paid plan (non-blocking — don't delay startup)
    if (this.saasClient && plan !== "free") {
      this.syncRemoteSkills().catch((e) =>
        this.log(
          `[SkillManager] Remote skill sync failed (non-critical): ${e}`,
        ),
      );
    }

    const total =
      this.bundledSkills.size + this.localSkills.size + this.remoteSkills.size;
    this.log(
      `[SkillManager] Initialized: ${this.bundledSkills.size} bundled, ${this.localSkills.size} local, ${this.remoteSkills.size} remote (plan: ${plan})`,
    );
    this.log(`[SkillManager] Total available: ${total}`);
  }

  /** Check if a skill can be executed under the current plan. */
  canExecute(skillName: string): SkillCheckResult {
    const skill = this.get(skillName);
    if (!skill) {
      return { allowed: false, reason: "Skill not found" };
    }

    // Bundled core skills are always allowed
    if (skill.source === "bundled" && skill.manifest.category === "core") {
      return { allowed: true };
    }

    // Check plan tier
    if (TIER_RANK[this.currentPlan] < TIER_RANK[skill.manifest.tier]) {
      return {
        allowed: false,
        reason: `Requires ${skill.manifest.tier} plan (current: ${this.currentPlan})`,
      };
    }

    // Check custom skill limit
    if (skill.source === "local" && skill.manifest.category === "custom") {
      const customCount = this.getCustomSkillCount();
      const limit = PLAN_LIMITS[this.currentPlan].maxCustomSkills;
      if (customCount > limit) {
        return {
          allowed: false,
          reason: `Custom skill limit reached (${limit} for ${this.currentPlan} plan)`,
        };
      }
    }

    // Check feature gate for specific categories
    const featureGates: Partial<Record<SkillCategory, FeatureKey>> = {
      collaboration: "team_skill_library",
      ai: "advanced_model_router",
    };

    const requiredFeature = featureGates[skill.manifest.category];
    if (
      requiredFeature &&
      this.saasClient &&
      !this.saasClient.checkAccess(requiredFeature)
    ) {
      return {
        allowed: false,
        reason: `Feature "${requiredFeature}" not available in ${this.currentPlan} plan`,
      };
    }

    // SECURITY (MED-04): Check dangerous permissions from untrusted sources
    if (skill.manifest.permissions && skill.manifest.permissions.length > 0) {
      const isTrusted =
        skill.source === "bundled" ||
        (skill.source === "remote" && skill.manifest.isOfficial);

      if (!isTrusted) {
        const dangerous = skill.manifest.permissions.filter((p) =>
          DANGEROUS_PERMISSIONS.includes(p),
        );
        if (dangerous.length > 0) {
          this.log(
            `[SkillManager] BLOCKED: Untrusted skill "${skillName}" declares dangerous permissions: ${dangerous.join(", ")}`,
          );
          return {
            allowed: false,
            reason: `Untrusted skill declares dangerous permissions: ${dangerous.join(", ")}. Only bundled or official skills may use ${dangerous.join(", ")}.`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /** Get a skill by name (searches all sources). */
  get(name: string): LoadedSkill | undefined {
    return (
      this.bundledSkills.get(name) ??
      this.localSkills.get(name) ??
      this.remoteSkills.get(name)
    );
  }

  /** Get all loaded skills, optionally filtered by category. */
  getAll(category?: SkillCategory): LoadedSkill[] {
    const all = [
      ...this.bundledSkills.values(),
      ...this.localSkills.values(),
      ...this.remoteSkills.values(),
    ];

    if (category) {
      return all.filter((s) => s.manifest.category === category);
    }
    return all;
  }

  /** Get all loaded skills filtered by type (e.g., "strategy"). */
  getAllByType(type: SkillType): LoadedSkill[] {
    return this.getAll().filter((s) => s.manifest.type === type);
  }

  /** Get skills accessible on the current plan. */
  getAccessible(): LoadedSkill[] {
    return this.getAll().filter(
      (s) => this.canExecute(s.manifest.name).allowed,
    );
  }

  /** Install a skill from the marketplace. */
  async installFromMarketplace(skillId: string): Promise<void> {
    if (!this.saasClient) {
      throw new Error("Not connected to SaaS backend");
    }

    // Check plan allows marketplace
    if (!this.saasClient.checkAccess("skill_marketplace")) {
      throw new Error("Skill marketplace requires Pro plan or higher");
    }

    await this.saasClient.installSkill(skillId);
    // Re-sync to pick up the new skill
    await this.syncRemoteSkills();
    this.log(`[SkillManager] Installed marketplace skill: ${skillId}`);
  }

  /** Uninstall a remote skill. */
  async uninstallSkill(skillId: string): Promise<void> {
    if (!this.saasClient) {
      throw new Error("Not connected to SaaS backend");
    }

    await this.saasClient.uninstallSkill(skillId);

    // Remove from local cache
    for (const [name, skill] of this.remoteSkills) {
      if (name === skillId || skill.manifest.slug === skillId) {
        this.remoteSkills.delete(name);
        break;
      }
    }
    this.log(`[SkillManager] Uninstalled skill: ${skillId}`);
  }

  /** Check for available updates. */
  async checkUpdates(): Promise<
    Array<{ name: string; currentVersion: string; newVersion: string }>
  > {
    if (!this.saasClient) return [];

    try {
      const updates = await this.saasClient.getSkillUpdates();
      return updates.map((u) => ({
        name: u.skillId,
        currentVersion: u.currentVersion,
        newVersion: u.newVersion,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Lazy-load content for a remote skill (fetches from SaaS on demand).
   * Returns the skill with content populated, or undefined if not found.
   */
  async loadSkillContent(name: string): Promise<LoadedSkill | undefined> {
    const skill = this.get(name);
    if (!skill) return undefined;

    // Local/bundled skills already have content
    if (skill.content) return skill;

    // Remote skill with empty content — fetch from SaaS
    if (skill.source === "remote" && this.saasClient) {
      try {
        const detail = await this.saasClient.getSkillContent(
          skill.manifest.slug || skill.manifest.name,
        );
        skill.content = detail.content;
        this.log(
          `[SkillManager] Lazy-loaded content for remote skill: ${name}`,
        );
        return skill;
      } catch (e) {
        this.log(`[SkillManager] Failed to load remote skill content: ${e}`);
        return skill;
      }
    }

    return skill;
  }

  /**
   * Auto-generate test queries from skill name + description for discovery validation.
   * Extracts meaningful words and builds natural-language-like queries.
   */
  private static generateDiscoveryQueries(
    name: string,
    description: string,
  ): string[] {
    const queries: string[] = [];
    // Query 1: the skill name itself (cleaned)
    const nameWords = name.replace(/[-_]/g, " ").trim();
    if (nameWords.length > 2) queries.push(nameWords);

    // Query 2: extract first action phrase from description (before comma/period)
    const firstPhrase = description.split(/[.,;]/)[0]?.trim();
    if (firstPhrase && firstPhrase.length > 5 && firstPhrase.length < 80) {
      queries.push(firstPhrase);
    }

    // Query 3: verb + object pattern from "Use when..." clauses
    const useWhen = description.match(/use when\s+(.+?)(?:[.,]|$)/i);
    if (useWhen && useWhen[1].trim().length > 3) {
      queries.push(useWhen[1].trim());
    }

    return [...new Set(queries)].slice(0, 3);
  }

  /**
   * Validate a skill before publishing to the marketplace.
   * Enforces the 7-Layer Visibility pattern for quality.
   */
  validateForPublish(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check frontmatter exists
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      errors.push("Missing YAML frontmatter (--- ... ---)");
      return { valid: false, errors };
    }

    const fm = fmMatch[1];

    // Check name
    const nameMatch = fm.match(/name:\s*(.+)/);
    if (!nameMatch || !nameMatch[1].trim()) {
      errors.push("Missing 'name' in frontmatter");
    }

    // Check description exists and has quality
    const descMatch = fm.match(/description:\s*(.+)/);
    if (!descMatch || !descMatch[1].trim()) {
      errors.push("Missing 'description' in frontmatter");
    } else {
      const desc = descMatch[1].trim();
      if (desc.length < 50) {
        errors.push(
          `Description too short (${desc.length} chars, min 50). Include: what it does + when to use it + trigger phrases.`,
        );
      }
      // Check for trigger phrases (should have action verbs)
      const hasActionVerb =
        /\b(use when|use if|use for|trigger|run when|apply when|helps? with|debug|fix|deploy|test|review|refactor|create|generate|analyze)\b/i.test(
          desc,
        );
      if (!hasActionVerb) {
        errors.push(
          "Description lacks trigger phrases. Add 'Use when...' or action verbs (debug, deploy, test, review, etc.) so VS Code can match the skill.",
        );
      }

      // Discovery simulation: auto-generate test queries from name + description keywords
      if (nameMatch && nameMatch[1].trim()) {
        const skillName = nameMatch[1].trim();
        const testQueries = SkillManager.generateDiscoveryQueries(
          skillName,
          desc,
        );
        if (testQueries.length > 0) {
          const discovery = simulateDiscovery(skillName, desc, testQueries);
          for (const w of discovery.warnings) {
            errors.push(`[Discovery] ${w}`);
          }
        }
      }
    }

    // Check body content (after frontmatter)
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (body.length < 100) {
      errors.push(
        `Body content too short (${body.length} chars, min 100). Skills need actionable instructions.`,
      );
    }

    // Check for instructions section
    if (!/##\s*(instructions?|steps?|procedure|how to|when to)/i.test(body)) {
      errors.push(
        "Missing 'Instructions' or 'Steps' section. Skills need a clear procedure.",
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /** Publish a local custom skill to the marketplace. */
  async publishSkill(skillName: string): Promise<void> {
    if (!this.saasClient) {
      throw new Error("Not connected to SaaS backend");
    }

    const skill = this.localSkills.get(skillName);
    if (!skill) {
      throw new Error(`Local skill not found: ${skillName}`);
    }

    // Validate quality before publishing
    const validation = this.validateForPublish(skill.content);
    if (!validation.valid) {
      throw new Error(
        `Skill "${skillName}" failed quality validation:\n${validation.errors.map((e) => `  • ${e}`).join("\n")}\n\nFix these issues before publishing. See 7-Layer Visibility Checklist in skill-creator.`,
      );
    }

    await this.saasClient.publishSkill({
      name: skill.manifest.name,
      slug: skill.manifest.slug,
      description: skill.manifest.description,
      content: skill.content,
      version: skill.manifest.version,
    });

    this.log(`[SkillManager] Published skill: ${skillName}`);
  }

  /** Update the plan (e.g., after license refresh). */
  updatePlan(plan: Plan): void {
    this.currentPlan = plan;
    this.log(`[SkillManager] Plan updated to: ${plan}`);
  }

  /** Get total counts by source. */
  get counts(): { bundled: number; local: number; remote: number } {
    return {
      bundled: this.bundledSkills.size,
      local: this.localSkills.size,
      remote: this.remoteSkills.size,
    };
  }

  // ─── Loaders ───────────────────────────────────────────────────────

  private async loadBundledSkills(): Promise<void> {
    // Bundled skills live in static/skills/ (shipped with the extension).
    // The deploy script copies static/ to the installed extension path.
    const bundledDir = path.join(this.extensionPath, "static", "skills");
    if (!fs.existsSync(bundledDir)) {
      // No bundled skills directory — that's fine
      return;
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(bundledDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      // F4: mtime pre-check → hash cache → avoid redundant reads
      const content = this.readCachedContent(skillPath);
      const manifest = this.parseSkillManifest(content, entry.name, "core");

      this.bundledSkills.set(manifest.name, {
        manifest,
        content,
        source: "bundled",
        filePath: skillPath,
      });
    }
  }

  private async loadLocalCustomSkills(): Promise<void> {
    const skillsDir = path.join(this.memoryPath, "skills");
    if (!fs.existsSync(skillsDir)) return;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      // F4: mtime pre-check → hash cache → hot-reload on edit
      const content = this.readCachedContent(skillPath);
      const manifest = this.parseSkillManifest(content, entry.name, "custom");

      this.localSkills.set(manifest.name, {
        manifest,
        content,
        source: "local",
        filePath: skillPath,
      });
    }
  }

  private async syncRemoteSkills(): Promise<void> {
    if (!this.saasClient) return;

    try {
      const listings: SkillListing[] =
        await this.saasClient.listMarketplaceSkills();

      for (const listing of listings) {
        this.remoteSkills.set(listing.name, {
          manifest: {
            name: listing.name,
            slug: listing.slug,
            description: listing.description,
            version: listing.version,
            tier: listing.tier,
            category: (listing.category as SkillCategory) || "development",
            author: listing.author,
            isOfficial: listing.isOfficial,
            type: "skill",
          },
          content: "", // Content loaded on-demand to save memory
          source: "remote",
        });
      }
    } catch (e) {
      this.log(`[SkillManager] Failed to sync remote skills: ${e}`);
    }
  }

  // ─── Cache ─────────────────────────────────────────────────────────

  /**
   * Read file content through the hash cache.
   * Uses mtime pre-check to skip reads when file hasn't changed.
   * Enables hot-reload: edit a SKILL.md → next invocation uses the new version.
   */
  private readCachedContent(filePath: string): string {
    if (!this.contentCache.needsRecheck(filePath)) {
      // mtime unchanged → return cached content without reading disk
      const cached = this.contentCache.getCurrent(filePath);
      if (cached !== undefined) return cached;
    }
    // Cache miss or mtime changed → full read + cache update
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = computeContentHash(content);
    this.contentCache.set(filePath, hash, content);
    return content;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private parseSkillManifest(
    content: string,
    dirName: string,
    defaultCategory: SkillCategory,
  ): SkillManifest {
    // Parse YAML frontmatter with gray-matter (supports arrays, objects, full YAML)
    const { data: fm } = matter(content);

    // Normalize comma-separated strings OR arrays for dependencies/permissions
    const parseCsvOrArray = (val: unknown): string[] | undefined => {
      if (Array.isArray(val)) return val.map(String);
      if (typeof val === "string" && val.trim())
        return val.split(",").map((s) => s.trim());
      return undefined;
    };

    const name = (fm.name as string) || dirName;
    const description = (fm.description as string) || "";
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

    // Auto-classify if no explicit category or if it's the generic default
    let category = fm.category as SkillCategory | undefined;
    if (!category || category === defaultCategory) {
      const autoCategory = classifySkill(name, description, body);
      if (autoCategory !== "custom") {
        category = autoCategory;
        this.log(`[SkillManager] Auto-classified "${name}" → ${autoCategory}`);
      } else {
        category = defaultCategory;
      }
    }

    return {
      name,
      slug: (fm.slug as string) || dirName,
      description,
      version: (fm.version as string) || "1.0.0",
      tier: (fm.tier as Plan) || "free",
      category,
      type: (fm.type as SkillType) || "skill",
      author: (fm.author as string) || "local",
      isOfficial: fm.official === true || fm.official === "true",
      dependencies: parseCsvOrArray(fm.dependencies),
      permissions: parseCsvOrArray(fm.permissions) as
        | SkillPermission[]
        | undefined,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
      refinementQuestions: Array.isArray(fm.refinement_questions)
        ? fm.refinement_questions.map(String)
        : undefined,
    };
  }

  private getCustomSkillCount(): number {
    return Array.from(this.localSkills.values()).filter(
      (s) => s.manifest.category === "custom",
    ).length;
  }
}
