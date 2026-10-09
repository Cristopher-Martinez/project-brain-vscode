import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendToDiary } from "../agent-diary";
import { AutoRecall } from "../auto-recall";

suite("AutoRecall Tests", () => {
  let tempRoot: string;
  let memoryPath: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-auto-recall-"));
    memoryPath = path.join(tempRoot, ".project-brain", "memory");
    fs.mkdirSync(memoryPath, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("injects diary context once per session when mode is active", () => {
    appendToDiary(memoryPath, "reviewer", {
      date: "2026-04-09",
      title: "Review finding",
      context: "Context",
      learning: "Learning",
      confidence: "medium",
    });

    const opinionBank = {
      count: 1,
      getContextString: () => "• [testing] keep diary recall active",
      search: () => [],
    };

    const recall = new AutoRecall(memoryPath, opinionBank as any, () => {});
    recall.setCurrentAgentMode("reviewer");

    const first = recall.getAutoRecallContext();
    const second = recall.getAutoRecallContext();
    const refreshed = recall.getAutoRecallContext(true);

    assert.ok(first.includes("keep diary recall active"));
    assert.ok(first.includes("Review finding"));
    assert.strictEqual(second, "");
    assert.ok(refreshed.includes("Review finding"));
  });
});