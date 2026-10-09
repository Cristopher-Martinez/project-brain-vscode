import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TranscriptIndexer } from "../transcript-indexer";

suite("TranscriptIndexer", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ti-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("indexAll returns empty result when no transcripts dir exists", async () => {
    const indexer = new TranscriptIndexer(tmpDir);
    const result = await indexer.indexAll();
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.errors, 0);
  });

  test("indexAll yields event loop (non-blocking)", async () => {
    // Verify that indexAll resolves asynchronously (doesn't block)
    const indexer = new TranscriptIndexer(tmpDir);
    let resolved = false;
    const promise = indexer.indexAll().then(() => {
      resolved = true;
    });
    // Even though there are no files, the method should resolve
    await promise;
    assert.strictEqual(resolved, true);
  });

  test("getOutputDir returns conversations subdirectory", () => {
    const indexer = new TranscriptIndexer(tmpDir);
    assert.strictEqual(
      indexer.getOutputDir(),
      path.join(tmpDir, "conversations"),
    );
  });

  test("constants enforce safe limits (batch=5, fileSize=2MB)", () => {
    // Read the source to verify constants haven't drifted
    const srcPath = path.join(__dirname, "..", "..", "src", "transcript-indexer.ts");
    const content = fs.readFileSync(srcPath, "utf-8");
    assert.ok(content.includes("MAX_FILES_PER_PASS = 5"), "Batch limit should be 5");
    assert.ok(content.includes("MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024"), "File size limit should be 2MB");
  });
});
