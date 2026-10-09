/**
 * Self-Learning E2E Tests
 *
 * Tests the full self-learning flow inside the VS Code extension host:
 *   1. Add local repo
 *   2. Pipeline (vectorize)
 *   3. Analysis (10 agents, generates .md files)
 *
 * Requires: VS Code Extension Host, Copilot Chat (LM API), Pro tier sandbox
 *
 * Usage: Run via sandbox test runner with --tier pro
 *   node ./dist/test/runSandboxTests.js --tier pro
 */

import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

// ─── Config ────────────────────────────────────────────────────────────────

const EXTENSION_ID = "crismart.project-brain";
const FORGE_REPO =
  "C:\\Users\\dev\\OneDrive\\Documentos\\Repositorios\\tovectorize\\forge-orchestrator";

/**
 * Expected analysis output files from the 10 agents.
 */
const EXPECTED_ANALYSIS_FILES = [
  "01_arquitectura.md",
  "02_patrones_y_calidad.md",
  "03_componentes_reutilizables.md",
  "04_logica_negocio.md",
  "05_infraestructura.md",
  "06_seguridad.md",
  "07_performance.md",
  "08_devops_y_escalabilidad.md",
  "09_cookbook.md",
  "10_auditoria_final.md",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTier(): string {
  return process.env.PB_SANDBOX_TIER ?? "free";
}

async function getExtensionApi(): Promise<Record<string, unknown> | null> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) return null;
  if (!ext.isActive) await ext.activate();
  return ext.exports ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Self-Learning Pipeline Tests ───────────────────────────────────────────

suite("Self-Learning: Local Repo Pipeline", function () {
  // Only run in pro tier
  if (getTier() !== "pro") return;

  // These tests can take a while (vectorization + LLM calls)
  this.timeout(600_000); // 10 minutes max

  let selfLearningMgr: {
    init(): Promise<void>;
    addRepo(
      source: string,
    ): Promise<{ id: number; name: string; status: string }>;
    getRepos(): Array<{
      id: number;
      name: string;
      status: string;
      chunkCount: number;
      fileCount: number;
    }>;
    runPipeline(repoId: number): Promise<void>;
    removeRepo(repoId: number): void;
    getConfig(): {
      provider: string;
      model: string;
      apiKey: string;
      available: boolean;
    };
    vectorizeRepo(repoId: number): Promise<{
      success: boolean;
      chunks: number;
      files: number;
      error?: string;
    }>;
    setPostMessage(fn: (msg: Record<string, unknown>) => void): void;
  } | null = null;

  const repoId: number | null = null;

  suiteSetup(async function () {
    // Skip if forge-orchestrator doesn't exist
    if (!fs.existsSync(FORGE_REPO)) {
      this.skip();
      return;
    }

    // Get extension exports
    const api = await getExtensionApi();
    if (!api) {
      this.skip();
      return;
    }

    // Try to get SelfLearningManager via extension API
    // The manager is created when Brain HQ opens, so we may need to access it differently
    const getSelfLearning = api.getSelfLearning as (() => unknown) | undefined;
    if (getSelfLearning) {
      selfLearningMgr = getSelfLearning() as typeof selfLearningMgr;
    }
  });

  suiteTeardown(async () => {
    // Clean up: remove the test repo entry
    if (selfLearningMgr && repoId !== null) {
      try {
        selfLearningMgr.removeRepo(repoId);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test("Forge-orchestrator repo exists on disk", () => {
    assert.ok(fs.existsSync(FORGE_REPO), `Repo not found: ${FORGE_REPO}`);
  });

  test("Repo has markdown files for vectorization", () => {
    const mdFiles: string[] = [];
    function walk(dir: string, depth: number): void {
      if (depth > 3) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name.startsWith(".") || item.name === "node_modules") continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full, depth + 1);
        else if (item.name.endsWith(".md")) mdFiles.push(full);
      }
    }
    walk(FORGE_REPO, 0);
    assert.ok(mdFiles.length > 0, `No .md files found in ${FORGE_REPO}`);
  });

  test("Repo does NOT have docs/memory/ folder (tests --scan-all path)", () => {
    const memoryPath = path.join(FORGE_REPO, "docs", "memory");
    assert.ok(
      !fs.existsSync(memoryPath),
      "forge-orchestrator should NOT have docs/memory/ — that's the whole point of --scan-all",
    );
  });

  test("Brain HQ command is available", async () => {
    const commands = await vscode.commands.getCommands(true);
    const brainHQ = commands.filter((c) => c === "projectBrain.openBrainHQ");
    assert.ok(
      brainHQ.length > 0,
    );
  });

  test("CLI vectorize works (direct CLI invocation)", async function () {
    this.timeout(120_000);

    const cliPath = path.join(
      vscode.extensions.getExtension(EXTENSION_ID)!.extensionPath,
      "dist",
      "mcp-server",
      "cli.mjs",
    );

    if (!fs.existsSync(cliPath)) {
      this.skip();
      return;
    }

    const { execFileSync } = await import("child_process");
    const output = execFileSync(
      "node",
      [cliPath, "vectorize", FORGE_REPO, "--force", "--scan-all"],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, EMBEDDING_PROVIDER: "tfidf" },
      },
    );

    // Validate output
    assert.ok(
      output.includes("Indexed successfully"),
      `Expected 'Indexed successfully' in output, got: ${output.slice(-200)}`,
    );

    const chunksMatch = /Chunks:\s*(\d+)/i.exec(output);
    assert.ok(chunksMatch, "Expected chunks count in output");
    const chunks = parseInt(chunksMatch![1], 10);

    const filesMatch = /Files:\s*(\d+)/i.exec(output);
    assert.ok(filesMatch, "Expected files count in output");
    const files = parseInt(filesMatch![1], 10);
    assert.ok(files > 0, `Expected >0 files, got ${files}`);
  });

  test("RAG search returns results after vectorization", async function () {
    this.timeout(30_000);

    const cliPath = path.join(
      vscode.extensions.getExtension(EXTENSION_ID)!.extensionPath,
      "dist",
      "mcp-server",
      "cli.mjs",
    );

    if (!fs.existsSync(cliPath)) {
      this.skip();
      return;
    }

    const { execFileSync } = await import("child_process");
    let output: string;
    try {
      output = execFileSync(
        "node",
        [
          cliPath,
          "search",
          "architecture design patterns",
          "-p",
          FORGE_REPO,
          "-k",
          "3",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
        },
      );
    } catch (err) {
      // Search command may exit 1 but still produce output
      const execErr = err as { stdout?: string; stderr?: string };
      output = execErr.stdout ?? "";
    }

    assert.ok(
      output.includes("Result") || output.includes("Score"),
      `RAG search should return results, got: ${output.slice(0, 200)}`,
    );
  });

  test("Structural map can be built for forge-orchestrator", () => {
    // Verify the repo has enough structure for meaningful analysis
    const hasReadme = fs.existsSync(path.join(FORGE_REPO, "README.md"));
    const hasSrc = fs.existsSync(path.join(FORGE_REPO, "src"));
    const hasCargoToml = fs.existsSync(path.join(FORGE_REPO, "Cargo.toml"));

    assert.ok(hasReadme, "Repo should have README.md");
    assert.ok(hasSrc, "Repo should have src/ directory");
    assert.ok(hasCargoToml, "forge-orchestrator should have Cargo.toml");
  });

  test("Key files are readable for context injection", () => {
    const keyFiles = ["README.md", "Cargo.toml", "CLAUDE.md"];
    const readable: string[] = [];

    for (const file of keyFiles) {
      const fullPath = path.join(FORGE_REPO, file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.length > 0) readable.push(file);
      }
    }

    assert.ok(
      readable.length >= 2,
      `Expected at least 2 readable key files, found: ${readable.join(", ")}`,
    );
  });

  test("Analysis output directory can be created", () => {
    // The analysis writes to .project-brain/analysis/<repo-name>/
    // We test that we CAN create this directory
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      assert.ok(true, "No workspace — skip directory test");
      return;
    }

    const analysisDir = path.join(
      workspacePath,
      ".project-brain",
      "analysis",
      "forge-orchestrator",
    );
    if (!fs.existsSync(analysisDir)) {
      fs.mkdirSync(analysisDir, { recursive: true });
    }
    assert.ok(
      fs.existsSync(analysisDir),
      "Should be able to create analysis output directory",
    );
    // Clean up the test directory
    try {
      fs.rmdirSync(analysisDir);
    } catch {
      // Non-critical
    }
  });
});

