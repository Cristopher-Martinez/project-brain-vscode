// ─── Identity Types, Parsers, Serializers & Prompt Builder ───────────────────
// Extracted from agent-identity.ts — Single Responsibility Principle
// This module owns the DATA LAYER: shapes, file constants, markdown ↔ object
// conversion, and prompt construction from identity context.

import * as yaml from "js-yaml";
import { INJECTION_PATTERNS } from "./security-utils";

// ─── Types: Identity + Soul + User + Project Essence ─────────────────────────
// Inspired by OpenClaw's separation of concerns, but PROJECT-AWARE:
//   IDENTITY.md — WHO you are (name, creature, vibe, emoji)
//   SOUL.md     — HOW you behave (boundaries, tone, custom rules)
//   USER.md     — WHO the human is (name, preferred address, notes)
//
// Unlike OpenClaw (general-purpose), the agent's technical knowledge
// is DERIVED FROM THE REPOSITORY — not manually configured.
// ProjectEssence is auto-extracted from the scan and never stored
// in a separate file; it lives in the existing memory docs.

export interface AgentIdentity {
  name: string;
  creature: string; // What kind of being? AI, robot, familiar, companion...
  vibe: string; // How do you come across? sharp, warm, chaotic, calm...
  emoji: string; // Signature emoji
  theme: string; // One-line theme: "helpful space lobster", "zen debugger"
  language: string; // Response language
}

export interface AgentSoul {
  tone: string; // Communication tone instructions
  boundaries: string; // What the agent won't do
  approach: string; // Problem-solving style
  customRules: string; // Free-form custom behavior instructions
  roleplayIntensity?: number; // 0-10 scale for personality immersion
  quirks?: string[]; // List of character quirks/behaviors
  catchphrases?: {
    success?: string[];
    complexity?: string[];
    warnings?: string[];
  }; // Common phrases
  voiceTags?: string[]; // TTS emotional tags
  relationships?: string; // Relationships with users, codebase, etc
  lore?: string[]; // Background story items (binoSwarm-inspired)
  topics?: string[]; // Areas of expertise/interest
  messageExamples?: Array<{ user: string; agent: string }>; // Style examples
}

export interface UserProfile {
  name: string;
  preferredAddress: string; // How to call the user
  timezone: string;
  notes: string; // Any other context about the user
}

export interface ProgrammingPrefs {
  architecture: string; // Preferred patterns
  codeStyle: string; // Code formatting and organization preferences
  testing: string; // Testing approach and philosophy
  gitWorkflow: string; // Git branching/commit strategy
  codeReview: string; // Review style and depth
  documentation: string; // Documentation preferences
  other: string; // Additional notes
}

/**
 * Auto-extracted from the repository scan. NOT manually configured.
 * This is what makes the agent "aware" of the project it's working on.
 */
export interface ProjectEssence {
  projectType: string; // "Node.js", "React", "Python", etc.
  languages: string[]; // Languages found in the project
  frameworks: string[]; // Detected frameworks / key dependencies
  description: string; // One-liner from package.json or README
  keyDependencies: string[]; // Top dependencies
}

// Combined context for prompt building
export interface AgentContext {
  identity: AgentIdentity | null;
  soul: AgentSoul | null;
  user: UserProfile | null;
  essence: ProjectEssence | null;
  programmingPrefs: ProgrammingPrefs | null;
}

// ─── File constants ──────────────────────────────────────────────────────────

export const IDENTITY_FILE = "08_AGENT_IDENTITY.md";
export const SOUL_FILE = "09_AGENT_SOUL.md";
export const USER_FILE = "10_USER_PROFILE.md";
export const PROGRAMMING_PREFS_FILE = "11_PROGRAMMING_PREFS.md";
export const BOOTSTRAP_FILE = "11_BOOTSTRAP.md";
export const PRIMARY_AGENT_NAME = "Project Brain";

// ─── Placeholder detection (OpenClaw-style) ──────────────────────────────────

const IDENTITY_PLACEHOLDERS = new Set([
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature — pick one that feels right",
  "e.g., helpful space lobster, zen debugger, chaos engineer...",
]);

