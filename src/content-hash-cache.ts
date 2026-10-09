/**
 * ContentHashCache<T> — Generic hash-based in-memory cache with mtime pre-check and LRU eviction.
 *
 * Inspired by KiloCode's file-caching patterns.
 * Pure module: zero VS Code dependencies, fully testable standalone.
 *
 * Usage:
 *   const cache = new ContentHashCache<string>(500);
 *   if (cache.needsRecheck(filePath)) {
 *     const content = fs.readFileSync(filePath, 'utf-8');
 *     const hash = computeContentHash(content);
 *     return cache.getOrCompute(filePath, hash, () => expensiveParse(content));
 *   }
 *   return cache.get(filePath, lastKnownHash);
 *
 * @module content-hash-cache
 */

import * as crypto from "crypto";
import * as fs from "fs";

/**
 * Compute a truncated SHA-256 hash of content (16 hex chars = 64 bits).
 * Collision probability for <1000 entries is astronomically low (~10⁻¹⁵).
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

interface CacheEntry<T> {
  hash: string;
  value: T;
}

/**
 * Generic in-memory cache that invalidates entries when content hash changes.
 * Includes mtime pre-check to avoid unnecessary file reads and LRU eviction.
 */
export class ContentHashCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private mtimeCache = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Get cached value if key exists AND hash matches. Returns undefined on miss. */
  get(key: string, hash: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.hash !== hash) return undefined;
    return entry.value;
  }

  /** Store a value with its content hash. Evicts oldest entry if at capacity. */
  set(key: string, hash: string, value: T): void {
    // Delete first to reset insertion order (for LRU)
    this.cache.delete(key);
    this.evictIfNeeded();
    this.cache.set(key, { hash, value });
  }

  /**
   * Get cached value or compute it via loader on miss.
   * If hash matches existing entry, returns cached value without calling loader.
   * Note: Uses has() + get() to correctly handle cached undefined/null values.
   */
  getOrCompute(key: string, hash: string, loader: () => T): T {
    const entry = this.cache.get(key);
    if (entry && entry.hash === hash) return entry.value;
    const value = loader();
    this.set(key, hash, value);
    return value;
  }

  /**
   * Check if a file needs re-reading by comparing mtime.
   * Returns true if mtime changed (or first check). Returns false if unchanged.
   * For nonexistent files, returns false (graceful — nothing to recheck).
   */
  needsRecheck(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      const lastMtime = this.mtimeCache.get(filePath);
      if (lastMtime === stat.mtimeMs) return false;
      this.mtimeCache.set(filePath, stat.mtimeMs);
      return true;
    } catch {
      // File doesn't exist or can't be stat'd — nothing to recheck
      return false;
    }
  }

  /** Check if a key exists in the cache (regardless of hash). */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Get the cached value for a key regardless of hash. Useful when mtime confirms no change. */
  getCurrent(key: string): T | undefined {
    const entry = this.cache.get(key);
    return entry?.value;
  }

  /** Remove a specific key from the cache. */
  delete(key: string): boolean {
    this.mtimeCache.delete(key);
    return this.cache.delete(key);
  }

  /** Clear all cache entries and mtime data. */
  clear(): void {
    this.cache.clear();
    this.mtimeCache.clear();
  }

  /** Get all cached keys. */
  keys(): string[] {
    return [...this.cache.keys()];
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }

  // ─── Internals ──────────────────────────────────────────────

  private evictIfNeeded(): void {
    if (this.cache.size < this.maxEntries) return;
    // Single iterator: avoids creating a new keys() iterator per eviction round
    const iter = this.cache.keys();
    while (this.cache.size >= this.maxEntries) {
      const { value: oldest, done } = iter.next();
      if (done) break;
      this.cache.delete(oldest);
      this.mtimeCache.delete(oldest);
    }
  }
}
