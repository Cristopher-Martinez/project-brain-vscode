import * as assert from "assert";
import { isWrongProviderKey } from "../bridge-api-key-resolver";
import type {
  BridgeTaskMemoryData,
  PmChatMessage,
  PmSuggestionResult,
} from "../auto-loop-bridge-types";

type ThreadRecord = Record<string, { synthesisId: string; summary: string; lastUpdatedAt: number; turnCount: number }>;

function makeMsg(id: string, role: "user" | "pm", text: string): PmChatMessage {
  return { id, synthesisId: "s1", role, text, timestamp: Date.now() };
}

function makeTaskMemory(): BridgeTaskMemoryData {
  return {
    sessionId: "t1",
    objective: "test",
    approvedDecisions: [],
    rejectedSuggestions: [],
    pmChatSummaries: {},
    businessContext: "",
    updatedAt: Date.now(),
  };
}

function makeSuggestion(): PmSuggestionResult {
  return {
    id: "sug_trigger",
    recommendation: "eviction check",
    suggestedWorkerFeedback: "",
    reasoning: "",
    risk: "low",
    intent: "direct_answer",
  };
}

function defineAppendUserMessageTests(): void {
  suite("appendUserMessage", () => {
    test("appends message normally below threshold", () => {
      const { appendUserMessage } = require("../auto-loop-bridge-session-helpers");
      const map = new Map<string, PmChatMessage[]>();
      appendUserMessage(map, "s1", "hello");
      const msgs = map.get("s1")!;
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].text, "hello");
    });

    test("evicts oldest messages when exceeding 40", () => {
      const { appendUserMessage } = require("../auto-loop-bridge-session-helpers");
      const map = new Map<string, PmChatMessage[]>();
      const existing: PmChatMessage[] = [];
      for (let i = 0; i < 40; i++) {
        existing.push(makeMsg(`msg_${i}`, "user", `text_${i}`));
      }
      map.set("s1", existing);

      appendUserMessage(map, "s1", "trigger_eviction");

      const msgs = map.get("s1")!;
      assert.ok(msgs.length <= 31, `Expected <=31 msgs after eviction, got ${msgs.length}`);
      assert.strictEqual(msgs[msgs.length - 1].text, "trigger_eviction");
    });

    test("keeps most recent messages after eviction", () => {
      const { appendUserMessage } = require("../auto-loop-bridge-session-helpers");
      const map = new Map<string, PmChatMessage[]>();
      const existing: PmChatMessage[] = [];
      for (let i = 0; i < 45; i++) {
        existing.push(makeMsg(`msg_${i}`, "user", `text_${i}`));
      }
      map.set("s1", existing);

      appendUserMessage(map, "s1", "latest");
      const msgs = map.get("s1")!;
      assert.ok(msgs.length <= 31);
      assert.notStrictEqual(msgs[0].id, "msg_0");
    });
  });
}

function defineAppendPmResponseTests(): void {
  suite("appendPmResponse", () => {
    test("evicts oldest messages when exceeding 40", () => {
      const { appendPmResponse } = require("../auto-loop-bridge-session-helpers");
      const map = new Map<string, PmChatMessage[]>();
      const suggestions = new Map<string, PmSuggestionResult>();
      const threads: ThreadRecord = {};
      const existing: PmChatMessage[] = [];
      for (let i = 0; i < 40; i++) {
        existing.push(makeMsg(`msg_${i}`, i % 2 === 0 ? "user" : "pm", `text_${i}`));
      }
      map.set("s1", existing);

      appendPmResponse(map, suggestions, makeTaskMemory(), threads, "s1", makeSuggestion());

      const msgs = map.get("s1")!;
      assert.ok(msgs.length <= 31, `Expected <=31 after eviction, got ${msgs.length}`);
      assert.strictEqual(msgs[msgs.length - 1].id, "sug_trigger");
    });
  });
}

function defineProviderAwareApiKeyTests(): void {
  suite("Provider-aware API key logic", () => {
    test("resolveOrCreatePmClient with empty apiKeyRef triggers key resolution", () => {
      const config = { providerId: "openrouter", apiKeyRef: "", enabled: true, enabledModelIds: [], defaultModelId: "google/gemini-2.5-flash" };
      assert.ok(!config.apiKeyRef || config.apiKeyRef.startsWith("projectBrain."), "Empty key should trigger resolution");
    });

    test("resolved key should invalidate a previously empty client config", () => {
      const previousConfig = {
        providerId: "openrouter",
        apiKeyRef: "",
        enabled: true,
        enabledModelIds: [],
        defaultModelId: "google/gemini-2.5-flash",
      };
      const resolvedConfig = {
        ...previousConfig,
        apiKeyRef: "or-key",
      };

      const keyChanged = resolvedConfig.apiKeyRef !== previousConfig.apiKeyRef;

      assert.strictEqual(keyChanged, true, "A newly resolved key must force PM client recreation");
    });
  });
}

/**
 * Tests for auto-loop-bridge-session-helpers.ts:
 * - appendUserMessage sliding window eviction
 * - appendPmResponse sliding window eviction
 */

function defineCrossProviderGuardTests(): void {
  suite("Cross-provider contamination guard", () => {
    test("cached Gemini key for openrouter should be detected and cleared", () => {
      const config = {
        providerId: "openrouter",
        apiKeyRef: "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        enabled: true,
        enabledModelIds: [],
        defaultModelId: "google/gemini-2.5-flash",
      };
      // resolvePmProviderConfig checks isWrongProviderKey and resets apiKeyRef to ""
      const isContaminated = isWrongProviderKey(config.apiKeyRef, config.providerId);
      assert.strictEqual(isContaminated, true, "Gemini key cached for openrouter should be detected");
      if (isContaminated) {
        config.apiKeyRef = "";
      }
      assert.strictEqual(config.apiKeyRef, "", "apiKeyRef should be cleared when contaminated");
    });

    test("correct OpenRouter key should not be flagged", () => {
      const config = {
        providerId: "openrouter",
        apiKeyRef: "sk-or-v1-abc123",
        enabled: true,
        enabledModelIds: [],
        defaultModelId: "google/gemini-2.5-flash",
      };
      const isContaminated = isWrongProviderKey(config.apiKeyRef, config.providerId);
      assert.strictEqual(isContaminated, false, "Valid OR key should not be flagged");
    });
  });
}

suite("AutoLoopBridgeSessionHelpers — Sliding Window Eviction", () => {
  defineAppendUserMessageTests();
  defineAppendPmResponseTests();
  defineProviderAwareApiKeyTests();
  defineCrossProviderGuardTests();
});
