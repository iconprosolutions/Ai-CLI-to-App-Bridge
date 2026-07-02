'use strict';

const crypto = require('crypto');

// Bearer-token gate. Empty key = open (local dev only). publicPaths stay
// reachable for health checks. Constant-time compare avoids token-leak
// timing side channels.
function bearerAuth(apiKey, { publicPaths = ['/', '/health'] } = {}) {
  const publicSet = new Set(publicPaths);
  return (req, res, next) => {
    if (!apiKey) return next();
    if (publicSet.has(req.path)) return next();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}

module.exports = { bearerAuth };
