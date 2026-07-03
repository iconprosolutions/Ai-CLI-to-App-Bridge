'use strict';

const crypto = require('crypto');

// OpenAI ⇄ engine translation, carried over from the legacy provider with
// the Phase 0 fixes intact. Phase 3 hardens this layer (tool-call hold-back,
// response_format repair, SSE hygiene).

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(String(text).length / 4));
}

function formatContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image_url') return `[Image: ${item.image_url?.url || item.image_url}]`;
      }
      return JSON.stringify(item);
    }).join('\n');
  }
  return String(content);
}

function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
  const candidate = (match[1] || text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      return parsed.tool_calls.map((tc) => ({
        id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
        type: tc.type || 'function',
        function: {
          name: tc.function?.name || tc.name || 'unknown_tool',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      }));
    }
  } catch (_) { /* not a tool payload */ }
  return null;
}

function messagesToPrompt(messages, opts = {}) {
  const parts = [];
  if (opts.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
    // tool_choice steers how strongly the model is pushed toward a call:
    // auto = may call; required = must call; a named function = must call it.
    let choiceLine = 'If no tool call is needed, reply directly with plain text.';
    if (opts.toolChoice === 'required') {
      choiceLine = 'You MUST respond with a tool call — plain-text replies are not acceptable for this request.';
    }
    if (opts.forcedToolName) {
      choiceLine = `You MUST respond with a call to the tool "${opts.forcedToolName}" — no other tool and no plain-text reply is acceptable for this request.`;
    }
    parts.push(`[SYSTEM]\nYou have access to the following tools:\n${JSON.stringify(opts.tools, null, 2)}\n\nIf you decide to call a tool, respond ONLY with a JSON object inside a \`\`\`json\`\`\` code block matching this exact schema:\n{\n  "tool_calls": [\n    {\n      "id": "call_abc123",\n      "type": "function",\n      "function": {\n        "name": "tool_name",\n        "arguments": "{\\"arg\\": \\"val\\"}"\n      }\n    }\n  ]\n}\n\nComplete example — for a tool "get_weather" taking {"city": string}, a correct reply is EXACTLY:\n\`\`\`json\n{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Paris\\"}"}}]}\n\`\`\`\nCRITICAL: "arguments" MUST be a STRING containing escaped JSON (as shown), never a nested object. Do not add commentary before or after the code block.\n${choiceLine}`);
  } else if (opts.textOnlyTools) {
    parts.push('[SYSTEM]\nThe caller supplied tool/function metadata, but this bridge route is text-only. Do not emit tool calls. Answer directly from the conversation context.');
  }

  if (opts.responseFormat) {
    if (typeof opts.responseFormat === 'object' && opts.responseFormat.type === 'json_object') {
      parts.push('[SYSTEM]\nCRITICAL: You MUST output valid JSON only. Do not include introductory text or explanations outside JSON.');
    } else if (typeof opts.responseFormat === 'object' && opts.responseFormat.json_schema) {
      parts.push(`[SYSTEM]\nCRITICAL: You MUST output valid JSON strictly matching this schema:\n${JSON.stringify(opts.responseFormat.json_schema, null, 2)}`);
    }
  }

  for (const m of messages) {
    const roleStr = String(m.role || 'user').toUpperCase();
    let text = formatContent(m.content);
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      text += `\n[TOOL CALLS]\n${JSON.stringify(m.tool_calls, null, 2)}`;
    }
    if (m.role === 'tool') {
      text = `[TOOL RESULT for call_id=${m.tool_call_id || 'unknown'}]\n${text}`;
    }
    parts.push(`[${roleStr}]\n${text}`);
  }
  return parts.join('\n\n');
}

function openaiErrorBody(message, type, param) {
  return { error: { message, type, param: param === undefined ? null : param, code: null } };
}

module.exports = {
  estimateTokens,
  formatContent,
  parseToolCallsFromText,
  messagesToPrompt,
  openaiErrorBody,
};
