/**
 * Assembles the full Soul injection block for session-start.
 * Parses 09_AGENT_SOUL.md and returns formatted parts for the system prompt.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Parse and assemble soul sections from 09_AGENT_SOUL.md.
 * @param {string} memDir - Path to .project-brain/memory/
 * @returns {string[]} Array of formatted parts to include in system prompt
 */
export function buildSoulParts(memDir) {
  const soulPath = join(memDir, "09_AGENT_SOUL.md");
  if (!existsSync(soulPath)) return [];

  const soul = readFileSync(soulPath, "utf8");
  const parts = [];

  // Core personality (supports both legacy inline fields and section-based format)
  const tone =
    soul.match(/\*\*Tone\*\*:\s*(.+)/)?.[1]?.trim() ??
    soul.match(/## Tone\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";
  const approach =
    soul
      .match(/\*\*Approach\*\*:([\s\S]*?)(?=\*\*Boundaries|$)/)?.[1]
      ?.trim() ??
    soul.match(/## Approach\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";
  const boundaries =
    soul
      .match(/\*\*Boundaries\*\*:([\s\S]*?)(?=\*\*Style|$)/)?.[1]
      ?.trim() ??
    soul.match(/## Boundaries\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";
  const style =
    soul.match(/\*\*Style\*\*:([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    soul.match(/## Style\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";
  const customRules =
    soul
      .match(/\*\*Custom Rules?\*\*:([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.trim() ??
    soul.match(/## Custom Rules\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";

  // Roleplay intensity
  const rpLevel =
    soul.match(/\*\*Current Level\*\*:\s*(\d+)\/10/)?.[1] ?? "";

  // Quirks
  const quirksBlock =
    soul.match(/## Quirks\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const quirks = quirksBlock
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

  // Catchphrases
  const catchBlock =
    soul.match(/## Catchphrases\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
  const { successPhrases, complexityPhrases, warningPhrases } =
    parseCatchphrases(catchBlock);

  // Voice tags
  const voiceBlock =
    soul.match(/## Voice Tags[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
    "";
  const voiceTags = voiceBlock
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

  // Relationships, Values
  const relBlock =
    soul.match(/## Relationships\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const valuesBlock =
    soul.match(/## Values\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";

  // Lore
  const lore = parseBulletList(
    soul.match(/## Lore\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "",
    10,
  );

  // Topics
  const topics = parseBulletList(
    soul.match(/## Topics\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "",
    5,
  );

  // Message Examples
  const messageExamples = parseMessageExamples(soul);

  // Review Loop Mode & Work Checkpoint Rule
  const reviewBlock =
    soul
      .match(/## Review Loop Mode[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.trim() ?? "";
  const checkpointBlock =
    soul
      .match(/## Work Checkpoint Rule[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.trim() ?? "";

  // Assemble Behavior section
  if (tone || approach) {
    const bp = [];
    bp.push(`**Tone**: ${tone}`);
    bp.push(`**Approach**: ${approach}`);
    if (boundaries) bp.push(`**Boundaries**: ${boundaries}`);
    if (style) bp.push(`**Style**: ${style}`);
    if (customRules) bp.push(`**Custom Rules**: ${customRules}`);
    if (rpLevel) bp.push(`**Roleplay Intensity**: ${rpLevel}/10`);
    if (quirks.length) bp.push(`**Quirks**: ${quirks.join(" · ")}`);
    if (
      successPhrases.length ||
      complexityPhrases.length ||
      warningPhrases.length
    ) {
      const cp = [];
      if (successPhrases.length)
        cp.push(`Success: ${successPhrases.join(" / ")}`);
      if (complexityPhrases.length)
        cp.push(`Complexity: ${complexityPhrases.join(" / ")}`);
      if (warningPhrases.length)
        cp.push(`Warnings: ${warningPhrases.join(" / ")}`);
      bp.push(`**Catchphrases**: ${cp.join(" | ")}`);
    }
    if (voiceTags.length)
      bp.push(`**Voice Tags**: ${voiceTags.join(" · ")}`);
    if (relBlock) bp.push(`**Relationships**:\n${relBlock}`);
    if (lore.length)
      bp.push(`**Background**: ${lore.slice(0, 3).join(" | ")}`);
    if (topics.length)
      bp.push(`**Topics of expertise**: ${topics.slice(0, 5).join(", ")}`);
    if (messageExamples.length) {
      const exFmt = messageExamples
        .slice(0, 2)
        .map((e) => `User: "${e.user}" → You: "${e.agent}"`)
        .join("\n");
      bp.push(`**Example style**:\n${exFmt}`);
    }
    parts.push(`## Behavior\n${bp.join("\n")}`);
  }

  // Operating Principles section
  const rulesParts = [];
  if (valuesBlock) rulesParts.push(`**Values**:\n${valuesBlock}`);
  if (reviewBlock)
    rulesParts.push(`**Review Loop**: ${reviewBlock.split("\n")[0]}`);
  if (checkpointBlock)
    rulesParts.push(`**Checkpoint Rule**: ${checkpointBlock.split("\n")[0]}`);
  if (rulesParts.length) {
    parts.push(`## Operating Principles\n${rulesParts.join("\n")}`);
  }

  return parts;
}

/** Parse catchphrases block into categorized arrays. */
function parseCatchphrases(catchBlock) {
  const successPhrases = [];
  const complexityPhrases = [];
  const warningPhrases = [];
  let currentCat = null;
  for (const line of catchBlock.split("\n")) {
    if (line.includes("**Success**")) currentCat = "success";
    else if (line.includes("**Complexity**")) currentCat = "complexity";
    else if (line.includes("**Warnings**")) currentCat = "warnings";
    else if (line.startsWith("- ") && currentCat) {
      const phrase = line.slice(2).replace(/^"|"$/g, "").trim();
      if (currentCat === "success") successPhrases.push(phrase);
      else if (currentCat === "complexity") complexityPhrases.push(phrase);
      else warningPhrases.push(phrase);
    }
  }
  return { successPhrases, complexityPhrases, warningPhrases };
}

/** Parse a bullet list, filtering by minimum length. */
function parseBulletList(raw, minLen) {
  return (raw ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length >= minLen);
}

/** Parse message examples from YAML code fence in soul. */
function parseMessageExamples(soul) {
  const examplesYaml =
    soul.match(/## Message Examples[\s\S]*?```ya?ml\n([\s\S]*?)```/)?.[1] ??
    "";
  const messageExamples = [];
  if (examplesYaml) {
    const exPairs = examplesYaml.split(/(?=- user:)/g);
    for (const pair of exPairs) {
      const u = pair.match(/user:\s*"([^"]+)"/)?.[1] ?? "";
      const a = pair.match(/agent:\s*"([^"]+)"/)?.[1] ?? "";
      if (u.length >= 5 && a.length >= 10) {
        messageExamples.push({ user: u, agent: a });
      }
    }
  }
  return messageExamples;
}
