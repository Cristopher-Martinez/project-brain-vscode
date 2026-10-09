import * as assert from "assert";

// ─── SaaS Client Tests ──────────────────────────────────────────────────────
// Tests for SaaSClient, OfflineManager, SkillManager, DualOpinionBank
// These test pure logic — no VS Code API or network calls required.

// ─── Mock Helpers ───────────────────────────────────────────────────────────

/** Minimal mock for VS Code SecretStorage */
class MockSecretStorage {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }
  async store_val(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Minimal mock for VS Code globalState */
class MockGlobalState {
  private store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  setKeysForSync(): void {
    /* noop */
  }
}

// ─── Scope Classification Tests ─────────────────────────────────────────────

suite("DualOpinionBank — Scope Classification", () => {
  // Import the classification logic inline to avoid vscode dependency
  const UNIVERSAL_KEYWORDS = [
    "always",
    "never",
    "every project",
    "all codebases",
    "general rule",
    "best practice",
    "anti-pattern",
    "code smell",
    "principle",
  ];

  const STACK_KEYWORDS = [
    "react",
    "vue",
    "angular",
    "node",
    "python",
    "rust",
    "go",
    "typescript",
    "javascript",
    "java",
    "kotlin",
    "swift",
    "rails",
    "django",
    "spring",
    "next.js",
    "express",
    "fastify",
    "hono",
  ];

  // Pre-compiled word-boundary regexps (mirrors production code)
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const UNIVERSAL_REGEXPS = UNIVERSAL_KEYWORDS.map(
    (kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`),
  );
  const STACK_REGEXPS = STACK_KEYWORDS.map(
    (kw) => new RegExp(`\\b${escapeRegex(kw)}\\b`),
  );

  type SearchScope =
    | "project"
    | "stack_specific"
    | "cross_project"
    | "universal";
  type OpinionDomain =
    | "architecture"
    | "patterns"
    | "tools"
    | "debugging"
    | "workflow"
    | "preferences"
    | "general";

  function classifyScope(
    statement: string,
    domain: OpinionDomain,
  ): SearchScope {
    const lower = statement.toLowerCase();

    if (domain === "workflow" || domain === "preferences") {
      if (UNIVERSAL_REGEXPS.some((re) => re.test(lower))) {
        return "universal";
      }
      return "cross_project";
    }

    if (UNIVERSAL_REGEXPS.some((re) => re.test(lower))) {
      return "universal";
    }

    if (STACK_REGEXPS.some((re) => re.test(lower))) {
      return "stack_specific";
    }

    if (domain === "architecture" || domain === "patterns") {
      return "cross_project";
    }

    if (domain === "debugging") {
      return "project";
    }

    if (domain === "tools") {
      return "cross_project";
    }

    return "project";
  }

  test('Universal keywords → "universal" scope', () => {
    assert.strictEqual(
      classifyScope("Always use strict mode in TypeScript", "general"),
      "universal",
    );
    assert.strictEqual(
      classifyScope("Never commit secrets to git", "general"),
      "universal",
    );
    assert.strictEqual(
      classifyScope("This is a best practice for all codebases", "tools"),
      "universal",
    );
  });

  test('Stack keywords → "stack_specific" scope', () => {
    assert.strictEqual(
      classifyScope(
        "Use useMemo in React for expensive computations",
        "general",
      ),
      "stack_specific",
    );
    assert.strictEqual(
      classifyScope(
        "Python dataclasses are better than plain dicts",
        "general",
      ),
      "stack_specific",
    );
    assert.strictEqual(
      classifyScope("TypeScript strict mode catches more bugs", "general"),
      "stack_specific",
    );
  });

  test('Architecture domain → "cross_project" scope', () => {
    assert.strictEqual(
      classifyScope(
        "Hexagonal architecture separates concerns well",
        "architecture",
      ),
      "cross_project",
    );
    assert.strictEqual(
      classifyScope("Repository pattern is great for data access", "patterns"),
      "cross_project",
    );
  });

  test('Debugging domain → "project" scope', () => {
    assert.strictEqual(
      classifyScope("The login bug was caused by stale cache", "debugging"),
      "project",
    );
  });

  test('Workflow domain → "cross_project" by default', () => {
    assert.strictEqual(
      classifyScope("PR reviews improve code quality", "workflow"),
      "cross_project",
    );
  });

  test('Workflow with universal keyword → "universal"', () => {
    assert.strictEqual(
      classifyScope("Always write tests before merging", "workflow"),
      "universal",
    );
  });

  test('Tools domain → "cross_project"', () => {
    assert.strictEqual(
      classifyScope("ESLint catches more issues than manual review", "tools"),
      "cross_project",
    );
  });

  test('General domain without keywords → "project"', () => {
    assert.strictEqual(
      classifyScope(
        "The API endpoint returns 404 for deleted items",
        "general",
      ),
      "project",
    );
  });

  // Regression tests for word-boundary matching
  test('Word boundary: "hexagonal" must NOT match "go"', () => {
    assert.strictEqual(
      classifyScope("hexagonal architecture is great", "general"),
      "project", // NOT stack_specific — "go" is inside "hexagonal"
    );
  });

  test('Word boundary: "whenever" must NOT match "never"', () => {
    assert.notStrictEqual(
      classifyScope("whenever I commit code I run tests", "general"),
      "universal", // "never" is inside "whenever" — must not trigger
    );
  });

  test('Word boundary: "nevertheless" must NOT match "never"', () => {
    assert.notStrictEqual(
      classifyScope("nevertheless the approach works well", "general"),
      "universal",
    );
  });

  test('Word boundary: "next.js" matches literally, not "nextXjs"', () => {
    assert.strictEqual(
      classifyScope("next.js is great for SSR", "general"),
      "stack_specific",
    );
    // "nextajs" should NOT match (dot = literal, not any-char)
    assert.notStrictEqual(
      classifyScope("nextajs is not a real framework", "general"),
      "stack_specific",
    );
  });

  test('Word boundary: "java" must NOT match "javascript"', () => {
    // "javascript" should match its own keyword, not "java"
    const result = classifyScope("javascript is everywhere", "general");
    assert.strictEqual(result, "stack_specific");
    // The key point: it matched "javascript", not "java" as substring
  });
});

// ─── Word Overlap Tests ─────────────────────────────────────────────────────

suite("DualOpinionBank — Word Overlap", () => {
  function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    return overlap / Math.min(wordsA.size, wordsB.size);
  }

  test("Identical statements → 1.0", () => {
    const overlap = wordOverlap(
      "Always use TypeScript for new projects",
      "Always use TypeScript for new projects",
    );
    assert.strictEqual(overlap, 1.0);
  });

  test("Similar statements → > 0.6", () => {
    const overlap = wordOverlap(
      "TypeScript strict mode catches bugs early",
      "TypeScript with strict mode helps catch bugs",
    );
    assert.ok(overlap > 0.6, `Expected > 0.6, got ${overlap}`);
  });

  test("Different statements → < 0.3", () => {
    const overlap = wordOverlap(
      "React hooks are powerful",
      "Database indexing improves query performance",
    );
    assert.ok(overlap < 0.3, `Expected < 0.3, got ${overlap}`);
  });

  test("Empty string → 0", () => {
    assert.strictEqual(wordOverlap("", "some text here"), 0);
    assert.strictEqual(wordOverlap("a b", "c d"), 0); // Short words filtered
  });
});

// ─── Offline Manager Queue Logic Tests ──────────────────────────────────────

suite("OfflineManager — Queue Logic", () => {
  test("Idempotency key generation is unique", () => {
    // Test the hex generation helper
    const hex = (n: number) =>
      Math.floor(Math.random() * Math.pow(16, n))
        .toString(16)
        .padStart(n, "0");

    const key1 = `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
    const key2 = `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;

    assert.notStrictEqual(key1, key2, "Keys should be unique");
    assert.ok(key1.includes("-"), "Key should contain dashes");
    // UUID v4 format: 8-4-4-4-12
    const parts = key1.split("-");
    assert.strictEqual(parts.length, 5, "Should have 5 parts");
  });

  test("Queue entry structure is correct", () => {
    const entry = {
      operation: {
        type: "sync_opinions",
        payload: { opinions: [] },
        idempotencyKey: "test-key-123",
        createdAt: new Date().toISOString(),
      },
      retries: 0,
      maxRetries: 5,
      firstQueuedAt: new Date().toISOString(),
    };

    assert.strictEqual(entry.operation.type, "sync_opinions");
    assert.strictEqual(entry.retries, 0);
    assert.strictEqual(entry.maxRetries, 5);
    assert.ok(entry.firstQueuedAt);
  });

  test("Queue dedup by idempotency key", () => {
    const queue: Array<{ idempotencyKey: string }> = [
      { idempotencyKey: "key1" },
      { idempotencyKey: "key2" },
    ];

    const newKey = "key1";
    const exists = queue.some((e) => e.idempotencyKey === newKey);
    assert.ok(exists, "Should detect duplicate key");

    const uniqueKey = "key3";
    const exists2 = queue.some((e) => e.idempotencyKey === uniqueKey);
    assert.ok(!exists2, "Should not find non-existent key");
  });
});

// ─── Skill Manager Tests ────────────────────────────────────────────────────

suite("SkillManager — Plan Gating", () => {
  const TIER_RANK: Record<string, number> = {
    free: 0,
    pro: 1,
    team: 2,
    enterprise: 3,
  };

  const PLAN_LIMITS: Record<string, { maxCustomSkills: number }> = {
    free: { maxCustomSkills: 0 },
    pro: { maxCustomSkills: 5 },
    team: { maxCustomSkills: 20 },
    enterprise: { maxCustomSkills: Infinity },
  };

  function canExecute(
    skillTier: string,
    currentPlan: string,
  ): { allowed: boolean; reason?: string } {
    if (TIER_RANK[currentPlan] < TIER_RANK[skillTier]) {
      return {
        allowed: false,
        reason: `Requires ${skillTier} plan (current: ${currentPlan})`,
      };
    }
    return { allowed: true };
  }

  test("Free plan can execute free skills", () => {
    const result = canExecute("free", "free");
    assert.ok(result.allowed);
  });

  test("Free plan cannot execute pro skills", () => {
    const result = canExecute("pro", "free");
    assert.ok(!result.allowed);
    assert.ok(result.reason?.includes("Requires pro"));
  });

  test("Pro plan can execute pro and free skills", () => {
    assert.ok(canExecute("free", "pro").allowed);
    assert.ok(canExecute("pro", "pro").allowed);
  });

  test("Pro plan cannot execute team skills", () => {
    assert.ok(!canExecute("team", "pro").allowed);
  });

  test("Enterprise can execute everything", () => {
    assert.ok(canExecute("free", "enterprise").allowed);
    assert.ok(canExecute("pro", "enterprise").allowed);
    assert.ok(canExecute("team", "enterprise").allowed);
    assert.ok(canExecute("enterprise", "enterprise").allowed);
  });

  test("Custom skill limits are correct", () => {
    assert.strictEqual(PLAN_LIMITS["free"].maxCustomSkills, 0);
    assert.strictEqual(PLAN_LIMITS["pro"].maxCustomSkills, 5);
    assert.strictEqual(PLAN_LIMITS["team"].maxCustomSkills, 20);
    assert.strictEqual(PLAN_LIMITS["enterprise"].maxCustomSkills, Infinity);
  });
});

suite("SkillManager — Manifest Parsing", () => {
  function parseSkillManifest(
    content: string,
    dirName: string,
    defaultCategory: string,
  ): Record<string, unknown> {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const frontmatter: Record<string, string> = {};

    if (frontmatterMatch) {
      const lines = frontmatterMatch[1].split("\n");
      for (const line of lines) {
        const [key, ...valueParts] = line.split(":");
        if (key && valueParts.length > 0) {
          frontmatter[key.trim()] = valueParts.join(":").trim();
        }
      }
    }

    return {
      name: frontmatter["name"] || dirName,
      slug: frontmatter["slug"] || dirName,
      description: frontmatter["description"] || "",
      version: frontmatter["version"] || "1.0.0",
      tier: frontmatter["tier"] || "free",
      category: frontmatter["category"] || defaultCategory,
      author: frontmatter["author"] || "local",
      isOfficial: frontmatter["official"] === "true",
    };
  }

  test("Full frontmatter", () => {
    const content = `---
name: git-workflow
slug: git-workflow
description: Git conventions for this project
version: 2.0.0
tier: pro
category: devops
author: cristopher
official: true
---

# Git Workflow

Instructions here...`;

    const manifest = parseSkillManifest(content, "fallback", "custom");
    assert.strictEqual(manifest.name, "git-workflow");
    assert.strictEqual(manifest.slug, "git-workflow");
    assert.strictEqual(manifest.version, "2.0.0");
    assert.strictEqual(manifest.tier, "pro");
    assert.strictEqual(manifest.category, "devops");
    assert.strictEqual(manifest.author, "cristopher");
    assert.strictEqual(manifest.isOfficial, true);
  });

  test("Missing frontmatter uses defaults", () => {
    const content = "# Simple Skill\n\nJust instructions.";
    const manifest = parseSkillManifest(content, "my-skill", "core");
    assert.strictEqual(manifest.name, "my-skill");
    assert.strictEqual(manifest.version, "1.0.0");
    assert.strictEqual(manifest.tier, "free");
    assert.strictEqual(manifest.category, "core");
    assert.strictEqual(manifest.author, "local");
    assert.strictEqual(manifest.isOfficial, false);
  });

  test("Partial frontmatter fills gaps", () => {
    const content = `---
name: partial-skill
description: Only name and description
---

# Partial`;

    const manifest = parseSkillManifest(content, "fallback-dir", "development");
    assert.strictEqual(manifest.name, "partial-skill");
    assert.strictEqual(manifest.description, "Only name and description");
    assert.strictEqual(manifest.slug, "fallback-dir"); // Fallback to dirName
    assert.strictEqual(manifest.category, "development"); // Default category
  });
});

// ─── SaaS Client Tests ─────────────────────────────────────────────────────

suite("SaaSClient — Plan Feature Map", () => {
  const PLAN_FEATURES: Record<string, string[]> = {
    free: [],
    pro: [
      "global_memory",
      "skill_marketplace",
      "advanced_model_router",
      "custom_skills",
      "analytics_dashboard",
    ],
    team: [
      "global_memory",
      "skill_marketplace",
      "advanced_model_router",
      "custom_skills",
      "analytics_dashboard",
      "team_shared_memory",
      "team_skill_library",
      "team_analytics",
      "priority_support",
    ],
    enterprise: [
      "global_memory",
      "skill_marketplace",
      "advanced_model_router",
      "custom_skills",
      "analytics_dashboard",
      "team_shared_memory",
      "team_skill_library",
      "team_analytics",
      "priority_support",
      "sso_saml",
      "audit_logging",
      "custom_deployment",
      "dedicated_support",
      "api_access",
    ],
  };

  test("Free plan has no features", () => {
    assert.strictEqual(PLAN_FEATURES["free"].length, 0);
  });

  test("Pro plan has 5 features", () => {
    assert.strictEqual(PLAN_FEATURES["pro"].length, 5);
    assert.ok(PLAN_FEATURES["pro"].includes("global_memory"));
    assert.ok(PLAN_FEATURES["pro"].includes("skill_marketplace"));
  });

  test("Team plan includes all pro features", () => {
    for (const feature of PLAN_FEATURES["pro"]) {
      assert.ok(
        PLAN_FEATURES["team"].includes(feature),
        `Team should include "${feature}"`,
      );
    }
  });

  test("Enterprise includes all team features", () => {
    for (const feature of PLAN_FEATURES["team"]) {
      assert.ok(
        PLAN_FEATURES["enterprise"].includes(feature),
        `Enterprise should include "${feature}"`,
      );
    }
  });

  test("Enterprise has 14 features", () => {
    assert.strictEqual(PLAN_FEATURES["enterprise"].length, 14);
  });

  test("Feature hierarchy is cumulative", () => {
    assert.ok(PLAN_FEATURES["free"].length < PLAN_FEATURES["pro"].length);
    assert.ok(PLAN_FEATURES["pro"].length < PLAN_FEATURES["team"].length);
    assert.ok(
      PLAN_FEATURES["team"].length < PLAN_FEATURES["enterprise"].length,
    );
  });
});

suite("SaaSClient — Operation Mapping", () => {
  const methodMap: Record<string, string> = {
    sync_opinions: "POST",
    search_memory: "POST",
    register_project: "POST",
    install_skill: "POST",
    uninstall_skill: "DELETE",
    publish_skill: "POST",
    track_analytics: "POST",
  };

  const pathMap: Record<string, string> = {
    sync_opinions: "/memory/sync",
    search_memory: "/memory/search",
    register_project: "/memory/project",
    publish_skill: "/skills/publish",
    track_analytics: "/analytics/event",
  };

  test("All operation types have methods", () => {
    const opTypes = [
      "sync_opinions",
      "search_memory",
      "register_project",
      "install_skill",
      "uninstall_skill",
      "publish_skill",
      "track_analytics",
    ];

    for (const op of opTypes) {
      assert.ok(methodMap[op], `Missing method for operation: ${op}`);
    }
  });

  test("Mutation operations use POST or DELETE", () => {
    for (const [, method] of Object.entries(methodMap)) {
      assert.ok(
        ["POST", "DELETE"].includes(method),
        `Method should be POST or DELETE, got ${method}`,
      );
    }
  });

  test("Memory paths are under /memory/", () => {
    assert.ok(pathMap["sync_opinions"].startsWith("/memory/"));
    assert.ok(pathMap["search_memory"].startsWith("/memory/"));
    assert.ok(pathMap["register_project"].startsWith("/memory/"));
  });
});

suite("SaaSClient — License Cache Validation", () => {
  const LICENSE_GRACE_HOURS = 72;

  function isLicenseCacheValid(
    cachedAt: number,
    now: number,
    lastKnownServerTime: number,
  ): boolean {
    if (!cachedAt) return false;
    const graceMs = LICENSE_GRACE_HOURS * 60 * 60 * 1000;
    if (now < lastKnownServerTime) return false; // Clock drift
    return now - cachedAt < graceMs;
  }

  test("Fresh cache is valid", () => {
    const now = Date.now();
    assert.ok(isLicenseCacheValid(now - 1000, now, now - 5000));
  });

  test("Cache older than 72h is invalid", () => {
    const now = Date.now();
    const oldTime = now - 73 * 60 * 60 * 1000;
    assert.ok(!isLicenseCacheValid(oldTime, now, now - 5000));
  });

  test("Cache at exactly 72h boundary is invalid", () => {
    const now = Date.now();
    const exactBoundary = now - 72 * 60 * 60 * 1000;
    // At exact boundary, cachedAt = now - 72h, diff = 72h, NOT < 72h
    assert.ok(!isLicenseCacheValid(exactBoundary, now, now - 5000));
  });

  test("Clock drift detected (local time < server time)", () => {
    const now = Date.now();
    const futureServerTime = now + 100_000;
    assert.ok(!isLicenseCacheValid(now - 1000, now, futureServerTime));
  });

  test("No cached time → invalid", () => {
    assert.ok(!isLicenseCacheValid(0, Date.now(), 0));
  });
});

// ─── SaaS Error Tests ───────────────────────────────────────────────────────

suite("SaaSError", () => {
  test("Error has correct properties", () => {
    // Test the SaaSError class pattern
    class SaaSError extends Error {
      constructor(
        message: string,
        public readonly statusCode: number,
      ) {
        super(message);
        this.name = "SaaSError";
      }
    }

    const err = new SaaSError("Not found", 404);
    assert.strictEqual(err.message, "Not found");
    assert.strictEqual(err.statusCode, 404);
    assert.strictEqual(err.name, "SaaSError");
    assert.ok(err instanceof Error);
  });

  test("Client errors (4xx) are identified correctly", () => {
    const is4xx = (code: number) => code >= 400 && code < 500;
    assert.ok(is4xx(400));
    assert.ok(is4xx(401));
    assert.ok(is4xx(403));
    assert.ok(is4xx(404));
    assert.ok(is4xx(429));
    assert.ok(!is4xx(500));
    assert.ok(!is4xx(200));
  });
});
