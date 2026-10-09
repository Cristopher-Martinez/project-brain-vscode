import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Bootstrapper } from "../bootstrapper";

suite("Bootstrapper Cross-Platform Init Tests", () => {
  const hookScripts = [
    "session-start.mjs",
    "session-stop.mjs",
    "pre-tool-security.mjs",
    "post-tool-capture.mjs",
    "pre-compact.mjs",
    "subagent-start.mjs",
    "subagent-stop.mjs",
    "user-prompt-writer.mjs",
  ];

  const hookLibs = [
    "capture-buffer.mjs",
    "capture-patterns.mjs",
    "constants.mjs",
    "cross-session-analyzer.mjs",
    "dedup-learnings.mjs",
    "fs-utils.mjs",
    "identity-utils.mjs",
    "loop-utils.mjs",
    "memory-scorer.mjs",
    "minisearch.mjs",
    "opinion-tracker.mjs",
    "plan-utils.mjs",
    "sanitize.mjs",
    "search-cache.mjs",
    "session-diary.mjs",
    "smart-consolidator.mjs",
    "context-predictor.mjs",
    "entity-graph.mjs",
  ];

  const subagents = [
    "researcher.agent.md",
    "documenter.agent.md",
    "reviewer.agent.md",
    "onboard.agent.md",
    "planner.agent.md",
  ];

  const prompts = [
    "ask-project.prompt.md",
    "explain-this.prompt.md",
    "find-expert.prompt.md",
    "recall.prompt.md",
    "recap.prompt.md",
    "recent-changes.prompt.md",
    "status.prompt.md",
    "teach.prompt.md",
  ];

  const skills = [
    "orchestration-strategy",
    "project-status",
    "remember-this",
    "teach-brain",
    "what-changed",
  ];

  const tempRoots: string[] = [];

  setup(() => {
    tempRoots.length = 0;
  });

  teardown(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function seedStaticAssets(extensionPath: string) {
    const staticRoot = path.join(extensionPath, "static");
    fs.mkdirSync(path.join(staticRoot, "hooks", "scripts"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(staticRoot, "agents"), { recursive: true });
    fs.mkdirSync(path.join(staticRoot, "prompts"), { recursive: true });
    fs.mkdirSync(path.join(staticRoot, "skills"), { recursive: true });

    fs.writeFileSync(
      path.join(staticRoot, "hooks", "hooks.json"),
      JSON.stringify({ _source: "project-brain", hooks: {} }, null, 2),
      "utf-8",
    );

    for (const script of hookScripts) {
      fs.writeFileSync(
        path.join(staticRoot, "hooks", "scripts", script),
        "// hook",
        "utf-8",
      );
    }

    // Seed lib modules
    fs.mkdirSync(path.join(staticRoot, "hooks", "scripts", "lib"), {
      recursive: true,
    });
    for (const lib of hookLibs) {
      fs.writeFileSync(
        path.join(staticRoot, "hooks", "scripts", "lib", lib),
        "// lib module",
        "utf-8",
      );
    }

    for (const agent of subagents) {
      fs.writeFileSync(
        path.join(staticRoot, "agents", agent),
        "# agent",
        "utf-8",
      );
    }

    for (const prompt of prompts) {
      fs.writeFileSync(
        path.join(staticRoot, "prompts", prompt),
        "# prompt",
        "utf-8",
      );
    }

    for (const skill of skills) {
      const skillDir = path.join(staticRoot, "skills", skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# skill", "utf-8");
    }
  }

  async function runGenerate(extensionPath: string, workspacePath: string) {
    const folder = {
      uri: vscode.Uri.file(workspacePath),
      name: "workspace",
      index: 0,
    } as vscode.WorkspaceFolder;

    const context = { extensionPath } as vscode.ExtensionContext;
    const bootstrapper = new Bootstrapper(folder, context);
    await bootstrapper.generateHooksAndAssets();
  }

  function countFiles(root: string): number {
    let total = 0;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isFile()) {
        total += 1;
      } else if (entry.isDirectory()) {
        total += countFiles(full);
      }
    }
    return total;
  }

  test("generateHooksAndAssets works with Windows-style extensionPath", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pb-bootstrap-win-"),
    );
    tempRoots.push(tempRoot);

    const extensionPathFs = path.join(tempRoot, "extension-win");
    const workspacePath = path.join(tempRoot, "workspace-win");
    fs.mkdirSync(extensionPathFs, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });

    seedStaticAssets(extensionPathFs);

    const extensionPathWindows = extensionPathFs.replace(/\//g, "\\");
    await runGenerate(extensionPathWindows, workspacePath);

    const githubPath = path.join(workspacePath, ".github");
    assert.ok(fs.existsSync(githubPath), "Should create .github directory");
    assert.ok(fs.existsSync(path.join(githubPath, "hooks", "hooks.json")));
    assert.ok(
      fs.existsSync(path.join(githubPath, "agents", "reviewer.agent.md")),
    );
    assert.ok(
      fs.existsSync(path.join(githubPath, "prompts", "status.prompt.md")),
    );
    assert.ok(
      fs.existsSync(
        path.join(githubPath, "skills", "project-status", "SKILL.md"),
      ),
    );

    const total = countFiles(githubPath);
    assert.ok(total >= 24, "Should deploy all static assets");
  });

  test("generateHooksAndAssets works with POSIX-style extensionPath", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pb-bootstrap-posix-"),
    );
    tempRoots.push(tempRoot);

    const extensionPathFs = path.join(tempRoot, "extension-posix");
    const workspacePath = path.join(tempRoot, "workspace-posix");
    fs.mkdirSync(extensionPathFs, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });

    seedStaticAssets(extensionPathFs);

    const extensionPathPosix = extensionPathFs.replace(/\\/g, "/");
    await runGenerate(extensionPathPosix, workspacePath);

    const githubPath = path.join(workspacePath, ".github");
    assert.ok(fs.existsSync(githubPath), "Should create .github directory");
    assert.ok(fs.existsSync(path.join(githubPath, "hooks", "hooks.json")));
    assert.ok(
      fs.existsSync(path.join(githubPath, "agents", "onboard.agent.md")),
    );
    assert.ok(
      fs.existsSync(path.join(githubPath, "prompts", "teach.prompt.md")),
    );
    assert.ok(
      fs.existsSync(
        path.join(githubPath, "skills", "what-changed", "SKILL.md"),
      ),
    );

    const total = countFiles(githubPath);
    assert.ok(total >= 24, "Should deploy all static assets");
  });
});

