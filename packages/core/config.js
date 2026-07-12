'use strict';

// Tiny env helpers — parse once at boot, never mid-request.
function intEnv(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] !== undefined ? n : def;
}

function strEnv(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function boolEnv(name, def = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

module.exports = { intEnv, strEnv, boolEnv };