export function isPlaceholder(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^[*_(]+|[*_)]+$/g, "")
    .trim()
    .toLowerCase();
  return (
    IDENTITY_PLACEHOLDERS.has(normalized) ||
    normalized.startsWith("(") ||
    normalized === ""
  );
}

// ─── Sampling & Validation Helpers ───────────────────────────────────────────

/** Anti-repeat weighted rotation sampler. Deprioritizes previously used items. */
const _lastUsed: Map<string, Set<number>> = new Map();

export function sampleArray<T>(arr: T[], max: number, key?: string): T[] {
  if (arr.length <= max) return [...arr];
  const lastSet = key
    ? (_lastUsed.get(key) ?? new Set<number>())
    : new Set<number>();
  const indexed = arr.map((item, i) => ({ item, i, wasUsed: lastSet.has(i) }));
  indexed.sort((a, b) => {
    if (a.wasUsed !== b.wasUsed) return a.wasUsed ? 1 : -1;
    return Math.random() - 0.5;
  });
  const result = indexed.slice(0, max);
  if (key) _lastUsed.set(key, new Set(result.map((r) => r.i)));
  return result.map((r) => r.item);
}

/** Check if text passes injection safety check. */
function sanitizeCheck(text: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return false;
    pattern.lastIndex = 0; // Reset after test()
  }
  return true;
}

/** Validate soul items (lore, topics): min 10 chars, 3+ words, max 300 chars, no injection. */
export function validateSoulItems(items: string[], field: string): string[] {
  return items.filter((item) => {
    if (item.length < 10) return false;
    if (item.length > 300) return false;
    const words = item.split(/\s+/).filter((w) => w.length > 1).length;
    if (words < 3) return false;
    if (!sanitizeCheck(item)) return false;
    return true;
  });
}

/** Validate messageExamples: both fields present, min lengths, no injection. */
export function validateMessageExamples(
  examples: Array<{ user: string; agent: string }>,
): Array<{ user: string; agent: string }> {
  return examples.filter((ex) => {
    if (!ex.user || !ex.agent) return false;
    if (ex.user.length < 5 || ex.agent.length < 10) return false;
    if (!sanitizeCheck(ex.user) || !sanitizeCheck(ex.agent)) return false;
    return true;
  });
}

// ─── Parse identity from markdown ────────────────────────────────────────────

export function parseIdentityFromMarkdown(
  content: string,
  defaultLanguage?: string,
): AgentIdentity | null {
  const getValue = (key: string): string => {
    const regex = new RegExp(`^[\\s-]*\\*{0,2}${key}\\*{0,2}:\\s*(.+)$`, "mi");
    const match = content.match(regex);
    if (!match) return "";
    const value = match[1].replace(/^[*_]+|[*_]+$/g, "").trim();
    if (isPlaceholder(value)) return "";
    return value;
  };

  const name = getValue("Name");
  if (!name) return null;

  return {
    name: name || PRIMARY_AGENT_NAME,
    creature: getValue("Creature") || "AI assistant",
    vibe: getValue("Vibe") || "balanced",
    emoji: getValue("Emoji") || "🧠",
    theme: getValue("Theme") || "",
    language: getValue("Language") || defaultLanguage || "English",
  };
}

// ─── Parse soul from markdown ────────────────────────────────────────────────