// ─── Advanced Init Tests ──────────────────────────────────────────────────────
suite("Bootstrapper Advanced Init — Hook Injection & Content Integrity", () => {
  const tempRoots: string[] = [];

  const ALL_HOOK_SCRIPTS = [
    "session-start.mjs",
    "session-stop.mjs",
    "pre-tool-security.mjs",
    "post-tool-capture.mjs",
    "pre-compact.mjs",
    "subagent-start.mjs",
    "subagent-stop.mjs",
    "user-prompt-writer.mjs",
  ];
  const ALL_SUBAGENTS = [
    "researcher.agent.md",
    "documenter.agent.md",
    "reviewer.agent.md",
    "onboard.agent.md",
    "planner.agent.md",
  ];
  const ALL_PROMPTS = [
    "ask-project.prompt.md",
    "explain-this.prompt.md",
    "find-expert.prompt.md",
    "recall.prompt.md",
    "recap.prompt.md",
    "recent-changes.prompt.md",
    "status.prompt.md",
    "teach.prompt.md",
  ];
  const ALL_SKILLS = [
    "orchestration-strategy",
    "project-status",
    "remember-this",
    "teach-brain",
    "what-changed",
  ];

  teardown(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Seeds a minimal static/ directory (like the deployed extension)
   * with real content we can verify post-bootstrapping.
   */
  function seedStatic(extensionPath: string) {
    const staticRoot = path.join(extensionPath, "static");
    fs.mkdirSync(path.join(staticRoot, "hooks", "scripts"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(staticRoot, "agents"), { recursive: true });
    fs.mkdirSync(path.join(staticRoot, "prompts"), { recursive: true });

    // hooks.json with _source tag and real event structure
    const hooksJson = {
      _source: "project-brain",
      hooks: {
        SessionStart: [
          {
            type: "command",
            command: "node .project-brain/hooks/scripts/session-start.mjs",
            windows: "node .project-brain/hooks/scripts/session-start.mjs",
            timeout: 10,
          },
        ],
        Stop: [
          {
            type: "command",
            command: "node .project-brain/hooks/scripts/session-stop.mjs",
            windows: "node .project-brain/hooks/scripts/session-stop.mjs",
            timeout: 15,
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(staticRoot, "hooks", "hooks.json"),
      JSON.stringify(hooksJson, null, 2),
      "utf-8",
    );

    // Hook scripts with traceable content
    for (const script of ALL_HOOK_SCRIPTS) {
      fs.writeFileSync(
        path.join(staticRoot, "hooks", "scripts", script),
        `// HOOK: ${script}\nexport default async function() { return {}; }\n`,
        "utf-8",
      );
    }

    // Subagents with traceable headers
    for (const agent of ALL_SUBAGENTS) {
      fs.writeFileSync(
        path.join(staticRoot, "agents", agent),
        `---\nname: ${agent.replace(".agent.md", "")}\n---\n# ${agent}\n`,
        "utf-8",
      );
    }

    // Prompts with traceable content
    for (const prompt of ALL_PROMPTS) {
      fs.writeFileSync(
        path.join(staticRoot, "prompts", prompt),
        `---\nname: ${prompt.replace(".prompt.md", "")}\n---\n# ${prompt}\n`,
        "utf-8",
      );
    }

    // Skills with SKILL.md
    for (const skill of ALL_SKILLS) {
      const skillDir = path.join(staticRoot, "skills", skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `# Skill: ${skill}\n\nThis skill does X.\n`,
        "utf-8",
      );
    }
  }

  function createEnv() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-adv-"));
    tempRoots.push(tempRoot);
    const extensionPath = path.join(tempRoot, "ext");
    const workspacePath = path.join(tempRoot, "ws");
    fs.mkdirSync(extensionPath, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    seedStatic(extensionPath);
    return { extensionPath, workspacePath, tempRoot };
  }

  async function runGenerate(extensionPath: string, workspacePath: string) {
    const folder = {
      uri: vscode.Uri.file(workspacePath),
      name: "workspace",
      index: 0,
    } as vscode.WorkspaceFolder;
    const context = { extensionPath } as vscode.ExtensionContext;
    const bootstrapper = new Bootstrapper(folder, context);
    await bootstrapper.generateHooksAndAssets();
  }

  // ── 1. Every hook script is deployed ────────────────────────────────────
  test("All 8 hook scripts are deployed to .project-brain/hooks/scripts/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    for (const script of ALL_HOOK_SCRIPTS) {
      const dest = path.join(
        workspacePath,
        ".project-brain",
        "hooks",
        "scripts",
        script,
      );
      assert.ok(fs.existsSync(dest), `Missing hook: ${script}`);
    }
  });

  // ── 2. Hook scripts have real content (not empty) ──────────────────────
  test("Deployed hook scripts contain original content", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    for (const script of ALL_HOOK_SCRIPTS) {
      const dest = path.join(
        workspacePath,
        ".project-brain",
        "hooks",
        "scripts",
        script,
      );
      const content = fs.readFileSync(dest, "utf-8");
      assert.ok(content.length > 10, `Hook ${script} should not be empty`);
      assert.ok(
        content.includes(`HOOK: ${script}`),
        `Hook ${script} should contain traceable marker`,
      );
    }
  });

  // ── 3. All 5 subagents are deployed ────────────────────────────────────
  test("All 5 subagent files are deployed to .github/agents/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    for (const agent of ALL_SUBAGENTS) {
      const dest = path.join(workspacePath, ".github", "agents", agent);
      assert.ok(fs.existsSync(dest), `Missing subagent: ${agent}`);
      const content = fs.readFileSync(dest, "utf-8");
      assert.ok(
        content.includes(agent.replace(".agent.md", "")),
        `Subagent ${agent} should contain its name`,
      );
    }
  });

  // ── 4. All 8 prompts are deployed ──────────────────────────────────────
  test("All 8 prompt files are deployed to .github/prompts/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    for (const prompt of ALL_PROMPTS) {
      const dest = path.join(workspacePath, ".github", "prompts", prompt);
      assert.ok(fs.existsSync(dest), `Missing prompt: ${prompt}`);
      const content = fs.readFileSync(dest, "utf-8");
      assert.ok(
        content.includes(prompt.replace(".prompt.md", "")),
        `Prompt ${prompt} should contain its name`,
      );
    }
  });

  // ── 5. All 4 skills with SKILL.md are deployed ─────────────────────────
  test("All 4 skills with SKILL.md are deployed to .github/skills/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    for (const skill of ALL_SKILLS) {
      const dest = path.join(
        workspacePath,
        ".github",
        "skills",
        skill,
        "SKILL.md",
      );
      assert.ok(fs.existsSync(dest), `Missing skill: ${skill}`);
      const content = fs.readFileSync(dest, "utf-8");
      assert.ok(
        content.includes(skill),
        `Skill ${skill} should contain its name`,
      );
    }
  });

  // ── 6. hooks.json has _source tag and correct structure ────────────────
  test("hooks.json deployed with _source tag and event structure", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    const hooksJsonPath = path.join(
      workspacePath,
      ".github",
      "hooks",
      "hooks.json",
    );
    assert.ok(fs.existsSync(hooksJsonPath), "hooks.json must exist");

    const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
    assert.strictEqual(
      parsed._source,
      "project-brain",
      "_source tag must be set",
    );
    assert.ok(parsed.hooks, "hooks key must exist");
    assert.ok(parsed.hooks.SessionStart, "SessionStart event must exist");
    assert.ok(parsed.hooks.Stop, "Stop event must exist");
  });

  // ── 7. Re-bootstrap protection: user-modified files NOT overwritten ────
  test("Re-bootstrap does NOT overwrite existing user files", async () => {
    const { extensionPath, workspacePath } = createEnv();

    // First bootstrap
    await runGenerate(extensionPath, workspacePath);

    // Simulate user customization: modify a hook script
    const hookPath = path.join(
      workspacePath,
      ".github",
      "hooks",
      "scripts",
      "session-start.mjs",
    );
    fs.writeFileSync(hookPath, "// USER CUSTOMIZED\n", "utf-8");

    // Modify a subagent
    const agentPath = path.join(
      workspacePath,
      ".github",
      "agents",
      "researcher.agent.md",
    );
    fs.writeFileSync(agentPath, "# USER CUSTOM AGENT\n", "utf-8");

    // Modify a prompt
    const promptPath = path.join(
      workspacePath,
      ".github",
      "prompts",
      "recall.prompt.md",
    );
    fs.writeFileSync(promptPath, "# USER CUSTOM PROMPT\n", "utf-8");

    // Modify a skill
    const skillPath = path.join(
      workspacePath,
      ".github",
      "skills",
      "teach-brain",
      "SKILL.md",
    );
    fs.writeFileSync(skillPath, "# USER CUSTOM SKILL\n", "utf-8");

    // Second bootstrap (re-init)
    await runGenerate(extensionPath, workspacePath);

    // Verify user changes survived
    assert.strictEqual(
      fs.readFileSync(hookPath, "utf-8"),
      "// USER CUSTOMIZED\n",
      "Hook should NOT be overwritten",
    );
    assert.strictEqual(
      fs.readFileSync(agentPath, "utf-8"),
      "# USER CUSTOM AGENT\n",
      "Subagent should NOT be overwritten",
    );
    assert.strictEqual(
      fs.readFileSync(promptPath, "utf-8"),
      "# USER CUSTOM PROMPT\n",
      "Prompt should NOT be overwritten",
    );
    assert.strictEqual(
      fs.readFileSync(skillPath, "utf-8"),
      "# USER CUSTOM SKILL\n",
      "Skill should NOT be overwritten",
    );
  });

  // ── 8. hooks.json merge with third-party hooks ─────────────────────────
  test("hooks.json merges with existing third-party hooks (no _source)", async () => {
    const { extensionPath, workspacePath } = createEnv();

    // Pre-create a third-party hooks.json (no _source)
    const hooksDir = path.join(workspacePath, ".github", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const thirdPartyHooks = {
      hooks: {
        SessionStart: [
          {
            type: "command",
            command: "node .github/third-party/my-analytics.mjs",
            timeout: 5,
          },
        ],
        CustomEvent: [
          {
            type: "command",
            command: "echo custom",
            timeout: 3,
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify(thirdPartyHooks, null, 2),
      "utf-8",
    );

    // Bootstrap
    await runGenerate(extensionPath, workspacePath);

    const merged = JSON.parse(
      fs.readFileSync(path.join(hooksDir, "hooks.json"), "utf-8"),
    );

    // Third-party CustomEvent should survive
    assert.ok(merged.hooks.CustomEvent, "Third-party events must be preserved");
    assert.strictEqual(merged.hooks.CustomEvent.length, 1);

    // SessionStart should have BOTH third-party and our entry
    assert.strictEqual(
      merged.hooks.SessionStart.length,
      2,
      "Exactly 2 SessionStart hooks should exist",
    );

    // Third-party entry should still be there
    const thirdPartyEntry = merged.hooks.SessionStart.find(
      (e: Record<string, string>) => e.command?.includes("my-analytics"),
    );
    assert.ok(
      thirdPartyEntry,
      "Third-party SessionStart hook must survive merge",
    );

    // Our entry should be there too
    const ourEntry = merged.hooks.SessionStart.find(
      (e: Record<string, string>) => e.command?.includes("session-start.mjs"),
    );
    assert.ok(ourEntry, "Our SessionStart hook must be added");
  });

  // ── 9. hooks.json overwrite when _source = "project-brain" ─────────────
  test("hooks.json is overwritten when existing has _source project-brain", async () => {
    const { extensionPath, workspacePath } = createEnv();

    // Pre-create our own hooks.json with stale content
    const hooksDir = path.join(workspacePath, ".github", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const staleHooks = {
      _source: "project-brain",
      hooks: { OldEvent: [{ type: "command", command: "old" }] },
    };
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify(staleHooks, null, 2),
      "utf-8",
    );

    // Bootstrap
    await runGenerate(extensionPath, workspacePath);

    const result = JSON.parse(
      fs.readFileSync(path.join(hooksDir, "hooks.json"), "utf-8"),
    );

    // OldEvent should be gone (full overwrite)
    assert.strictEqual(
      result.hooks.OldEvent,
      undefined,
      "Stale events should be removed",
    );
    // Fresh events from static should be there
    assert.ok(result.hooks.SessionStart, "Fresh SessionStart must exist");
    assert.ok(result.hooks.Stop, "Fresh Stop must exist");
  });

  // ── 10. Directory structure is correct ─────────────────────────────────
  test("Creates correct directory tree under .github/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    await runGenerate(extensionPath, workspacePath);

    const ghPath = path.join(workspacePath, ".github");
    const expectedDirs = [
      "hooks",
      "hooks/scripts",
      "agents",
      "prompts",
      "skills",
      "skills/project-status",
      "skills/remember-this",
      "skills/teach-brain",
      "skills/what-changed",
    ];

    for (const dir of expectedDirs) {
      const full = path.join(ghPath, ...dir.split("/"));
      assert.ok(
        fs.existsSync(full) && fs.statSync(full).isDirectory(),
        `Directory ${dir} must exist`,
      );
    }
  });

  test("Creates agents diary directory under .project-brain/memory/", async () => {
    const { extensionPath, workspacePath } = createEnv();
    const folder = {
      uri: vscode.Uri.file(workspacePath),
      name: "workspace",
      index: 0,
    } as vscode.WorkspaceFolder;
    const context = { extensionPath } as vscode.ExtensionContext;
    const bootstrapper = new Bootstrapper(folder, context);

    await bootstrapper.createMemoryStructure();

    const memoryPath = path.join(workspacePath, ".project-brain", "memory");
    assert.ok(fs.existsSync(path.join(memoryPath, "archive")));
    assert.ok(fs.existsSync(path.join(memoryPath, "skills")));
    assert.ok(fs.existsSync(path.join(memoryPath, "agents")));
  });
});
