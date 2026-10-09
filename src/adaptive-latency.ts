// ============================================================
// adaptive-latency.ts — EWMA-based latency prediction
// Part of F2: Debounce Adaptativo + Latency Tracker
// KiloCode Adoption Sprint 1
// ============================================================
// Pure module — zero VS Code dependencies, 100% testable.
// Tracks response times per key using Exponentially Weighted
// Moving Average (EWMA) with hierarchical fallback:
//   (model:task) → (model) → (tier default)
// ============================================================

import type { ModelTier } from "./model-router-types";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LatencyPrediction {
  /** Predicted latency in milliseconds */
  ms: number;
  /** True if enough samples (≥MIN_SAMPLES) to trust this prediction */
  confident: boolean;
}

interface EwmaEntry {
  ewma: number;
  count: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_ALPHA = 0.3;
const MIN_CONFIDENT_SAMPLES = 5;

/** Reasonable defaults per tier when no data exists */
const TIER_LATENCY_DEFAULTS: Record<ModelTier, number> = {
  free: 1500,
  cheap: 2500,
  standard: 4000,
  premium: 8000,
  ultra: 12000,
};

const FALLBACK_DEFAULT_MS = 4000; // used when tier is unknown

// ─── AdaptiveLatencyTracker ────────────────────────────────────────────────

export class AdaptiveLatencyTracker {
  private entries = new Map<string, EwmaEntry>();
  private modelTiers = new Map<string, ModelTier>();
  private readonly alpha: number;

  constructor(alpha: number = DEFAULT_ALPHA) {
    this.alpha = Math.max(0.01, Math.min(0.99, alpha));
  }

  // ─── Recording ─────────────────────────────────────────────────────────

  /**
   * Record an observed latency for a given key.
   * Key can be a modelId, or a composite "modelId:taskType".
   */
  record(key: string, latencyMs: number): void {
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { ewma: latencyMs, count: 1 });
    } else {
      existing.ewma = this.alpha * latencyMs + (1 - this.alpha) * existing.ewma;
      existing.count++;
    }
  }

  // ─── Prediction ────────────────────────────────────────────────────────

  /**
   * Get expected latency for a specific key.
   * Returns tier default if insufficient data.
   */
  getExpected(key: string): LatencyPrediction {
    const entry = this.entries.get(key);
    if (!entry) {
      // No data at all — use tier default if available
      const tier = this.modelTiers.get(key);
      return {
        ms: tier ? TIER_LATENCY_DEFAULTS[tier] : FALLBACK_DEFAULT_MS,
        confident: false,
      };
    }
    return {
      ms: entry.ewma,
      confident: entry.count >= MIN_CONFIDENT_SAMPLES,
    };
  }

  /**
   * Hierarchical prediction: tries specific (model:task) first,
   * falls back to model-level, then tier default.
   */
  getExpectedHierarchical(
    modelId: string,
    taskType?: string,
  ): LatencyPrediction {
    // Level 1: specific (model:task) — only if taskType provided
    if (taskType) {
      const specificEntry = this.entries.get(`${modelId}:${taskType}`);
      if (specificEntry && specificEntry.count >= MIN_CONFIDENT_SAMPLES) {
        return { ms: specificEntry.ewma, confident: true };
      }
    }

    // Level 2: model-level — direct entry lookup avoids getExpected overhead
    const generalEntry = this.entries.get(modelId);
    if (generalEntry && generalEntry.count >= MIN_CONFIDENT_SAMPLES) {
      return { ms: generalEntry.ewma, confident: true };
    }

    // Level 3: use model-level EWMA if exists (even if not confident), else tier default
    const tier = this.modelTiers.get(modelId);
    return {
      ms:
        generalEntry?.ewma ??
        (tier ? TIER_LATENCY_DEFAULTS[tier] : FALLBACK_DEFAULT_MS),
      confident: false,
    };
  }

  // ─── Tier Management ───────────────────────────────────────────────────

  /** Associate a model with a tier for default latency lookup */
  setModelTier(modelId: string, tier: ModelTier): void {
    this.modelTiers.set(modelId, tier);
  }

  // ─── Reset ─────────────────────────────────────────────────────────────

  /** Clear tracking data for a specific key */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Clear all tracking data */
  resetAll(): void {
    this.entries.clear();
  }

  // ─── Stats / Introspection ─────────────────────────────────────────────

  /** Get sample count for a key */
  getSampleCount(key: string): number {
    return this.entries.get(key)?.count ?? 0;
  }

  /** Get all tracked keys */
  getTrackedKeys(): string[] {
    return [...this.entries.keys()];
  }
}
