/**
 * Context Enricher — Session Accumulator
 *
 * Tracks entities, domains, and files across enrichment rounds
 * within the same loop session. Each new round inherits context
 * from previous rounds, building a progressively richer picture.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionEnrichState {
  entities: Set<string>;
  domains: Set<string>;
  files: Set<string>;
  roundCount: number;
  lastUpdated: number;
}

// ─── Session Cache ─────────────────────────────────────────────────────────

/** In-memory cache of enrichment state per session */
const sessionCache = new Map<string, SessionEnrichState>();

/** Max age before a session is evicted (2 hours) */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Max sessions to keep in cache */
const MAX_SESSIONS = 20;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get accumulated context from previous enrichment rounds.
 * Returns empty arrays if this is the first round.
 */
export function getSessionAccumulation(sessionId: string): {
  entities: string[];
  domains: string[];
  files: string[];
  roundCount: number;
} {
  const state = sessionCache.get(sessionId);
  if (!state) {
    return { entities: [], domains: [], files: [], roundCount: 0 };
  }
  return {
    entities: [...state.entities],
    domains: [...state.domains],
    files: [...state.files],
    roundCount: state.roundCount,
  };
}

/**
 * Record entities, domains, and files from the current enrichment round.
 * Merges with any existing state for this session.
 */
export function recordEnrichRound(
  sessionId: string,
  data: {
    entities: string[];
    domains: string[];
    files: string[];
  },
): void {
  evictStale();

  const existing = sessionCache.get(sessionId);
  if (existing) {
    for (const e of data.entities) existing.entities.add(e);
    for (const d of data.domains) existing.domains.add(d);
    for (const f of data.files) existing.files.add(f);
    existing.roundCount++;
    existing.lastUpdated = Date.now();
  } else {
    sessionCache.set(sessionId, {
      entities: new Set(data.entities),
      domains: new Set(data.domains),
      files: new Set(data.files),
      roundCount: 1,
      lastUpdated: Date.now(),
    });
  }
}

/**
 * Clear session accumulation (e.g., when loop ends).
 */
export function clearSessionAccumulation(sessionId: string): void {
  sessionCache.delete(sessionId);
}

// ─── Internals ─────────────────────────────────────────────────────────────

/** Remove stale sessions and enforce max size */
function evictStale(): void {
  const now = Date.now();
  for (const [id, state] of sessionCache) {
    if (now - state.lastUpdated > MAX_AGE_MS) {
      sessionCache.delete(id);
    }
  }
  // If still over limit, remove oldest
  if (sessionCache.size > MAX_SESSIONS) {
    const entries = [...sessionCache.entries()].sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
    const toRemove = entries.slice(0, sessionCache.size - MAX_SESSIONS);
    for (const [id] of toRemove) {
      sessionCache.delete(id);
    }
  }
}
