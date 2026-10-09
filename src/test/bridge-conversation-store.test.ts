import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendMessage,
  initConversation,
  loadConversation,
  type ConversationFile,
} from "../bridge-conversation-store";
import { getConversationPath } from "../brain-paths";

function makeTempRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pb-conv-store-"));
}

function writeConversationFile(repoRoot: string, sessionId: string, data: ConversationFile): void {
  const filePath = getConversationPath(repoRoot, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

suite("BridgeConversationStore", () => {
  test("migrates legacy JSON-string PM payload on lazy rewrite", () => {
    const repoRoot = makeTempRepoRoot();
    const sessionId = "legacy-session";

    writeConversationFile(repoRoot, sessionId, {
      sessionId,
      objective: "test",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      createdAt: new Date().toISOString(),
      messages: [
        {
          id: 1,
          role: "pm",
          text: JSON.stringify({
            intent: "delegate",
            recommendation: "Haz esto ahora",
            reasoning: "Porque si",
            risk: "low",
            suggestedWorkerFeedback: "Do it",
            raw: "RAW_LEGACY",
          }),
          timestamp: new Date().toISOString(),
        },
      ],
    });

    appendMessage(repoRoot, sessionId, "user", "ok");

    const conv = loadConversation(repoRoot, sessionId);
    assert.ok(conv);
    assert.strictEqual(conv!.messages[0].recommendation, "Haz esto ahora");
    assert.strictEqual(conv!.messages[0].intent, "delegate");

    const persisted = JSON.parse(
      fs.readFileSync(getConversationPath(repoRoot, sessionId), "utf-8"),
    ) as ConversationFile;
    assert.strictEqual(persisted.messages[0].recommendation, "Haz esto ahora");
    assert.strictEqual((persisted.messages[0] as { debugRaw?: string }).debugRaw, undefined);
  });

  test("does not persist debugRaw by default", () => {
    const repoRoot = makeTempRepoRoot();
    const sessionId = "no-debug-default";
    initConversation(repoRoot, sessionId, "test", "openrouter", "google/gemini-2.5-flash");

    appendMessage(repoRoot, sessionId, "pm", {
      intent: "direct_answer",
      recommendation: "Respuesta corta",
      reasoning: "Detalle",
      risk: "low",
      suggestedWorkerFeedback: "",
      debugRaw: "VERY_SENSITIVE_RAW",
    });

    const persisted = JSON.parse(
      fs.readFileSync(getConversationPath(repoRoot, sessionId), "utf-8"),
    ) as ConversationFile;
    const pmMsg = persisted.messages[0] as { debugRaw?: string };
    assert.strictEqual(pmMsg.debugRaw, undefined);
  });

  test("persists debugRaw only when debug option is enabled", () => {
    const repoRoot = makeTempRepoRoot();
    const sessionId = "debug-enabled";
    initConversation(repoRoot, sessionId, "test", "openrouter", "google/gemini-2.5-flash");

    appendMessage(
      repoRoot,
      sessionId,
      "pm",
      {
        intent: "direct_answer",
        recommendation: "Respuesta",
        risk: "low",
        debugRaw: "RAW_DEBUG_PAYLOAD",
      },
      undefined,
      { persistDebugRaw: true },
    );

    const persisted = JSON.parse(
      fs.readFileSync(getConversationPath(repoRoot, sessionId), "utf-8"),
    ) as ConversationFile;
    const pmMsg = persisted.messages[0] as { debugRaw?: string };
    assert.strictEqual(pmMsg.debugRaw, "RAW_DEBUG_PAYLOAD");
  });

  test("caps long narrative fields", () => {
    const repoRoot = makeTempRepoRoot();
    const sessionId = "caps";
    initConversation(repoRoot, sessionId, "test", "openrouter", "google/gemini-2.5-flash");

    appendMessage(repoRoot, sessionId, "pm", {
      intent: "direct_answer",
      recommendation: "r".repeat(5000),
      reasoning: "x".repeat(3000),
      suggestedWorkerFeedback: "f".repeat(3000),
      risk: "low",
    });

    const conv = loadConversation(repoRoot, sessionId);
    assert.ok(conv);

    const msg = conv!.messages[0];
    assert.ok((msg.recommendation?.length ?? 0) <= 4000);
    assert.ok((msg.reasoning?.length ?? 0) <= 2000);
    assert.ok((msg.suggestedWorkerFeedback?.length ?? 0) <= 2000);
    assert.ok(msg.text.length <= 4000);
  });
});
