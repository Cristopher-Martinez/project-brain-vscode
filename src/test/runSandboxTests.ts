/**
 * Sandbox Tier E2E Test Runner
 *
 * Launches VS Code via @vscode/test-electron with sandbox env vars
 * (PB_SANDBOX_TIER, PB_SANDBOX_ROLE) to test tier-gated features.
 *
 * Usage:
 *   node dist/test/runSandboxTests.js              # runs all 3 tiers
 *   node dist/test/runSandboxTests.js --tier free   # free tier only
 *   node dist/test/runSandboxTests.js --tier pro    # pro tier only
 *   node dist/test/runSandboxTests.js --tier admin  # pro+admin only
 */

import { runTests } from "@vscode/test-electron";
import * as path from "path";

interface TierConfig {
  name: string;
  env: Record<string, string>;
}

const TIERS: Record<string, TierConfig> = {
  free: {
    name: "Free",
    env: { PB_SANDBOX_TIER: "free" },
  },
  pro: {
    name: "Pro",
    env: { PB_SANDBOX_TIER: "pro" },
  },
  admin: {
    name: "Pro Admin",
    env: { PB_SANDBOX_TIER: "pro", PB_SANDBOX_ROLE: "admin" },
  },
};

function parseTierArg(): string | null {
  const idx = process.argv.indexOf("--tier");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function runTier(tierKey: string): Promise<boolean> {
  const tier = TIERS[tierKey];
  if (!tier) {
    console.error(`Unknown tier: ${tierKey}`);
    return false;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Sandbox Test: ${tier.name} tier`);
  console.log(`  Env: ${JSON.stringify(tier.env)}`);
  console.log(`${"═".repeat(60)}\n`);

  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./sandbox-index");
  const sandboxWorkspace = path.resolve(__dirname, "../../.sandbox");

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--disable-extensions",
        "--profile",
        "Pb dev",
        sandboxWorkspace,
      ],
      extensionTestsEnv: {
        ...tier.env,
        PB_SANDBOX_TEST: "true",
      },
    });
    console.log(`\n  ✅ ${tier.name} tier — PASSED\n`);
    return true;
  } catch (err) {
    console.error(`\n  ❌ ${tier.name} tier — FAILED\n`, err);
    return false;
  }
}

async function main() {
  const requestedTier = parseTierArg();
  const tiersToRun = requestedTier ? [requestedTier] : Object.keys(TIERS);

  let allPassed = true;

  for (const tierKey of tiersToRun) {
    const passed = await runTier(tierKey);
    if (!passed) allPassed = false;
  }

  console.log(`\n${"═".repeat(60)}`);
  if (allPassed) {
    console.log("  🏴‍☠️ All sandbox tier tests passed!");
  } else {
    console.log("  💀 Some sandbox tier tests failed.");
  }
  console.log(`${"═".repeat(60)}\n`);

  process.exit(allPassed ? 0 : 1);
}

main();
