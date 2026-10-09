/**
 * Analysis test index — Mocha loader for self-learning analysis tests.
 * Used by runAnalysisTests.ts as the extensionTestsPath entry point.
 */

import { glob } from "glob";
import Mocha from "mocha";
import * as path from "path";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 600_000, // 10 minutes — LLM analysis takes time
  });

  const testsRoot = path.resolve(__dirname);
  const files = await glob("analysis-*.test.js", { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} analysis tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}
