import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ReadAgentDiaryTool, WriteAgentDiaryTool } from "../lm-tools-diary";

suite("LM Tools Diary Tests", () => {
  let tempRoot: string;
  let memoryPath: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pb-lm-diary-"));
    memoryPath = path.join(tempRoot, ".project-brain", "memory");
    fs.mkdirSync(memoryPath, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("write tool appends an entry and read tool returns diary content", async () => {
    const writeTool = new WriteAgentDiaryTool(memoryPath, () => {});
    const readTool = new ReadAgentDiaryTool(memoryPath, () => {});

    const writeResult = await writeTool.invoke(
      {
        input: {
          mode: "planner",
          title: "Planning memo",
          context: "Loop round",
          learning: "Prefer diary-backed recall for agent-specific context.",
          confidence: "high",
        },
      } as any,
      {} as any,
    );
    const readResult = await readTool.invoke(
      { input: { mode: "planner" } } as any,
      {} as any,
    );

    assert.ok((writeResult.content[0] as { value: string }).value.includes("Diary entry added"));
    assert.ok((readResult.content[0] as { value: string }).value.includes("Planning memo"));
  });

  test("write tool reports invalid modes", async () => {
    const writeTool = new WriteAgentDiaryTool(memoryPath, () => {});
    const result = await writeTool.invoke(
      {
        input: {
          mode: "quartermaster",
          title: "Invalid",
          learning: "No-op",
        },
      } as any,
      {} as any,
    );

    assert.ok((result.content[0] as { value: string }).value.includes("Failed to write diary"));
  });
});