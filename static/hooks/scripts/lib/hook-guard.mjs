/**
 * hook-guard.mjs — Integrity guard for ALL Copilot hooks
 *
 * Wraps hook execution with:
 * 1. Safe stdin reading
 * 2. Dynamic import error catching (catches missing exports!)
 * 3. Health reporting to .project-brain/loops/hook-health.json
 * 4. Loud error injection into agent context on crash
 *
 * ZERO project dependencies — only Node.js built-ins.
 * If this file fails, something is VERY wrong with Node itself.
 *
 * Usage:
 *   import { guardedHook } from './lib/hook-guard.mjs';
 *   guardedHook('hook-name', async (input) => {
 *     const { foo } = await import('./lib/bar.mjs'); // catches missing exports!
 *     // ... hook logic ...
 *     return { continue: true, hookSpecificOutput: { ... } };
 *   });
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wraps a hook's entire execution in a safety net.
 * Reads stdin, parses JSON, calls fn(input), handles all errors.
 * @param {string} hookName — identifier for health reporting
 * @param {(input: Record<string, unknown>) => Promise<unknown>} fn — hook logic
 */
export function guardedHook(hookName, fn) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", async () => {
    let input = {};
    try {
      input = JSON.parse(raw);
    } catch {
      // Malformed stdin — proceed with empty input
    }

    const cwd = input.cwd || process.cwd();

    try {
      const result = await fn(input);
      recordHealth(cwd, hookName, "ok");
      if (result !== undefined) {
        console.log(JSON.stringify(result));
      }
    } catch (err) {
      recordHealth(cwd, hookName, "crash", err);

      // Inject loud error into agent context so crash is VISIBLE
      console.log(
        JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            additionalContext: [
              `🚨🚨🚨 HOOK CRASH [${hookName}] 🚨🚨🚨`,
              `Error: ${err.message}`,
              `Stack: ${err.stack?.split("\n").slice(0, 8).join("\n")}`,
              ``,
              `The ${hookName} hook is BROKEN and unable to execute.`,
              `This means critical functionality is OFFLINE.`,
              `REPORT TO USER IMMEDIATELY: "El hook ${hookName} está crasheando."`,
              `Check .project-brain/loops/hook-health.json for details.`,
            ].join("\n"),
          },
        }),
      );
    }
  });
}

/**
 * Records hook execution result to .project-brain/loops/hook-health.json
 * Silent — never throws, never crashes the guard itself.
 */
function recordHealth(cwd, hookName, status, error = null) {
  try {
    const dir = join(cwd, ".project-brain", "loops");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hook-health.json");

    let health = {};
    try {
      health = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // File doesn't exist or corrupt — start fresh
    }

    const now = new Date().toISOString();
    const prev = health[hookName] || {};

    if (status === "ok") {
      health[hookName] = {
        status: "ok",
        lastRun: now,
        lastOk: now,
        consecutiveOk: (prev.consecutiveOk || 0) + 1,
        lastError: prev.lastError || null,
        lastCrash: prev.lastCrash || null,
      };
    } else {
      health[hookName] = {
        status: "crash",
        lastRun: now,
        lastCrash: now,
        consecutiveOk: 0,
        error: error.message,
        stack: error.stack?.split("\n").slice(0, 5).join("\n"),
        lastOk: prev.lastOk || null,
      };
    }

    writeFileSync(file, JSON.stringify(health, null, 2));
  } catch {
    // If health reporting itself fails, silently move on.
    // The guard's primary job (catching hook crashes + injecting error context)
    // still works even if health file can't be written.
  }
}
