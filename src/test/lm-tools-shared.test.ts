import * as assert from "assert";
import { TOOL_PLAN_REQUIREMENTS } from "../lm-tools-shared";

suite("LM Tools Shared Tests", () => {
  test("agent diary tools stay available in free tier", () => {
    assert.strictEqual(TOOL_PLAN_REQUIREMENTS.readAgentDiary, "free");
    assert.strictEqual(TOOL_PLAN_REQUIREMENTS.writeAgentDiary, "free");
  });
});