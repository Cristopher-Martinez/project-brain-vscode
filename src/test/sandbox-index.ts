/**
 * Sandbox test index — Mocha loader for sandbox tier tests only.
 * Used by runSandboxTests.ts as the extensionTestsPath entry point.
 */

import { glob } from "glob";
import Mocha from "mocha";
import * as path from "path";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 30000,
  });

  const testsRoot = path.resolve(__dirname);
  const files = await glob("sandbox-*.test.js", { cwd: testsRoot });

  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} sandbox tests failed.`));
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
