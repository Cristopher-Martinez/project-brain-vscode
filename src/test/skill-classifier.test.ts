import * as assert from "assert";
import { classifySkill } from "../skill-manager";

suite("Skill Auto-Classifier", () => {
  // ─── Workflow category ──────────────────────────────────────────────

  test("classifies build/deploy skills as workflow", () => {
    assert.strictEqual(
      classifySkill(
        "extension-build",
        "Build, compile, and deploy the VS Code extension",
        "## Steps\n1. Run npm run compile\n2. Deploy to extension folder",
      ),
      "workflow",
    );
  });

  test("classifies git-workflow as workflow", () => {
    assert.strictEqual(
      classifySkill(
        "git-workflow",
        "Manage git operations — commits, branches, PRs",
        "## Instructions\nUse git commit and branch management",
      ),
      "workflow",
    );
  });

  test("classifies session-recap as workflow", () => {
    assert.strictEqual(
      classifySkill(
        "session-recap",
        "Summarize the current session and save a handoff",
        "## Steps\nWrite to 07_SESSION_HANDOFF.md",
      ),
      "workflow",
    );
  });

  test("classifies doc-updater as workflow", () => {
    assert.strictEqual(
      classifySkill(
        "doc-updater",
        "Update project memory after each logical unit of work",
        "## When to use\nAfter feature, fix, or refactor",
      ),
      "workflow",
    );
  });

  // ─── Diagnostic category ───────────────────────────────────────────

  test("classifies troubleshoot as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "troubleshoot",
        "Systematic debugging methodology that learns from every fix",
        "## Steps\n1. Reproduce the error\n2. Check logs",
      ),
      "diagnostic",
    );
  });

  test("classifies debug-extension as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "debug-extension",
        "Debug and troubleshoot the Project Brain VS Code extension",
        "## Steps\n1. Check Debug Console for errors",
      ),
      "diagnostic",
    );
  });

  test("classifies qa-master as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "qa-master",
        "Full QA validation protocol with 8 levels for SaaS backend",
        "## Levels\nSmoke → Integration → Security",
      ),
      "diagnostic",
    );
  });

  test("classifies dependency-audit as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "dependency-audit",
        "Audit project dependencies for vulnerabilities and updates",
        "## Steps\nRun npm audit",
      ),
      "diagnostic",
    );
  });

  test("classifies test-generator as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "test-generator",
        "Generate tests based on existing code and project patterns",
        "## How\nAnalyze code and generate test cases",
      ),
      "diagnostic",
    );
  });

  test("classifies code-review as diagnostic", () => {
    assert.strictEqual(
      classifySkill(
        "code-review",
        "Review code changes for bugs, style issues, and improvements",
        "## Steps\n1. Read diff\n2. Check patterns",
      ),
      "diagnostic",
    );
  });

  // ─── Workflow extras ──────────────────────────────────────────────

  test("classifies embedding-setup as workflow", () => {
    assert.strictEqual(
      classifySkill(
        "embedding-setup",
        "Set up the embedding provider for Brain memory vectorization. Use when embeddings are not configured.",
        "## Steps\nConfigure cloudflare API key, set provider",
      ),
      "workflow",
    );
  });

  // ─── Reference category ────────────────────────────────────────────

  test("classifies refactoring-guru as reference", () => {
    assert.strictEqual(
      classifySkill(
        "refactoring-guru",
        "Complete refactoring reference — code smells catalog, 66 techniques",
        "## Catalog\n### Extract Method\n### Inline Variable",
      ),
      "reference",
    );
  });

  test("classifies graph-patterns as reference", () => {
    assert.strictEqual(
      classifySkill(
        "graph-patterns",
        "Knowledge graph extraction patterns reference",
        "## Patterns\nHAS_TONE, HAS_BACKSTORY",
      ),
      "reference",
    );
  });

  test("classifies vscode-agents-mastery as reference", () => {
    assert.strictEqual(
      classifySkill(
        "vscode-agents-mastery",
        "Comprehensive reference for VS Code Copilot agents ecosystem",
        "## Agent types\nLocal, background, cloud",
      ),
      "reference",
    );
  });

  test("classifies mcp-tools-pattern as reference", () => {
    assert.strictEqual(
      classifySkill(
        "mcp-tools-pattern",
        "Pattern for adding new MCP tools to the rag-docs server",
        "## Steps\nAdd to ListToolsRequestSchema",
      ),
      "reference",
    );
  });

  // ─── Agent-internal category ───────────────────────────────────────

  test("classifies context-management as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "context-management",
        "Prevent context overflow by delegating heavy reads/writes to subagents",
        "## Strategy\nDelegate to slaves when context pressure rises",
      ),
      "agent-internal",
    );
  });

  test("classifies completion-guard as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "completion-guard",
        "Force the agent to always end every completed request with a quick pick",
        "## Rule\nAlways offer follow-up actions",
      ),
      "agent-internal",
    );
  });

  test("classifies session-spawn as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "session-spawn",
        "Protocol for spawning new chat sessions when context window is running low",
        "## Steps\nDetect context pressure and spawn",
      ),
      "agent-internal",
    );
  });

  test("classifies orchestration-strategy as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "orchestration-strategy",
        "Decision framework for choosing ModelRouter slaves vs runSubagent",
        "## Criteria\nDelegation complexity",
      ),
      "agent-internal",
    );
  });

  test("classifies batch-mode as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "batch-mode",
        "Execute multiple commands from a file in a single message",
        "## How\nRead commands, batch process",
      ),
      "agent-internal",
    );
  });

  test("classifies identity-persistence as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "identity-persistence",
        "Prevent agent personality drift during long autonomous execution",
        "## Strategy\nPostToolUse hooks reinforce identity",
      ),
      "agent-internal",
    );
  });

  test("classifies agent-handoff-integrity as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "agent-handoff-integrity",
        "Prevent broken subagent handoffs caused by name mismatches",
        "## Solves\nSubagent handoff buttons fail because name mismatch",
      ),
      "agent-internal",
    );
  });

  test("classifies self-upgrade as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "self-upgrade",
        "Pattern for giving Brain new capabilities through the Toolbox multiplexer",
        "## Rule\nAll new tools go into the toolbox",
      ),
      "agent-internal",
    );
  });

  test("classifies skill-creator as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "skill-creator",
        "Create or update skills for Project Brain",
        "## Steps\nIdentify, name, write SKILL.md",
      ),
      "agent-internal",
    );
  });

  test("classifies workspace-awareness as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "workspace-awareness",
        "Gather and report all available workspace context",
        "## How\nCollect open files, errors, git state",
      ),
      "agent-internal",
    );
  });

  test("classifies review-loop as agent-internal", () => {
    assert.strictEqual(
      classifySkill(
        "review-loop",
        "Interactive assistant mode using ask_questions for rapid iteration",
        "## Pattern\nDrive interaction via quick-pick forms",
      ),
      "agent-internal",
    );
  });

  // ─── User-facing category ─────────────────────────────────────────

  test("classifies teach-brain as user-facing", () => {
    assert.strictEqual(
      classifySkill(
        "teach-brain",
        "Teach the AI about your project conventions and preferences",
        "## How\nUser says 'remember that...'",
      ),
      "user-facing",
    );
  });

  test("classifies remember-this as user-facing", () => {
    assert.strictEqual(
      classifySkill(
        "remember-this",
        "Save something important to project memory",
        "## Triggers\nUser says 'remember this'",
      ),
      "user-facing",
    );
  });

  test("classifies project-status as user-facing", () => {
    assert.strictEqual(
      classifySkill(
        "project-status",
        "Show a dashboard of the project's current state",
        "## Output\nHealth metrics, progress, blockers",
      ),
      "user-facing",
    );
  });

  test("classifies what-changed as user-facing", () => {
    assert.strictEqual(
      classifySkill(
        "what-changed",
        "Show what changed in the project recently",
        "## How\nCheck git log and uncommitted changes",
      ),
      "user-facing",
    );
  });

  test("classifies onboarding as user-facing", () => {
    assert.strictEqual(
      classifySkill(
        "onboarding",
        "Help new developers understand the codebase using project memory",
        "## Steps\nWalk through architecture, key files",
      ),
      "user-facing",
    );
  });

  // ─── Strategy category ────────────────────────────────────────────

  test("classifies tdd-first as strategy", () => {
    assert.strictEqual(
      classifySkill(
        "tdd-first",
        "Test-driven development approach",
        "## Strategy\nWrite tests before implementation",
      ),
      "strategy",
    );
  });

  test("classifies prototype-fast as strategy", () => {
    assert.strictEqual(
      classifySkill(
        "prototype-fast",
        "Rapid prototyping methodology",
        "## Strategy\nBuild minimal POC first",
      ),
      "strategy",
    );
  });

  test("classifies incremental-safe as strategy", () => {
    assert.strictEqual(
      classifySkill(
        "incremental-safe",
        "Incremental development with safety checks",
        "## Approach\nSmall changes, frequent validation",
      ),
      "strategy",
    );
  });

  // ─── Security category ────────────────────────────────────────────

  test("classifies security-focused skills", () => {
    assert.strictEqual(
      classifySkill(
        "injection-guard",
        "Prevent prompt injection attacks in LLM interactions",
        "## Rules\nSanitize all user input before passing to models",
      ),
      "security",
    );
  });

  // ─── Fallback to custom ───────────────────────────────────────────

  test("returns custom for unknown skills with no keywords", () => {
    assert.strictEqual(
      classifySkill(
        "my-random-thing",
        "Does something interesting",
        "## Overview\nThis is a unique skill",
      ),
      "custom",
    );
  });

  test("returns custom for empty input", () => {
    assert.strictEqual(classifySkill("", "", ""), "custom");
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  test("name keywords override weak body matches", () => {
    // "debug" in name (diagnostic strong=6) dominates weak body matches
    const result = classifySkill(
      "debug-runner",
      "Fix failing test runner",
      "## Steps\nCheck the test runner logs for errors",
    );
    assert.strictEqual(result, "diagnostic");
  });

  test("strongest category wins when multiple match", () => {
    // Description has both "test" (diagnostic weak) and "strategy" (strategy weak)
    // But name is "tdd" (strategy strong)
    const result = classifySkill(
      "tdd-workflow",
      "Test strategy for the project",
      "Run tests using TDD methodology",
    );
    assert.strictEqual(result, "strategy");
  });

  test("minimum threshold filters weak matches", () => {
    // Only has a single weak keyword in body — should be below threshold (3)
    const result = classifySkill(
      "foo-bar",
      "Some description",
      "This mentions test once in passing",
    );
    assert.strictEqual(result, "custom");
  });
});
