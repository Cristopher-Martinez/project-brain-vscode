import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

suite("Extension Intelligence — Deferred Init & Bundle", () => {
  test("bundle is minified (under 2.5MB)", () => {
    const bundlePath = path.join(__dirname, "..", "..", "dist", "extension.js");
    if (!fs.existsSync(bundlePath)) {
      // Skip if not built (CI may not have dist/)
      return;
    }
    const sizeBytes = fs.statSync(bundlePath).size;
    const sizeMB = sizeBytes / (1024 * 1024);
    assert.ok(
      sizeMB < 2.5,
      `Bundle is ${sizeMB.toFixed(2)}MB — expected < 2.5MB (minification may be off)`,
    );
  });

  test("build-server.mjs has minify: true", () => {
    const scriptPath = path.join(
      __dirname,
      "..",
      "..",
      "scripts",
      "build-server.mjs",
    );
    const content = fs.readFileSync(scriptPath, "utf-8");
    assert.ok(
      content.includes("minify: true"),
      "build-server.mjs should have minify: true for the extension bundle",
    );
  });

  test("extension-intelligence.ts uses deferred init pattern", () => {
    const srcPath = path.join(
      __dirname,
      "..",
      "..",
      "src",
      "extension-intelligence.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");
    assert.ok(
      content.includes("setTimeout") && content.includes("_deferredInit"),
      "extension-intelligence.ts should defer heavy init via setTimeout + _deferredInit",
    );
  });

  test("transcript indexer is deferred with setTimeout to avoid event loop blocking", () => {
    const srcPath = path.join(
      __dirname,
      "..",
      "..",
      "src",
      "extension-intelligence.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");
    assert.ok(
      content.includes("setTimeout") && content.includes("TranscriptIndexer"),
      "TranscriptIndexer should be wrapped in setTimeout to avoid watchdog kills",
    );
  });

  test("transcript indexer has heap guard before execution", () => {
    const srcPath = path.join(
      __dirname,
      "..",
      "..",
      "src",
      "extension-intelligence.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");
    assert.ok(
      content.includes("heapUsed") && content.includes("300"),
      "TranscriptIndexer should have a heap usage guard to skip when memory is high",
    );
  });
});