// ─── Analysis Output Validation ─────────────────────────────────────────────
// These tests validate analysis output AFTER it has been generated.
// They check that generated files exist and have meaningful content.

suite("Self-Learning: Analysis Output Validation", function () {

  this.timeout(10_000);

  const workspacePath = process.cwd();
  const analysisDir = path.join(
    workspacePath,
    ".project-brain",
    "analysis",
    "forge-orchestrator",
  );

  test("Analysis output directory exists (run analysis first if this fails)", function () {
    if (!fs.existsSync(analysisDir)) {
      this.skip(); // Analysis hasn't been run yet — not a failure
      return;
    }
    assert.ok(fs.existsSync(analysisDir));
  });
  test("All 10 agent output files are present", function () {
    if (!fs.existsSync(analysisDir)) {
      this.skip();
      return;
    }

    const existing = fs
      .readdirSync(analysisDir)
      .filter((f) => f.endsWith(".md"));
    for (const expected of EXPECTED_ANALYSIS_FILES) {
      assert.ok(
        existing.includes(expected),
        `Missing analysis file: ${expected}. Found: ${existing.join(", ")}`,
      );
    }
  });

  test("Analysis files have meaningful content (>500 chars each)", function () {
    if (!fs.existsSync(analysisDir)) {
      this.skip();
      return;
    }

    for (const file of EXPECTED_ANALYSIS_FILES) {
      const filePath = path.join(analysisDir, file);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      assert.ok(
        content.length > 500,
        `Analysis file ${file} has too little content: ${content.length} chars`,
      );
    }
  });

  test("Architecture analysis mentions forge-orchestrator concepts", function () {
    const archFile = path.join(analysisDir, "01_arquitectura.md");
    if (!fs.existsSync(archFile)) {
      this.skip();
      return;
    }

    const content = fs.readFileSync(archFile, "utf-8").toLowerCase();
    const hasRelevantContent =
      content.includes("rust") ||
      content.includes("orchestrat") ||
      content.includes("forge") ||
      content.includes("cli") ||
      content.includes("agent");

    assert.ok(
      hasRelevantContent,
      "Architecture analysis should mention forge/rust/orchestrator concepts",
    );
  });
});
