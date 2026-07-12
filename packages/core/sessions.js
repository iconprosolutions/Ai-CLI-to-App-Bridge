'use strict';

// Bounded in-memory session registry. Sessions are lightweight telemetry
// (task counts, last activity) — not CLI conversation state. Bounded both by
// TTL and by entry count so arbitrary client slugs can't grow memory
// indefinitely inside the TTL window.
class SessionRegistry {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 1000, idPrefix = 'ses' } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.idPrefix = idPrefix;
    this.map = new Map();
  }

  getOrCreate(slug, extra = {}) {
    const existing = this.map.get(slug);
    if (existing) {
      this.touch(slug);
      return existing;
    }
    const session = {
      sessionId: `${this.idPrefix}-${slug}-${Date.now()}`,
      clientSlug: slug,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      taskCount: 0,
      ...extra,
    };
    this.map.set(slug, session);
    // Evict oldest-activity entries beyond the cap (Map preserves insertion
    // order; we scan for true LRU since touch() doesn't reorder).
    while (this.map.size > this.maxEntries) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, s] of this.map) {
        if (s.lastActivity < oldestAt) {
          oldestAt = s.lastActivity;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.map.delete(oldestKey);
    }
    return session;
  }

  get(slug) {
    return this.map.get(slug) || null;
  }

  touch(slug) {
    const s = this.map.get(slug);
    if (s) {
      s.lastActivity = Date.now();
      s.taskCount += 1;
    }
    return s || null;
  }

  remove(slug) {
    return this.map.delete(slug);
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [slug, s] of this.map) {
      if (now - s.lastActivity > this.ttlMs) {
        this.map.delete(slug);
        removed += 1;
      }
    }
    return removed;
  }

  list() {
    return [...this.map.values()];
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { SessionRegistry };