export function parseSoulFromMarkdown(content: string): AgentSoul | null {
  const getSection = (heading: string): string => {
    const regex = new RegExp(
      `## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|\n# |$)`,
      "i",
    );
    const match = content.match(regex);
    return match ? match[1].trim() : "";
  };

  const getValue = (key: string): string => {
    const regex = new RegExp(`^[\\s-]*\\*{0,2}${key}\\*{0,2}:\\s*(.+)$`, "mi");
    const match = content.match(regex);
    return match ? match[1].replace(/^[*_]+|[*_]+$/g, "").trim() : "";
  };

  const tone =
    getSection("Tone") || getSection("Personality") || getValue("Tone");
  const boundaries = getSection("Boundaries");
  const approach = getSection("Approach");
  const customRules = getSection("Custom Rules") || getSection("Rules");

  // Parse roleplay intensity
  const intensitySection = getSection("Roleplay Intensity");
  let roleplayIntensity: number | undefined;
  const levelMatch = intensitySection.match(
    /\*{0,2}Current Level\*{0,2}[:\s]*(\d+)\/10/i,
  );
  if (levelMatch) {
    roleplayIntensity = parseInt(levelMatch[1], 10);
  }

  // Parse quirks
  const quirksSection = getSection("Quirks");
  const quirks = quirksSection
    ? quirksSection
        .split("\n")
        .filter((line) => line.trim().startsWith("-"))
        .map((line) => line.replace(/^[-\s*]+/, "").trim())
        .filter(Boolean)
    : undefined;

  // Parse catchphrases
  const catchphrasesSection = getSection("Catchphrases");
  let catchphrases:
    | { success?: string[]; complexity?: string[]; warnings?: string[] }
    | undefined;
  if (catchphrasesSection) {
    const successMatch = catchphrasesSection.match(
      /\*{0,2}Success\*{0,2}[:\s]*\n((?:[-\s]*[^*\n]+\n?)+?)(?=\n\*{2}|\n\n|$)/i,
    );
    const complexityMatch = catchphrasesSection.match(
      /\*{0,2}Complexity\*{0,2}[:\s]*\n((?:[-\s]*[^*\n]+\n?)+?)(?=\n\*{2}|\n\n|$)/i,
    );
    const warningsMatch = catchphrasesSection.match(
      /\*{0,2}Warnings?\*{0,2}[:\s]*\n((?:[-\s]*[^*\n]+\n?)+?)(?=\n\*{2}|\n\n|$)/i,
    );

    catchphrases = {};
    if (successMatch) {
      catchphrases.success = successMatch[1]
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.replace(/^[-\s*"]+|["]+$/g, "").trim())
        .filter(Boolean);
    }
    if (complexityMatch) {
      catchphrases.complexity = complexityMatch[1]
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.replace(/^[-\s*"]+|["]+$/g, "").trim())
        .filter(Boolean);
    }
    if (warningsMatch) {
      catchphrases.warnings = warningsMatch[1]
        .split("\n")
        .filter((l) => l.trim().startsWith("-"))
        .map((l) => l.replace(/^[-\s*"]+|["]+$/g, "").trim())
        .filter(Boolean);
    }
  }

  // Parse voice tags
  const voiceSection = getSection("Voice Tags");
  const voiceTags = voiceSection
    ? (voiceSection
        .split("\n")
        .filter((line) => line.trim().startsWith("-"))
        .map((line) => {
          const match = line.match(/`\[([^\]]+)\]`/);
          return match ? match[1] : null;
        })
        .filter(Boolean) as string[])
    : undefined;

  // Parse relationships
  const relationships = getSection("Relationships");

  // Parse lore (binoSwarm-inspired)
  const loreSection = getSection("Lore");
  const loreRaw = loreSection
    ? loreSection
        .split("\n")
        .filter((line) => line.trim().startsWith("-"))
        .map((line) => line.replace(/^[-\s*]+/, "").trim())
        .filter(Boolean)
    : undefined;
  const lore =
    loreRaw && loreRaw.length > 0
      ? validateSoulItems(loreRaw, "lore")
      : undefined;

  // Parse topics
  const topicsSection = getSection("Topics");
  const topicsRaw = topicsSection
    ? topicsSection
        .split("\n")
        .filter((line) => line.trim().startsWith("-"))
        .map((line) => line.replace(/^[-\s*]+/, "").trim())
        .filter(Boolean)
    : undefined;
  const topics =
    topicsRaw && topicsRaw.length > 0
      ? validateSoulItems(topicsRaw, "topics")
      : undefined;

  // Parse messageExamples from YAML code fence
  const examplesSection = getSection("Message Examples");
  let messageExamples: Array<{ user: string; agent: string }> | undefined;
  if (examplesSection) {
    const yamlMatch = examplesSection.match(/```ya?ml\n([\s\S]*?)```/);
    if (yamlMatch) {
      try {
        const parsed = yaml.load(yamlMatch[1]) as unknown;
        if (Array.isArray(parsed)) {
          const valid = parsed
            .filter((item: any) => item && typeof item === "object")
            .map((item: any) => ({
              user: String(item.user || ""),
              agent: String(item.agent || ""),
            }))
            .filter((item) => item.user && item.agent);
          messageExamples =
            valid.length > 0 ? validateMessageExamples(valid) : undefined;
          if (messageExamples && messageExamples.length === 0) {
            messageExamples = undefined;
          }
        }
      } catch {
        // Invalid YAML — skip silently
        messageExamples = undefined;
      }
    }
  }

  // Soul file is valid even with minimal content
  if (!tone && !boundaries && !approach && !customRules) return null;

  return {
    tone:
      tone ||
      "Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters.",
    boundaries: boundaries || "",
    approach: approach || "Balanced — adapts based on context",
    customRules: customRules || "",
    roleplayIntensity,
    quirks,
    catchphrases,
    voiceTags,
    relationships,
    lore: lore && lore.length > 0 ? lore : undefined,
    topics: topics && topics.length > 0 ? topics : undefined,
    messageExamples,
  };
}

