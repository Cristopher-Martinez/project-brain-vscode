/**
 * Self-Learning Analysis E2E Test
 *
 * Runs the FULL analysis pipeline (10 LLM agents) against forge-orchestrator
 * inside the VS Code Extension Host with Copilot LM API available.
 *
 * Prerequisites:
 *   - forge-orchestrator repo at FORGE_REPO path
 *   - Repo already vectorized (run smoke-test-hq-local-repo.mjs first)
 *   - VS Code with Copilot Chat (profile "Pb dev")
 *
 * Run via: node dist/test/runAnalysisTests.js
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ─── Config ────────────────────────────────────────────────────────────

const EXTENSION_ID = "crismart.project-brain";
const FORGE_REPO =
  "C:\\Users\\dev\\OneDrive\\Documentos\\Repositorios\\tovectorize\\forge-orchestrator";

const EXPECTED_FILES = [
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

// ─── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getExtensionPath(): string {
  // Prefer env var (set by runAnalysisTests), then extension API
  if (process.env.PB_EXTENSION_PATH) return process.env.PB_EXTENSION_PATH;
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  return ext?.extensionPath ?? path.resolve(__dirname, "../../");
}

function findCliPath(): string {
  const extPath = getExtensionPath();
  // In dev: dist/mcp-server/cli.mjs is at project root
  const paths = [
    path.join(extPath, "dist", "mcp-server", "cli.mjs"),
    path.join(__dirname, "..", "mcp-server", "cli.mjs"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`CLI not found. Searched: ${paths.join(", ")}`);
}

// ─── Test Suite ─────────────────────────────────────────────────────────

suite("Self-Learning: Full Analysis E2E", function () {
  // 10 agents × ~30s each → up to 5 minutes
  this.timeout(600_000);

  // Use the extension's project root, not the sandbox workspace
  const extPath = getExtensionPath();
  const basePath = path.join(extPath, ".project-brain");
  const analysisDir = path.join(basePath, "analysis", "forge-orchestrator");

  // Dynamically import extension modules (compiled CJS)
  let SelfLearningManager: any;
  let SelfLearningAnalysis: any;
  let ANALYSIS_AGENTS: any[];

  let manager: any;
  let analysis: any;
  let repoId: number | null = null;
  let hasLmModels = false; // Track if Copilot LM is available

  suiteSetup(async function () {
    this.timeout(180_000);

    // Skip if repo doesn't exist
    if (!fs.existsSync(FORGE_REPO)) {
      console.log("⚠️ forge-orchestrator not found, skipping analysis tests");
      this.skip();
    }

    // Load modules from the compiled extension
    try {
      const slModule = require("../self-learning");
      const slAnalysis = require("../self-learning-analysis");
      const slTypes = require("../self-learning-types");
      SelfLearningManager = slModule.SelfLearningManager;
      SelfLearningAnalysis = slAnalysis.SelfLearningAnalysis;
      ANALYSIS_AGENTS = slTypes.ANALYSIS_AGENTS;
    } catch (err) {
      console.error("Failed to load self-learning modules:", err);
      this.skip();
    }

    // Ensure .project-brain dir exists
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }

    // Initialize manager with the project's basePath (not sandbox)
    const cliPath = findCliPath();
    manager = new SelfLearningManager(cliPath, basePath);
    await manager.init();

    // Add repo — always try, it's idempotent in the DB (unique by name)
    try {
      const repos: Array<{ id: number; name: string }> =
        manager.getRepos?.() ?? [];
      const existing = repos.find(
        (r: { name: string }) => r.name === "forge-orchestrator",
      );
      if (existing) {
        repoId = existing.id;
      } else {
        const entry = await manager.addRepo(FORGE_REPO);
        repoId = entry.id;
      }
    } catch (err) {
      console.error("Failed to add repo:", err);
      this.skip();
    }

    // Ensure vectorized
    try {
      const repos = manager.getRepos();
      const repo = repos.find(
        (r: { id: number; status: string }) => r.id === repoId,
      );
      if (repo && repo.status !== "vectorized" && repo.status !== "analyzed") {
        console.log("  Vectorizing forge-orchestrator...");
        const result = await manager.vectorizeRepo(repoId!);
        console.log(
          `  Vectorized: ${result.chunks} chunks, ${result.files} files`,
        );
      }
    } catch (err) {
      console.error("Vectorization failed:", err);
      // Continue anyway — analysis can work with structural map + key files
    }

    // Initialize analysis
    const db = manager.getDb();
    analysis = new SelfLearningAnalysis(db, db.analysisPath);

    // Set deps for RAG context
    const embeddingConfig = manager.getConfig();
    const cliPathForDeps = findCliPath();
    analysis.setDeps({ cliPath: cliPathForDeps, embeddingConfig });

    // Capture messages for debugging
    analysis.setPostMessage((msg: Record<string, unknown>) => {
      if (msg.type === "sl:analysisUpdate") {
        const s = msg.session as {
          agents: Array<{ status: string; agentId: string }>;
        };
        const completed = s.agents.filter(
          (a) => a.status === "completed",
        ).length;
        const running = s.agents.find((a) => a.status === "running");
        console.log(
          `  [Analysis] ${completed}/${s.agents.length} agents done${running ? ` | running: ${running.agentId}` : ""}`,
        );
      }
    });
  });

  suiteTeardown(() => {
    analysis?.dispose();
    manager?.dispose();
  });

  // ── Pre-conditions ──

  test("Extension is active", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "Extension should be installed");
    if (!ext!.isActive) await ext!.activate();
    assert.ok(ext!.isActive, "Extension should be active");
  });

  test("Copilot LM API is available", async function () {
    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels();
    } catch {
      console.log("  ⚠️ LM API not available — skipping LLM tests");
      return;
    }
    if (models.length === 0) {
      console.log("  ⚠️ No LM models — Copilot not authenticated");
      console.log("  → LLM-dependent tests will be skipped");
      console.log(
        "  → To run full analysis: close VS Code, then npm run test:analysis",
      );
      return;
    }
    hasLmModels = true;
    const copilotModel = models.find((m) => m.vendor === "copilot");
    console.log(
      `  LM Models: ${models.map((m) => `${m.id} (${m.family})`).join(", ")}`,
    );
    if (copilotModel) {
      console.log(`  ✅ Using Copilot model: ${copilotModel.id}`);
    }
  });

  test("forge-orchestrator is vectorized", () => {
    assert.ok(repoId !== null, "Repo should be added");
    const repos = manager.getRepos();
    const repo = repos.find((r: any) => r.id === repoId);
    assert.ok(repo, "Repo entry should exist");
    assert.ok(
      repo.status === "vectorized" ||
        repo.status === "analyzed" ||
        repo.status === "indexed",
      `Repo should be vectorized/indexed, got: ${repo.status}`,
    );
  });

  // ── Full Analysis Run ──

  test("Context building works for forge-orchestrator", async function () {
    this.timeout(30_000);
    // This test validates the context pipeline WITHOUT needing LLM
    const slContext = require("../self-learning-context");
    const structMap = slContext.buildStructuralMap(FORGE_REPO);
    assert.ok(
      structMap.length > 100,
      `Structural map too short: ${structMap.length}`,
    );
    const keyFiles = slContext.readKeyFiles(FORGE_REPO);
    assert.ok(keyFiles.length > 100, `Key files too short: ${keyFiles.length}`);
    const queries = slContext.getAgentQueries("architect");
    assert.ok(queries.length > 0, "Should have agent queries for architect");
    console.log(
      `  Context: structMap=${structMap.length}, keyFiles=${keyFiles.length}, queries=${queries.length}`,
    );
  });

  test("Full analysis run completes", async function () {
    if (!hasLmModels) {
      console.log("  ⏭️ Skipped — no LM models available");
      console.log("  → Close VS Code, then: npm run test:analysis");
      this.skip();
      return;
    }
    this.timeout(600_000); // 10 minutes

    console.log("\n  🏴‍☠️ Starting full analysis — 10 agents...\n");

    const session = await analysis.analyze({
      repoId: repoId!,
      llmModel: "gpt-4o",
      targetDescription:
        "Tu propio proyecto (analiza la arquitectura para entender y mejorar el código)",
    });

    assert.ok(session, "Analysis should return a session");
    assert.strictEqual(
      session.status,
      "completed",
      `Session should be completed, got: ${session.status}`,
    );

    const completedAgents = session.agents.filter(
      (a: any) => a.status === "completed",
    );
    const errorAgents = session.agents.filter((a: any) => a.status === "error");

    console.log(
      `\n  Results: ${completedAgents.length} completed, ${errorAgents.length} errors`,
    );
    if (errorAgents.length > 0) {
      for (const a of errorAgents) {
        console.error(`  ❌ ${a.agentId}: ${a.error}`);
      }
    }

    // At least 8/10 agents should complete (allow some tolerance)
    assert.ok(
      completedAgents.length >= 8,
      `Expected ≥8 agents to complete, got ${completedAgents.length}`,
    );
  });

  // ── Output Validation (require analysis to have run) ──

  test("Analysis output files are generated and non-trivial", function () {
    if (!hasLmModels) {
      this.skip();
      return;
    }
    // Directory exists
    assert.ok(fs.existsSync(analysisDir), `Expected dir: ${analysisDir}`);

    // All 10 files exist
    const existing = fs
      .readdirSync(analysisDir)
      .filter((f) => f.endsWith(".md"));
    for (const expected of EXPECTED_FILES) {
      assert.ok(existing.includes(expected), `Missing: ${expected}`);
    }

    // Each file has meaningful content (>500 chars)
    let totalChars = 0;
    for (const file of EXPECTED_FILES) {
      const filePath = path.join(analysisDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      assert.ok(
        content.length > 500,
        `${file}: ${content.length} chars (need >500)`,
      );
      totalChars += content.length;
    }

    console.log(`  Total: ${existing.length} files, ${totalChars} chars`);
    assert.ok(totalChars > 10_000, `Total ${totalChars} chars (need >10000)`);
  });

  test("Architecture analysis is relevant to forge-orchestrator", function () {
    if (!hasLmModels) {
      this.skip();
      return;
    }
    const archFile = path.join(analysisDir, "01_arquitectura.md");
    const content = fs.readFileSync(archFile, "utf-8").toLowerCase();
    const relevant =
      content.includes("rust") ||
      content.includes("orchestrat") ||
      content.includes("forge") ||
      content.includes("cli") ||
      content.includes("agent") ||
      content.includes("cargo");
    assert.ok(relevant, "Should mention forge/rust/orchestrator/cargo");
  });
});
