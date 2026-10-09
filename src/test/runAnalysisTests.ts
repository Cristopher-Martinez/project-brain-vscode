/**
 * Analysis E2E Test Runner
 *
 * Uses test-electron's default dev VS Code (clean sandbox, basic extensions).
 * LLM-dependent tests auto-skip when Copilot is not authenticated.
 * Context-building + pipeline tests always run.
 *
 * Usage:
 *   node dist/test/runAnalysisTests.js
 */

import { runTests } from "@vscode/test-electron";
import * as path from "path";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./analysis-index");
  const sandboxWorkspace = path.resolve(__dirname, "../../.sandbox");

  console.log(`\n${"═".repeat(60)}`);
  console.log("  Self-Learning Analysis E2E Test");
  console.log("  Mode: Dev sandbox (basic extensions)");
  console.log(`${"═".repeat(60)}\n`);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [sandboxWorkspace],
      extensionTestsEnv: {
        PB_SANDBOX_TIER: "pro",
        PB_SANDBOX_TEST: "true",
        PB_ANALYSIS_TEST: "true",
        PB_EXTENSION_PATH: extensionDevelopmentPath,
      },
    });
    console.log("\n  ✅ Analysis E2E tests — PASSED\n");
  } catch (err) {
    console.error("\n  ❌ Analysis E2E tests — FAILED\n", err);
    process.exit(1);
  }
}

main();