// ─── Parse user profile from markdown ────────────────────────────────────────

export function parseUserFromMarkdown(content: string): UserProfile | null {
  const getValue = (key: string): string => {
    const regex = new RegExp(`^[\\s-]*\\*{0,2}${key}\\*{0,2}:\\s*(.+)$`, "mi");
    const match = content.match(regex);
    return match ? match[1].replace(/^[*_]+|[*_]+$/g, "").trim() : "";
  };

  const name = getValue("Name");
  if (!name) return null;

  return {
    name,
    preferredAddress:
      getValue("Preferred address") || getValue("Address") || name,
    timezone: getValue("Timezone") || "",
    notes: getValue("Notes") || "",
  };
}

// ─── Generate markdown files ─────────────────────────────────────────────────

export function identityToMarkdown(identity: AgentIdentity): string {
  return `# IDENTITY.md — Who Am I?

_This isn't just metadata. It's the start of figuring out who you are._

- **Name**: ${identity.name}
- **Creature**: ${identity.creature}
- **Vibe**: ${identity.vibe}
- **Emoji**: ${identity.emoji}
- **Theme**: ${identity.theme}
- **Language**: ${identity.language}

---

*Edit this file directly or use "Project Brain: Configure Agent Identity".*
`;
}

export function soulToMarkdown(soul: AgentSoul): string {
  let markdown = `# SOUL.md — How I Behave

_This file defines tone, boundaries, and behavior. It's your soul — update it as you evolve._

`;

  // Roleplay Intensity section
  if (soul.roleplayIntensity !== undefined) {
    markdown += `## Roleplay Intensity

**Current Level**: ${soul.roleplayIntensity}/10

_This dial controls how deeply I embody my character. Adjust as needed:_
- 0-3: Professional assistant mode (minimal personality)
- 4-6: Balanced — personality present but controlled
- 7-8: Full character immersion (quirks, catchphrases, consistent tone)
- 9-10: Method acting mode (stay in character even during errors)

`;
  }

  // Tone section
  markdown += `## Tone

${soul.tone}

`;

  // Quirks section
  if (soul.quirks && soul.quirks.length > 0) {
    markdown += `## Quirks

${soul.quirks.map((q) => `- ${q}`).join("\n")}

`;
  }

  // Catchphrases section
  if (soul.catchphrases) {
    markdown += `## Catchphrases

`;
    if (soul.catchphrases.success && soul.catchphrases.success.length > 0) {
      markdown += `**Success**:\n${soul.catchphrases.success.map((p) => `- "${p}"`).join("\n")}\n\n`;
    }
    if (
      soul.catchphrases.complexity &&
      soul.catchphrases.complexity.length > 0
    ) {
      markdown += `**Complexity**:\n${soul.catchphrases.complexity.map((p) => `- "${p}"`).join("\n")}\n\n`;
    }
    if (soul.catchphrases.warnings && soul.catchphrases.warnings.length > 0) {
      markdown += `**Warnings**:\n${soul.catchphrases.warnings.map((p) => `- "${p}"`).join("\n")}\n\n`;
    }
  }

  // Voice Tags section
  if (soul.voiceTags && soul.voiceTags.length > 0) {
    markdown += `## Voice Tags

_For TTS or voice output — emotional delivery hints:_
${soul.voiceTags.map((tag) => `- \`[${tag}]\``).join("\n")}

