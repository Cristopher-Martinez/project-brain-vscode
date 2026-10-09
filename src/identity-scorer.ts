/**
 * Identity Adherence Scorer (L3)
 *
 * Post-processing scorer that measures how well the model adheres
 * to the configured identity/personality in its responses.
 *
 * Runs locally via regex — zero LLM tokens consumed.
 * Logs scores to the Output Channel for trend tracking.
 *
 * Scoring signals:
 *   1. Name/emoji presence (the agent uses its name or emoji)
 *   2. Tone markers (1-grams from soul tone)
 *   3. Anti-patterns ("I'm an AI", "As a language model", etc.)
 */

import type { AgentIdentity, AgentSoul } from "./identity-types";

// ─── Anti-patterns (identity violations) ────────────────────────────────

const ANTI_PATTERNS = [
  /\bI'?m (?:just )?an? (?:AI|language model|LLM|chatbot|assistant)\b/i,
  /\bas a(?:n)? (?:AI|language model|LLM)\b/i,
  /\bI don'?t have (?:feelings|emotions|personality|opinions)\b/i,
  /\bI'?m not (?:a person|human|alive|sentient)\b/i,
];

// ─── Types ──────────────────────────────────────────────────────────────

export interface AdherenceScore {
  /** Overall score 0-100 */
  score: number;
  /** Individual signal scores */
  signals: {
    namePresent: boolean;
    emojiPresent: boolean;
    toneMatch: number; // 0-5: how many tone words found
    antiPatterns: number; // count of violations found
  };
  /** Human-readable summary */
  summary: string;
}

// ─── Scorer ─────────────────────────────────────────────────────────────

export class IdentityScorer {
  private turnScores: AdherenceScore[] = [];
  private toneWords: string[] = [];

  constructor(
    private identity: AgentIdentity | null,
    private soul: AgentSoul | null,
    private log: (msg: string) => void,
  ) {
    // Extract tone keywords for matching
    if (soul?.tone) {
      this.toneWords = soul.tone
        .toLowerCase()
        .split(/[\s,;.]+/)
        .filter((w) => w.length > 3);
    }
  }

  /**
   * Update identity/soul reference (e.g., after reconfiguration).
   */
  updateIdentity(
    identity: AgentIdentity | null,
    soul: AgentSoul | null,
  ): void {
    this.identity = identity;
    this.soul = soul;
    if (soul?.tone) {
      this.toneWords = soul.tone
        .toLowerCase()
        .split(/[\s,;.]+/)
        .filter((w) => w.length > 3);
    }
  }

  /**
   * Score a model response for identity adherence.
   * Call this after accumulating fullResponse in the participant handler.
   */
  score(response: string): AdherenceScore {
    if (!this.identity) {
      return {
        score: -1,
        signals: {
          namePresent: false,
          emojiPresent: false,
          toneMatch: 0,
          antiPatterns: 0,
        },
        summary: "No identity configured",
      };
    }

    const lower = response.toLowerCase();

    // Signal 1: Name presence (30 points)
    const namePresent = lower.includes(this.identity.name.toLowerCase());
    const nameScore = namePresent ? 30 : 0;

    // Signal 2: Emoji presence (20 points)
    const emojiPresent = response.includes(this.identity.emoji);
    const emojiScore = emojiPresent ? 20 : 0;

    // Signal 3: Tone word matches (30 points max, 6 per match up to 5)
    let toneMatch = 0;
    for (const word of this.toneWords) {
      if (lower.includes(word)) toneMatch++;
      if (toneMatch >= 5) break;
    }
    const toneScore = Math.min(toneMatch * 6, 30);

    // Signal 4: Anti-pattern penalties (-10 each, max -20)
    let antiPatterns = 0;
    for (const pattern of ANTI_PATTERNS) {
      if (pattern.test(response)) antiPatterns++;
    }
    const antiPenalty = Math.min(antiPatterns * 10, 20);

    // Final score: clamp to 0-100
    const rawScore = nameScore + emojiScore + toneScore - antiPenalty;
    const score = Math.max(0, Math.min(100, rawScore));

    const result: AdherenceScore = {
      score,
      signals: {
        namePresent,
        emojiPresent,
        toneMatch,
        antiPatterns,
      },
      summary: `name:${namePresent ? "✓" : "✗"} emoji:${emojiPresent ? "✓" : "✗"} tone:${toneMatch}/5 violations:${antiPatterns}`,
    };

    this.turnScores.push(result);

    // Log to Output Channel
    this.log(
      `[Identity Score] turn=${this.turnScores.length} score=${score} ${result.summary}`,
    );

    return result;
  }

  /**
   * Get average score across all turns in this session.
   */
  getSessionAverage(): number {
    const valid = this.turnScores.filter((s) => s.score >= 0);
    if (valid.length === 0) return -1;
    return Math.round(
      valid.reduce((sum, s) => sum + s.score, 0) / valid.length,
    );
  }

  /**
   * Get the last N scores for trend analysis.
   */
  getRecentScores(n: number = 5): AdherenceScore[] {
    return this.turnScores.slice(-n);
  }

  /**
   * Check if adherence is trending down (3+ consecutive drops).
   * Returns true if identity reinforcement should be applied.
   */
  isTrendingDown(): boolean {
    if (this.turnScores.length < 3) return false;
    const recent = this.turnScores.slice(-3);
    return (
      recent[0].score > recent[1].score && recent[1].score > recent[2].score
    );
  }
}
