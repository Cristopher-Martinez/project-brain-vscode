import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFullDiary } from "../agent-diary";
import { AutoCapture } from "../auto-capture";

suite("AutoCapture Tests", () => {
  let tempRoot: string;
  let memoryPath: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-auto-capture-"));
    memoryPath = path.join(tempRoot, ".project-brain", "memory");
    fs.mkdirSync(memoryPath, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("routes captured learning into the active agent diary", async () => {
    const added: string[] = [];
    let saveCalls = 0;
    const opinionBank = {
      addOpinion: (statement: string) => added.push(statement),
      save: () => {
        saveCalls += 1;
      },
      flush: () => ({ saved: added.length }),
    };

    const capture = new AutoCapture(opinionBank as any, () => {});
    capture.setDiaryConfig(memoryPath);
    capture.setCurrentAgentMode("reviewer");

    const total = await capture.capture(
      "learned that diary-backed recall keeps agent memory scoped and reusable across sessions.",
      "phase-3",
    );

    const diary = readFullDiary(memoryPath, "reviewer");

    assert.strictEqual(total, 1);
    assert.strictEqual(saveCalls, 1);
    assert.strictEqual(added.length, 1);
    assert.ok(diary.includes("phase-3"));
    assert.ok(diary.includes("diary-backed recall keeps agent memory scoped"));
  });
});