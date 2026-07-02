'use strict';

const { BridgeError } = require('./errors');

// Minimal, dependency-free JSON Schema checker covering the subset that
// OpenAI response_format json_schema users actually rely on: type, enum,
// required, properties, additionalProperties:false, items. Returns a list
// of human-readable problems (empty = valid).
function validateJsonSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null'
      : Array.isArray(value) ? 'array'
        : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number')
          : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      errors.push(`${path}: expected ${types.join('|')}, got ${actual}`);
      return errors; // type mismatch makes deeper checks noise
    }
  }

  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`);
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) errors.push(...validateJsonSchema(value[key], sub, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.properties)) errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateJsonSchema(item, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

function assertJsonSchema(value, schema) {
  const errors = validateJsonSchema(value, schema);
  if (errors.length) {
    throw new BridgeError('bad_output', `Schema validation failed: ${errors.slice(0, 3).join('; ')}`);
  }
}

module.exports = { validateJsonSchema, assertJsonSchema };