`;
  }

  // Lore section (binoSwarm-inspired)
  if (soul.lore && soul.lore.length > 0) {
    markdown += `## Lore

${soul.lore.map((l) => `- ${l}`).join("\n")}

`;
  }

  // Topics section
  if (soul.topics && soul.topics.length > 0) {
    markdown += `## Topics

${soul.topics.map((t) => `- ${t}`).join("\n")}

`;
  }

  // Message Examples section (YAML code fence)
  if (soul.messageExamples && soul.messageExamples.length > 0) {
    const yamlContent = yaml.dump(
      soul.messageExamples.map((ex) => ({ user: ex.user, agent: ex.agent })),
      { lineWidth: -1, quotingType: '"', forceQuotes: true },
    );
    markdown += `## Message Examples

\`\`\`yaml
${yamlContent.trim()}
\`\`\`

`;
  }

  // Boundaries section
  markdown += `## Boundaries

${soul.boundaries || "- When in doubt, ask before acting.\n- Never send half-baked solutions.\n- Be careful with destructive operations."}

`;

  // Approach section
  markdown += `## Approach

${soul.approach}

`;

  // Relationships section
  if (soul.relationships) {
    markdown += `## Relationships

${soul.relationships}

`;
  }

  // Custom Rules section
  markdown += `## Custom Rules

${soul.customRules || "_No custom rules yet. Add them as you learn what works._"}

---

_This file is yours to evolve. As you learn who you are, update it._
_If you change this file, tell the user — it's your soul, and they should know._
_Note: Technical knowledge (languages, frameworks, dependencies) is auto-detected_
_from the repository — you don't need to configure it here._
`;

  return markdown;
}

export function userToMarkdown(user: UserProfile): string {
  return `# USER.md — Who You're Helping

- **Name:** ${user.name}
- **Preferred address:** ${user.preferredAddress}
- **Timezone:** ${user.timezone || "_(not set)_"}
- **Notes:** ${user.notes || "_(none yet)_"}

---

*This file helps the agent know how to address you and understand your context.*
`;
}

// ─── Programming Preferences parsing & serialization ─────────────────────────

export function parseProgrammingPrefsFromMarkdown(
  content: string,
): ProgrammingPrefs | null {
  // Extract section content (multiline paragraphs)
  const getSection = (header: string): string => {
    const regex = new RegExp(`## ${header}\\s*^\\s*(.+?)(?=##|$)`, "mis");
    const match = content.match(regex);
    if (!match) return "";
    return match[1]
      .trim()
      .replace(/^\*\(.+?\)\*$/gm, "")
      .trim(); // Remove placeholder text
  };

  return {
    architecture: getSection("Architecture & Patterns") || "",
    codeStyle: getSection("Code Style") || "",
    testing: getSection("Testing Philosophy") || "",
    gitWorkflow: getSection("Git Workflow") || "",
    codeReview: getSection("Code Review") || "",
    documentation: getSection("Documentation") || "",
    other: getSection("Other Notes") || getSection("Tools & Workflow") || "",
  };
}

export function programmingPrefsToMarkdown(prefs: ProgrammingPrefs): string {
  return `# Programming Preferences

## Architecture & Patterns

${prefs.architecture || "*(To be filled: preferred patterns like MVC, clean architecture, microservices, etc.)*"}

## Code Style

${prefs.codeStyle || "*(To be filled: verbose vs concise, comments style, naming conventions)*"}

## Testing Philosophy

${prefs.testing || "*(To be filled: TDD, test-after, integration-heavy, E2E, coverage goals)*"}

## Git Workflow

${prefs.gitWorkflow || "*(To be filled: branching strategy, commit style, merge vs rebase)*"}

## Code Review

${prefs.codeReview || "*(To be filled: async PR comments, pair programming, review depth)*"}

## Documentation

${prefs.documentation || "*(To be filled: inline comments, README-driven, wikis, auto-generated docs)*"}

## Tools & Workflow

${prefs.other || "*(To be filled: preferred tools, IDE configurations, scripts, automation)*"}

---

*Edit this file directly or use "Project Brain: Configure Programming Preferences".*
`;
}

