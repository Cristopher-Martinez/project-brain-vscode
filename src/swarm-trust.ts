// ─── Swarm Trust Scoring ─────────────────────────────────────────────────────
// Agent governance pattern: track worker reliability over time with decay.
// Based on agent-governance skill (awesome-copilot adaptation).
//
// Usage:
//   const registry = new SwarmTrustRegistry();
//   registry.record(taskId, true);   // after success
//   registry.record(taskId, false);  // after failure
//   registry.canAutomate(taskId);    // true if trust >= 0.7

/** Trust score for a single worker/task identity. */
export interface TrustScore {
  workerId: string;
  score: number; // 0.0 (untrusted) to 1.0 (fully trusted), starts at 0.5
  successes: number;
  failures: number;
  lastUpdated: number;
}

/** Reward applied per success (additive, decaying as score approaches 1.0). */
const TRUST_REWARD = 0.08;
/** Penalty applied per failure (multiplicative reduction). */
const TRUST_PENALTY = 0.2;
/** Decay rate per millisecond (trust erodes without activity). */
const DECAY_RATE_PER_MS = 0.000001;

/** Get the current effective trust score with temporal decay. */
export function currentTrust(trust: TrustScore): number {
  const elapsed = Date.now() - trust.lastUpdated;
  const decay = Math.exp(-DECAY_RATE_PER_MS * elapsed);
  return trust.score * decay;
}

/** Whether the worker/task can operate autonomously (high trust). */
export function canAutomate(trust: TrustScore): boolean {
  return currentTrust(trust) >= 0.7;
}

/** Whether the worker/task needs human oversight (medium trust). */
export function needsOversight(trust: TrustScore): boolean {
  const t = currentTrust(trust);
  return t >= 0.4 && t < 0.7;
}

/** Record a successful task execution and update trust. */
export function recordSuccess(trust: TrustScore): TrustScore {
  return {
    ...trust,
    successes: trust.successes + 1,
    score: Math.min(1.0, trust.score + TRUST_REWARD * (1 - trust.score)),
    lastUpdated: Date.now(),
  };
}

/** Record a failed task execution and update trust. */
export function recordFailure(trust: TrustScore): TrustScore {
  return {
    ...trust,
    failures: trust.failures + 1,
    score: Math.max(0.05, trust.score - TRUST_PENALTY * trust.score),
    lastUpdated: Date.now(),
  };
}

/**
 * In-memory trust registry for swarm workers.
 * Keyed by workerId (typically taskId or model tier).
 * Resets on extension restart (non-persistent by design — trust must be re-earned).
 */
export class SwarmTrustRegistry {
  private readonly _scores = new Map<string, TrustScore>();

  /** Get or initialize trust score for a worker. */
  get(workerId: string): TrustScore {
    if (!this._scores.has(workerId)) {
      this._scores.set(workerId, {
        workerId,
        score: 0.5, // neutral starting point
        successes: 0,
        failures: 0,
        lastUpdated: Date.now(),
      });
    }
    return this._scores.get(workerId)!;
  }

  /** Record a result for a worker and update their trust score. */
  record(workerId: string, success: boolean): TrustScore {
    const current = this.get(workerId);
    const updated = success ? recordSuccess(current) : recordFailure(current);
    this._scores.set(workerId, updated);
    return updated;
  }

  /** Get the most trusted worker from a list. */
  mostTrusted(workerIds: string[]): string | undefined {
    if (workerIds.length === 0) return undefined;
    return workerIds.reduce((best, id) =>
      currentTrust(this.get(id)) > currentTrust(this.get(best)) ? id : best,
    );
  }

  /** Get all scores as a plain record for logging/display. */
  snapshot(): Record<
    string,
    { score: number; successes: number; failures: number }
  > {
    const result: Record<
      string,
      { score: number; successes: number; failures: number }
    > = {};
    for (const [id, trust] of this._scores) {
      result[id] = {
        score: Math.round(currentTrust(trust) * 100) / 100,
        successes: trust.successes,
        failures: trust.failures,
      };
    }
    return result;
  }

  /** Reset all scores (e.g., between swarm sessions). */
  reset(): void {
    this._scores.clear();
  }
}

/**
 * Global registry singleton — shared within the extension process.
 * Trust accumulates across swarm runs within the same VS Code session.
 */
export const globalSwarmTrust = new SwarmTrustRegistry();
