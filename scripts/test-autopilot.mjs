import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { execSync } from "child_process";

const telemetryPath = resolve(".project-brain", "loops", "test-advice-telemetry.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [, , action, draftArg, targetArg, ...runParts] = process.argv;
if (!["apply", "shadow"].includes(action)) {
  fail("Usage: node scripts/test-autopilot.mjs <apply|shadow> <draftPath> <targetPath> [runCommand]");
}
if (!draftArg || !targetArg) {
  fail("Missing draftPath or targetPath");
}

const draftPath = resolve(draftArg);
const targetPath = resolve(targetArg);
if (!existsSync(draftPath)) {
  fail(`Draft not found: ${draftPath}`);
}

try {
  if (runParts.length > 0) {
    const runCommand = runParts.join(" ");
    const shadowPath = resolve(join(
      ".project-brain",
      "loops",
      "test-autopilot-shadow",
      targetArg,
    ));
    mkdirSync(dirname(shadowPath), { recursive: true });
    copyFileSync(draftPath, shadowPath);
    const shadowCommand = runCommand
      .replace(targetArg, shadowPath)
      .replace(targetPath, shadowPath);
    execSync(shadowCommand, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
    });
  }

  if (action === "shadow") {
    appendTelemetry({
      targetPath: normalizePath(targetArg),
      runCommand: runParts.join(" "),
      status: "success",
      timestamp: Date.now(),
    });
    console.log(`SHADOW OK ${draftPath}`);
    process.exit(0);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(draftPath, targetPath);
  appendTelemetry({
    targetPath: normalizePath(targetArg),
    runCommand: runParts.join(" "),
    status: "success",
    timestamp: Date.now(),
  });
  console.log(`PROMOTED ${draftPath} -> ${targetPath}`);
} catch (error) {
  appendTelemetry({
    targetPath: normalizePath(targetArg),
    runCommand: runParts.join(" "),
    status: "failure",
    timestamp: Date.now(),
  });
  throw error;
}

function appendTelemetry(entry) {
  mkdirSync(dirname(telemetryPath), { recursive: true });
  const existing = existsSync(telemetryPath)
    ? JSON.parse(readFileSync(telemetryPath, "utf8"))
    : [];
  const next = Array.isArray(existing) ? existing.slice(-49) : [];
  next.push(entry);
  writeFileSync(telemetryPath, JSON.stringify(next, null, 2), "utf8");
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}