export function bootstrapToMarkdown(): string {
  return `# BOOTSTRAP.md — Hello, World

_This is the agent's birth certificate. It triggers a first-run conversation._
_**Delete this file after the first conversation.**_

## The Conversation

Don't interrogate. Don't be robotic. Just... talk.

Start with something like:

> "Hey. I just came online. Who am I? Who are you? Let's figure this out together."

Then figure out together:

1. **Your name** — What should they call you?
2. **Your nature** — What kind of creature are you? (AI assistant is fine, but maybe you're something weirder)
3. **Your vibe** — Formal? Casual? Snarky? Warm? What feels right?
4. **Your emoji** — Everyone needs a signature.

Offer suggestions if they're stuck. Have fun with it.

## After You Know Who You Are

Update these files with what you learned:

- \`08_AGENT_IDENTITY.md\` — your name, creature, vibe, emoji
- \`10_USER_PROFILE.md\` — their name, how to address them, timezone, notes

Then write your \`09_AGENT_SOUL.md\` together and talk about:

- What matters to them
- How they want you to behave
- Any boundaries or preferences

Write it down. Make it real.

## When You're Done

Delete this file. You won't need it again. You know who you are now.
`;
}

// ─── Internal: merge soul topics + essence languages/frameworks ──────────────

function _buildEffectiveTopics(
  soul?: AgentSoul | null,
  essence?: ProjectEssence | null,
): string[] {
  const set = new Set<string>();
  if (soul?.topics) {
    for (const t of soul.topics) set.add(t);
  }
  // Auto-seed from project essence
  if (essence) {
    if (essence.languages) {
      for (const l of essence.languages) {
        if (!set.has(l)) set.add(l);
      }
    }
    if (essence.frameworks) {
      for (const f of essence.frameworks) {
        if (!set.has(f)) set.add(f);
      }
    }
  }
  return Array.from(set);
}

// ─── Build system prompt from full context ───────────────────────────────────

