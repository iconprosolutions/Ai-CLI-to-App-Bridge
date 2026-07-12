'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// A safe slug is one word: letters, digits, hyphens, underscores. No path
// separators, no dots. This blocks ../ traversal before path.join is called.
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

// Async context-file store with per-file write locks and atomic writes.
// Replaces the bridges' sync fs CRUD, whose unlocked read-modify-write
// append() lost updates under concurrency.
class ContextStore {
  constructor(rootDir, { types = ['clients', 'projects', 'global'], globalFile = 'agency-context' } = {}) {
    this.root = path.resolve(rootDir);
    this.types = new Set(types);
    this.globalFile = globalFile;
    this.locks = new Map();
  }

  _withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const guard = run.catch(() => {});
    this.locks.set(key, guard);
    guard.then(() => {
      if (this.locks.get(key) === guard) this.locks.delete(key);
    });
    return run;
  }

  resolvePath(type, slug) {
    if (!this.types.has(type)) {
      throw new Error(`Invalid type. Use: ${[...this.types].join(', ')}`);
    }
    const name = type === 'global' ? this.globalFile : slug;
    if (typeof name !== 'string' || !SLUG_RE.test(name)) {
      throw new Error('Invalid slug: must be alphanumeric, hyphen, or underscore only');
    }
    const candidate = path.join(this.root, type, `${name}.md`);
    // Defence in depth: even when the slug passes the regex, confirm the
    // resolved path stays inside the root.
    if (!path.resolve(candidate).startsWith(this.root + path.sep)) {
      throw new Error('Path traversal detected');
    }
    return candidate;
  }

  async read(type, slug) {
    const file = this.resolvePath(type, slug);
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(type, slug, content) {
    const file = this.resolvePath(type, slug);
    return this._withLock(file, async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // Atomic: write a sibling temp file, then rename over the target.
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, content, 'utf8');
      await fsp.rename(tmp, file);
    });
  }

  async append(type, slug, section) {
    const file = this.resolvePath(type, slug);
    return this._withLock(file, async () => {
      let existing = '';
      try {
        existing = await fsp.readFile(file, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const timestamp = new Date().toISOString().split('T')[0];
      const next = `${existing}\n\n---\n## Update: ${timestamp}\n\n${section}`;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, next, 'utf8');
      await fsp.rename(tmp, file);
    });
  }

  async remove(type, slug) {
    const file = this.resolvePath(type, slug);
    return this._withLock(file, async () => {
      try {
        await fsp.unlink(file);
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  async list(type) {
    if (!this.types.has(type)) {
      throw new Error(`Invalid type. Use: ${[...this.types].join(', ')}`);
    }
    const dir = path.join(this.root, type);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = [];
    for (const f of names) {
      if (!f.endsWith('.md')) continue;
      const stats = await fsp.stat(path.join(dir, f));
      files.push({
        slug: f.replace(/\.md$/, ''),
        filename: f,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
      });
    }
    return files;
  }
}

module.exports = { ContextStore, SLUG_RE };
