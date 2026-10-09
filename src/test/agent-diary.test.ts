import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendToDiary,
  diaryFilename,
  ensureAgentsDir,
  readDiary,
  readFullDiary,
} from "../agent-diary";

suite("Agent Diary Tests", () => {
  let tempRoot: string;
  let memoryPath: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-agent-diary-"));
    memoryPath = path.join(tempRoot, ".project-brain", "memory");
    fs.mkdirSync(memoryPath, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("diaryFilename returns per-mode filename", () => {
    assert.strictEqual(diaryFilename("reviewer"), "reviewer-diary.md");
    assert.strictEqual(diaryFilename("planner"), "planner-diary.md");
  });

  test("ensureAgentsDir creates agents directory idempotently", () => {
    const agentsPath = path.join(memoryPath, "agents");

    ensureAgentsDir(memoryPath);
    ensureAgentsDir(memoryPath);

    assert.ok(fs.existsSync(agentsPath));
    assert.ok(fs.statSync(agentsPath).isDirectory());
  });

  test("appendToDiary writes entries and readDiary returns only last five", () => {
    for (let index = 1; index <= 6; index += 1) {
      const ok = appendToDiary(memoryPath, "reviewer", {
        date: `2026-04-0${index}`,
        title: `Finding ${index}`,
        context: `Context ${index}`,
        learning: `Learning ${index}`,
        confidence: "medium",
      });
      assert.strictEqual(ok, true);
    }

    const full = readFullDiary(memoryPath, "reviewer");
    const recall = readDiary(memoryPath, "reviewer");
    const filePath = path.join(memoryPath, "agents", "reviewer-diary.md");

    assert.ok(fs.existsSync(filePath));
    assert.ok(full.includes("Finding 1"));
    assert.ok(full.includes("Finding 6"));
    assert.ok(recall.includes("## Agent Diary (reviewer)"));
    assert.ok(!recall.includes("Finding 1"));
    assert.ok(recall.includes("Finding 2"));
    assert.ok(recall.includes("Finding 6"));
  });

  test("appendToDiary rejects invalid modes and readFullDiary explains missing diary", () => {
    const ok = appendToDiary(memoryPath, "captain", {
      date: "2026-04-09",
      title: "Invalid",
      context: "Nowhere",
      learning: "Should fail",
      confidence: "low",
    });

    assert.strictEqual(ok, false);
    assert.strictEqual(readDiary(memoryPath, "captain"), "");
    assert.ok(readFullDiary(memoryPath, "reviewer").includes("No diary found for reviewer"));
    assert.ok(readFullDiary(memoryPath, "captain").includes("Unknown agent mode"));
  });

  test("appendToDiary rotates after one hundred entries", () => {
    for (let index = 1; index <= 101; index += 1) {
      const ok = appendToDiary(memoryPath, "planner", {
        date: `2026-04-${String((index % 30) + 1).padStart(2, "0")}`,
        title: `Entry ${index}`,
        context: `Context ${index}`,
        learning: `Learning ${index}`,
        confidence: "high",
      });
      assert.strictEqual(ok, true);
    }

    const filePath = path.join(memoryPath, "agents", "planner-diary.md");
    const content = fs.readFileSync(filePath, "utf-8");
    const headings = content.match(/^## /gm) ?? [];

    assert.strictEqual(headings.length, 100);
    assert.ok(!content.includes("## 2026-04-02 — Entry 1\n"));
    assert.ok(content.includes("## 2026-04-03 — Entry 2\n"));
    assert.ok(content.includes("## 2026-04-12 — Entry 101\n"));
  });
});