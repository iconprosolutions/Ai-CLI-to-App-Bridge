'use strict';

const fs = require('fs');
const crypto = require('crypto');

const VALID_ENGINES = new Set(['claude', 'gemini']);

// Validate a parsed routes.json. Throws with a precise message on any
// problem — a boot-time failure is better than silently serving a broken
// catalogue; a reload-time failure keeps the last good config.
function validateRoutes(data) {
  if (!data || typeof data !== 'object') throw new Error('routes.json: root must be an object');
  if (!Array.isArray(data.routes) || data.routes.length === 0) throw new Error('routes.json: "routes" must be a non-empty array');
  const seen = new Set();
  for (const r of data.routes) {
    for (const field of ['id', 'label', 'engine', 'model']) {
      if (typeof r[field] !== 'string' || !r[field]) throw new Error(`routes.json: route missing "${field}" (${r.id || 'unknown'})`);
    }
    if (!VALID_ENGINES.has(r.engine)) throw new Error(`routes.json: unknown engine "${r.engine}" on ${r.id}`);
    if (r.aliases !== undefined && !Array.isArray(r.aliases)) throw new Error(`routes.json: aliases must be an array on ${r.id}`);
    if (seen.has(r.id)) throw new Error(`routes.json: duplicate id "${r.id}"`);
    seen.add(r.id);
    for (const a of r.aliases || []) {
      if (seen.has(a)) throw new Error(`routes.json: alias "${a}" collides (route ${r.id})`);
      seen.add(a);
    }
  }
  if (typeof data.defaultRoute !== 'string' || !data.routes.some((r) => r.id === data.defaultRoute)) {
    throw new Error('routes.json: "defaultRoute" must name an existing route id');
  }
  return data;
}

function index(data) {
  const byKey = new Map();
  for (const r of data.routes) {
    byKey.set(r.id, r);
    for (const a of r.aliases || []) byKey.set(a, r);
  }
  return byKey;
}

// Live route registry: loads + validates at construction (throws on bad
// boot config), hot-reloads on file change, keeps the last good config when
// an edit is invalid.
function createRouteRegistry(file, { logger = console, watch = true } = {}) {
  let data = validateRoutes(JSON.parse(fs.readFileSync(file, 'utf8')));
  let byKey = index(data);

  const reload = () => {
    try {
      const next = validateRoutes(JSON.parse(fs.readFileSync(file, 'utf8')));
      data = next;
      byKey = index(next);
      logger.log(`[routes] reloaded ${data.routes.length} routes from ${file}`);
      return true;
    } catch (err) {
      logger.error(`[routes] reload rejected, keeping previous config: ${err.message}`);
      return false;
    }
  };

  if (watch) {
    let timer = null;
    try {
      fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(reload, 300);
        timer.unref();
      });
    } catch (_) { /* watching is best-effort (e.g. some containers) */ }
  }

  // Admin mutation path: clone → mutate → validate → atomic write → apply.
  // Throws on invalid results; the file and live config stay untouched.
  const update = (mutate) => {
    const next = JSON.parse(JSON.stringify(data));
    mutate(next);
    validateRoutes(next);
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
    data = next;
    byKey = index(next);
    logger.log(`[routes] updated: ${next.routes.length} routes`);
    return next;
  };

  return {
    resolve(idOrAlias) {
      if (!idOrAlias || typeof idOrAlias !== 'string') return null;
      return byKey.get(idOrAlias) || null;
    },
    list() {
      return data.routes.slice();
    },
    defaultRoute() {
      return data.defaultRoute;
    },
    reload,
    update,
    file,
  };
}

module.exports = { createRouteRegistry, validateRoutes };
