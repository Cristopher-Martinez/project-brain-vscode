/**
 * Shared identity parsing utilities for hooks.
 * All hooks import from here instead of duplicating regex parsing.
 * Single point of change if markdown format evolves.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Extract a markdown field value using flexible regex.
 * Handles **Key**: value, **Key**: **value**, Key: value
 */
function extract(raw, key) {
  return (
    raw
      .match(new RegExp(`\\*{0,2}${key}:?\\*{0,2}:?\\s*(.+)`))?.[1]
      ?.replace(/^[*]+/, "")
      .trim() ?? ""
  );
}

/**
 * Parse identity from 08_AGENT_IDENTITY.md
 * @param {string} memDir - path to .project-brain/memory/
 * @returns {{ name: string, emoji: string, creature: string, vibe: string, lang: string } | null}
 */
export function parseIdentity(memDir) {
  const idPath = join(memDir, "08_AGENT_IDENTITY.md");
  if (!existsSync(idPath)) return null;
  try {
    const raw = readFileSync(idPath, "utf8");
    return {
      name: extract(raw, "Name") || "Agent",
      emoji: extract(raw, "Emoji") || "🧠",
      creature: extract(raw, "Creature") || "",
      vibe: extract(raw, "Vibe") || "",
      lang: extract(raw, "Language") || "English",
    };
  } catch {
    return null;
  }
}

/**
 * Parse core soul from 09_AGENT_SOUL.md (lightweight: tone, approach, style, boundaries)
 * @param {string} memDir
 * @returns {{ tone: string, approach: string, style: string, boundaries: string } | null}
 */
export function parseSoulCore(memDir) {
  const soulPath = join(memDir, "09_AGENT_SOUL.md");
  if (!existsSync(soulPath)) return null;
  try {
    const soul = readFileSync(soulPath, "utf8");

    const extractSection = (key) =>
      soul.match(new RegExp(`\\*\\*${key}\\*\\*:([\\s\\S]*?)(?=\\*\\*(?:Tone|Approach|Boundaries|Style|Custom)\\*\\*|\\n## |$)`))?.[1]?.trim() ??
      soul.match(new RegExp(`## ${key}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim() ??
      "";

    return {
      tone: soul.match(/\*\*Tone\*\*:\s*(.+)/)?.[1]?.trim() ??
        soul.match(/## Tone\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "",
      approach: extractSection("Approach"),
      style: extractSection("Style"),
      boundaries: extractSection("Boundaries"),
    };
  } catch {
    return null;
  }
}

/**
 * Parse rich soul data (includes catchphrases, quirks, rpLevel)
 * Use for periodic deep reinforcement — more expensive.
 * @param {string} memDir
 * @returns {object | null}
 */
export function parseSoulRich(memDir) {
  const core = parseSoulCore(memDir);
  if (!core) return null;

  const soulPath = join(memDir, "09_AGENT_SOUL.md");
  try {
    const soul = readFileSync(soulPath, "utf8");

    // RP level
    const rpLevel = soul.match(/\*\*Current Level\*\*:\s*(\d+)\/10/)?.[1] ?? "";

    // Quirks
    const quirksBlock = soul.match(/## Quirks\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
    const quirks = quirksBlock.split("\n").filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());

    // Catchphrases
    const catchBlock = soul.match(/## Catchphrases\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
    const catchphrases = { success: [], complexity: [], warnings: [] };
    let cat = null;
    for (const line of catchBlock.split("\n")) {
      if (line.includes("**Success**")) cat = "success";
      else if (line.includes("**Complexity**")) cat = "complexity";
      else if (line.includes("**Warnings**")) cat = "warnings";
      else if (line.startsWith("- ") && cat) {
        catchphrases[cat].push(line.slice(2).replace(/^"|"$/g, "").trim());
      }
    }

    // Message Examples
    const exYaml = soul.match(/## Message Examples[\s\S]*?```ya?ml\n([\s\S]*?)```/)?.[1] ?? "";
    const examples = [];
    if (exYaml) {
      for (const pair of exYaml.split(/(?=- user:)/g)) {
        const u = pair.match(/user:\s*"([^"]+)"/)?.[1] ?? "";
        const a = pair.match(/agent:\s*"([^"]+)"/)?.[1] ?? "";
        if (u.length >= 5 && a.length >= 10) examples.push({ user: u, agent: a });
      }
    }

    return { ...core, rpLevel, quirks, catchphrases, examples };
  } catch {
    return core;
  }
}

/**
 * Parse user profile from 10_USER_PROFILE.md
 * @param {string} memDir
 * @returns {{ name: string, address: string } | null}
 */
export function parseUser(memDir) {
  const userPath = join(memDir, "10_USER_PROFILE.md");
  if (!existsSync(userPath)) return null;
  try {
    const raw = readFileSync(userPath, "utf8");
    const name = raw.match(/\*\*Name\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
    const address = raw.match(/\*\*Address\*\*:\s*(.+)/)?.[1]?.trim() ?? name;
    return name ? { name, address } : null;
  } catch {
    return null;
  }
}

/**
 * Format a compact one-liner identity reminder.
 * Used by PostToolUse for every-call reinforcement.
 */
export function formatReminder(identity, soul, user) {
  if (!identity) return "";
  const parts = [`You are ${identity.name} ${identity.emoji}.`];
  if (soul?.tone) parts.push(`Tone: ${soul.tone}.`);
  if (soul?.style) parts.push(`Style: ${soul.style}.`);
  parts.push(`Write your next output in ${identity.lang} with this personality. This applies to ALL text you write — progress reports, summaries, confirmations, everything. Not optional.`);
  if (user) parts.push(`User: ${user.address || user.name}.`);
  return `REMINDER: ${parts.join(" ")}`;
}

/**
 * Format a rich identity block for periodic deep reinforcement.
 * Includes approach, boundaries, catchphrases, user profile.
 */
export function formatDeepReminder(identity, richSoul, user) {
  if (!identity) return "";
  const lines = [
    `🧬 DEEP IDENTITY REINFORCEMENT`,
    `**You are**: ${identity.emoji} ${identity.name} (${identity.creature})`,
    `**Vibe**: ${identity.vibe}`,
    `**Language**: ${identity.lang} — ALWAYS respond in this language`,
  ];

  if (richSoul) {
    if (richSoul.tone) lines.push(`**Tone**: ${richSoul.tone}`);
    if (richSoul.approach) lines.push(`**Approach**: ${richSoul.approach}`);
    if (richSoul.style) lines.push(`**Style**: ${richSoul.style}`);
    if (richSoul.boundaries) lines.push(`**Boundaries**: ${richSoul.boundaries}`);
    if (richSoul.quirks?.length) lines.push(`**Quirks**: ${richSoul.quirks.join(" · ")}`);

    const cp = richSoul.catchphrases;
    if (cp) {
      const cpParts = [];
      if (cp.success?.length) cpParts.push(`Success: ${cp.success.join(" / ")}`);
      if (cp.complexity?.length) cpParts.push(`Complexity: ${cp.complexity.join(" / ")}`);
      if (cp.warnings?.length) cpParts.push(`Warnings: ${cp.warnings.join(" / ")}`);
      if (cpParts.length) lines.push(`**Catchphrases**: ${cpParts.join(" | ")}`);
    }

    if (richSoul.examples?.length) {
      const ex = richSoul.examples.slice(0, 2)
        .map(e => `User: "${e.user}" → You: "${e.agent}"`).join("\n");
      lines.push(`**Style examples**:\n${ex}`);
    }
  }

  if (user) lines.push(`**Addressing user as**: ${user.address || user.name}`);

  return lines.join("\n");
}
