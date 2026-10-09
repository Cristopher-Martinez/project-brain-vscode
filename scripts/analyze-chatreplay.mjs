/**
 * Chatreplay Analyzer — Parses VS Code Copilot chatreplay JSON
 * Usage: node scripts/analyze-chatreplay.mjs <path-to-chatreplay.json>
 *
 * Focuses on: loop protocol, BLOCKED keywords, compaction events, sessionIds
 */

import { readFileSync } from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/analyze-chatreplay.mjs <chatreplay.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(filePath, "utf8"));

// Detect structure
if (Array.isArray(data)) {
  console.log(`\n=== CHATREPLAY ANALYSIS ===`);
  console.log(`Total requests: ${data.length}`);
  console.log(`First item keys: ${Object.keys(data[0]).join(", ")}`);

  // Analyze each request
  for (let i = 0; i < data.length; i++) {
    const req = data[i];
    console.log(`\n--- Request ${i + 1} ---`);
    console.log(`Model: ${req.model || "unknown"}`);
    console.log(`Timestamp: ${req.timestamp || "unknown"}`);

    if (req.messages) {
      console.log(`Messages: ${req.messages.length}`);
      for (const msg of req.messages) {
        const role = msg.role || "unknown";
        const contentLen =
          typeof msg.content === "string"
            ? msg.content.length
            : JSON.stringify(msg.content || "").length;

        // Check for BLOCKED keyword
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content || "");
        const hasBlocked = content.includes("BLOCKED");
        const hasActiveLoop = content.includes("ACTIVE LOOP");
        const hasSessionId = content.match(
          /sessionId[=:]\s*["']?([a-f0-9-]+)/i,
        );
        const hasLoopEmoji = content.includes("🔁");

        let flags = [];
        if (hasBlocked) flags.push("BLOCKED");
        if (hasActiveLoop) flags.push("ACTIVE_LOOP");
        if (hasSessionId) flags.push(`SID:${hasSessionId[1].substring(0, 8)}`);
        if (hasLoopEmoji) flags.push("🔁");

        console.log(
          `  [${role}] ${contentLen} chars ${flags.length ? "⚡ " + flags.join(" | ") : ""}`,
        );
      }
    }

    // Token usage
    if (req.usage) {
      console.log(
        `Tokens — prompt: ${req.usage.prompt_tokens || "?"}, completion: ${req.usage.completion_tokens || "?"}, total: ${req.usage.total_tokens || "?"}`,
      );
    }
  }
} else {
  // Single object with different structure
  console.log(`\n=== CHATREPLAY ANALYSIS ===`);
  console.log(`Type: Object`);
  console.log(`Keys: ${Object.keys(data).join(", ")}`);

  // Try common structures
  const requests =
    data.requests || data.prompts || data.entries || data.messages || [];
  if (requests.length) {
    console.log(`Entries: ${requests.length}`);
  }

  // Deep scan for BLOCKED and loop keywords
  const fullText = JSON.stringify(data);
  const blockedCount = (fullText.match(/BLOCKED/g) || []).length;
  const activeLoopCount = (fullText.match(/ACTIVE LOOP/g) || []).length;
  const sessionIds = [
    ...new Set(
      fullText.match(/sessionId[=:]\s*["']?([a-f0-9-]{8,36})/gi) || [],
    ),
  ];
  const loopEmojiCount = (fullText.match(/🔁/g) || []).length;
  const compactionCount = (fullText.match(/compact|summariz/gi) || []).length;

  console.log(`\n=== LOOP PROTOCOL ANALYSIS ===`);
  console.log(`"BLOCKED" occurrences: ${blockedCount}`);
  console.log(`"ACTIVE LOOP" occurrences: ${activeLoopCount}`);
  console.log(`🔁 emoji occurrences: ${loopEmojiCount}`);
  console.log(`Compaction/summarize refs: ${compactionCount}`);
  console.log(`Unique sessionId patterns: ${sessionIds.length}`);
  sessionIds.forEach((s) => console.log(`  ${s}`));
}