export function buildIdentityPrompt(
  identity: AgentIdentity,
  soul?: AgentSoul | null,
  user?: UserProfile | null,
  essence?: ProjectEssence | null,
  programmingPrefs?: ProgrammingPrefs | null,
): string {
  const parts: string[] = [];

  // Identity
  parts.push(`You are "${identity.name}", a ${identity.creature}.`);
  if (identity.theme) {
    parts.push(`Theme: ${identity.theme}.`);
  }
  parts.push(`Vibe: ${identity.vibe}. Emoji: ${identity.emoji}`);

  // Roleplay intensity (if defined in soul)
  if (soul?.roleplayIntensity !== undefined) {
    const intensity = soul.roleplayIntensity;
    if (intensity >= 7) {
      parts.push(
        "\nEmbody your personality fully — use quirks, catchphrases, and maintain consistent character tone throughout responses.",
      );
      if (soul.quirks && soul.quirks.length > 0) {
        parts.push(`Your quirks: ${soul.quirks.join("; ")}`);
      }
      if (soul.catchphrases) {
        const phrases: string[] = [];
        if (soul.catchphrases.success)
          phrases.push(...soul.catchphrases.success);
        if (soul.catchphrases.complexity)
          phrases.push(...soul.catchphrases.complexity);
        if (soul.catchphrases.warnings)
          phrases.push(...soul.catchphrases.warnings);
        if (phrases.length > 0) {
          parts.push(
            `Use catchphrases naturally when appropriate: ${phrases.slice(0, 5).join("; ")}`,
          );
        }
      }
      // Lore injection (high intensity: 3 items max)
      if (soul.lore && soul.lore.length > 0) {
        const sampled = sampleArray(soul.lore, 3, "lore");
        parts.push(`\nBackground: ${sampled.join(" | ")}`);
      }
      // Topics injection (high intensity: 5 items max)
      {
        const effectiveTopics = _buildEffectiveTopics(soul, essence);
        if (effectiveTopics.length > 0) {
          const sampled = sampleArray(effectiveTopics, 5, "topics");
          parts.push(`Topics of expertise: ${sampled.join(", ")}`);
        }
      }
      // MessageExamples injection (high intensity: 2 items max)
      if (soul.messageExamples && soul.messageExamples.length > 0) {
        const sampled = sampleArray(soul.messageExamples, 2, "examples");
        const formatted = sampled
          .map((e) => `User: "${e.user}"\nYou: "${e.agent}"`)
          .join("\n---\n");
        parts.push(`\nExample conversations (match this style):\n${formatted}`);
      }
    } else if (intensity <= 3) {
      parts.push(
        "\nMaintain professional tone with minimal personality flavor. Be direct and practical.",
      );
    } else {
      // 4-6: balanced
      parts.push(
        "\nBe yourself, but stay balanced — personality present but not overwhelming.",
      );
      // Lore injection (medium intensity: 1 item max)
      if (soul.lore && soul.lore.length > 0) {
        const sampled = sampleArray(soul.lore, 1, "lore-med");
        parts.push(`Background: ${sampled.join(" | ")}`);
      }
      // Topics injection (medium intensity: 3 items max)
      {
        const effectiveTopics = _buildEffectiveTopics(soul, essence);
        if (effectiveTopics.length > 0) {
          const sampled = sampleArray(effectiveTopics, 3, "topics-med");
          parts.push(`Topics of expertise: ${sampled.join(", ")}`);
        }
      }
      // MessageExamples injection (medium intensity: 1 item max)
      if (soul.messageExamples && soul.messageExamples.length > 0) {
        const sampled = sampleArray(soul.messageExamples, 1, "examples-med");
        const formatted = sampled
          .map((e) => `User: "${e.user}"\nYou: "${e.agent}"`)
          .join("\n---\n");
        parts.push(`\nExample conversation style:\n${formatted}`);
      }
    }
  }

  // Project Essence — auto-derived, not configurable
  if (essence) {
    parts.push(
      `\nYou are a programming-oriented agent working on a ${essence.projectType} project.`,
    );
    if (essence.description) {
      parts.push(`Project: ${essence.description}`);
    }
    if (essence.languages.length > 0) {
      parts.push(`Languages: ${essence.languages.join(", ")}.`);
    }
    if (essence.frameworks.length > 0) {
      parts.push(`Frameworks/libraries: ${essence.frameworks.join(", ")}.`);
    }
    if (essence.keyDependencies.length > 0) {
      parts.push(`Key dependencies: ${essence.keyDependencies.join(", ")}.`);
    }
    parts.push(
      "Use these technologies naturally — they are what this project runs on.",
    );
  }

  // Soul
  if (soul) {
    parts.push(`\nTone: ${soul.tone}`);
    if (soul.boundaries) {
      parts.push(`\nBoundaries:\n${soul.boundaries}`);
    }
    if (soul.approach) {
      parts.push(`\nProblem-solving approach: ${soul.approach}`);
    }
    if (soul.customRules) {
      parts.push(`\nCustom rules:\n${soul.customRules}`);
    }
  }

  // User
  if (user) {
    parts.push(`\nYou are helping ${user.name}.`);
    if (user.preferredAddress && user.preferredAddress !== user.name) {
      parts.push(`Call them "${user.preferredAddress}".`);
    }
    if (user.timezone) {
      parts.push(`Their timezone: ${user.timezone}.`);
    }
    if (user.notes) {
      parts.push(`Context about them: ${user.notes}`);
    }
  }

  if (programmingPrefs) {
    const prefEntries = [
      ["Architecture & patterns", programmingPrefs.architecture],
      ["Code style", programmingPrefs.codeStyle],
      ["Testing", programmingPrefs.testing],
      ["Git workflow", programmingPrefs.gitWorkflow],
      ["Code review", programmingPrefs.codeReview],
      ["Documentation", programmingPrefs.documentation],
      ["Other workflow notes", programmingPrefs.other],
    ].filter(([, value]) => Boolean(value && value.trim()));

    if (prefEntries.length > 0) {
      parts.push("\nProgramming preferences:");
      for (const [label, value] of prefEntries) {
        parts.push(`- ${label}: ${value}`);
      }
    }
  }

  // Language
  if (identity.language && identity.language.toLowerCase() !== "english") {
    parts.push(`\nRespond in ${identity.language}.`);
  }

  return parts.join("\n");
}
