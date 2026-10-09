import * as assert from "assert";
import * as crypto from "crypto";

import { PromptLoader } from "../prompt-loader";

interface MockPromptsResponse {
  plan: "free" | "pro" | "team" | "enterprise";
  promptCount: number;
  encrypted: boolean;
  dk: string;
  prompts: Array<{
    id: string;
    tier: "basic" | "premium";
    category: string;
    version: number;
    content: string;
  }>;
}

function encryptForTest(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
}

suite("PromptLoader — Encrypted Premium Prompts", () => {
  test("decrypts premium prompt on-demand from encrypted payload", async () => {
    const key = crypto.randomBytes(32);
    const premiumText = "PREMIUM_SECRET_PROMPT_CONTENT";
    const encrypted = encryptForTest(premiumText, key);

    const mockClient = {
      async getPrompts(): Promise<MockPromptsResponse> {
        return {
          plan: "pro",
          promptCount: 1,
          encrypted: true,
          dk: key.toString("base64"),
          prompts: [
            {
              id: "specialist-persona-generate-code",
              tier: "premium",
              category: "slave",
              version: 1,
              content: encrypted,
            },
          ],
        };
      },
    };

    const loader = new PromptLoader(() => undefined);
    loader.setSaaSClient(mockClient as any);
    await loader.forceRefresh();

    const resolved = loader.getPrompt("specialist-persona-generate-code");

    assert.strictEqual(resolved, premiumText);
    assert.strictEqual(loader.hasPremiumPrompts, true);
  });

  test("falls back to basic prompt when encrypted payload is invalid", async () => {
    const key = crypto.randomBytes(32);

    const mockClient = {
      async getPrompts(): Promise<MockPromptsResponse> {
        return {
          plan: "pro",
          promptCount: 1,
          encrypted: true,
          dk: key.toString("base64"),
          prompts: [
            {
              id: "specialist-persona-generate-code",
              tier: "premium",
              category: "slave",
              version: 1,
              content: "not-a-valid-encrypted-blob",
            },
          ],
        };
      },
    };

    const loader = new PromptLoader(() => undefined);
    loader.setSaaSClient(mockClient as any);
    await loader.forceRefresh();

    const resolved = loader.getPrompt("specialist-persona-generate-code");

    assert.strictEqual(
      resolved,
      "You are a software engineer. Write clean, working code as requested.",
    );
  });
});
