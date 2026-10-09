import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

suite("Build Server — Minification", () => {
  test("build-server.mjs has minify: true for extension bundle", () => {
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
});
