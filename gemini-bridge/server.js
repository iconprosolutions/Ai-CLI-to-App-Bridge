const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 9003;
const CONTEXTS_DIR = process.env.CONTEXTS_DIR || path.join(__dirname, 'contexts');
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const AGENCY_NAME = process.env.AGENCY_NAME || 'Your Agency';
const TEAM_MEMBERS = process.env.TEAM_MEMBERS || 'Team Member or Client';

// Gemini CLI config
const GEMINI_PATH = process.env.GEMINI_PATH || 'gemini';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// All Gemini models that may exist across accounts — the probe will filter to only available ones.
const CANDIDATE_MODELS = [
  { id: 'gemini-3.1-pro-preview',  name: 'Gemini 3.1 Pro Preview',  description: 'Most capable Gemini 3.1 model. Requires higher quota.', contextWindow: 1000000, isFree: false },
  { id: 'gemini-3-flash-preview',  name: 'Gemini 3 Flash Preview',  description: 'Recommended free model — the Gemini CLI default.', contextWindow: 1000000, isFree: true },
  { id: 'gemini-2.5-pro',         name: 'Gemini 2.5 Pro',          description: 'High-capability Gemini 2.5 model. Requires higher quota.', contextWindow: 1000000, isFree: false },
  { id: 'gemini-2.5-flash',       name: 'Gemini 2.5 Flash',        description: 'Fast and capable Gemini 2.5 model. Free tier available.', contextWindow: 1000000, isFree: true },
  { id: 'gemini-2.5-flash-lite',  name: 'Gemini 2.5 Flash Lite',   description: 'Lightest Gemini 2.5 model. Lowest quota usage.', contextWindow: 1000000, isFree: true },
];

// ─────────────────────────────────────────────
// Dynamic model discovery
// Probes the Gemini CLI to find which models are actually available
// for the current account. Results are cached for PROBE_CACHE_MS.
// ─────────────────────────────────────────────

const PROBE_CACHE_MS = 60 * 60 * 1000; // re-probe at most once per hour
let modelCache = null;      // null = never probed
let probeLastRan = 0;
let probeRunning = false;

async function probeOneModel(candidate) {
  try {
    await runGemini('Reply with just the word OK.', candidate.id);
    return { ...candidate, _status: 'ok' };
  } catch (err) {
    const msg = String(err.message || '');
    // Quota-exceeded models still exist — include them so users can see them
    if (msg.includes('quota exceeded') || msg.includes('temporarily unavailable') || msg.includes('exhausted')) {
      return { ...candidate, _status: 'quota' };
    }
    // "not available" / "not found" → genuinely absent from this account
    return null;
  }
}

async function probeAllModels() {
  if (probeRunning) return;
  probeRunning = true;
  console.log('[Models] Probing available models for this account…');
  const results = await Promise.all(CANDIDATE_MODELS.map(probeOneModel));
  modelCache = results.filter(Boolean).map(({ _status, ...m }) => m);
  probeLastRan = Date.now();
  probeRunning = false;
  console.log(`[Models] Available: ${modelCache.map(m => m.id).join(', ')}`);
}

const MODEL_ALIASES = {
  'gemini-1.5-pro': 'gemini-2.5-flash',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash-thinking-exp': 'gemini-2.5-flash',
  'gemini-2.5-flash-8b': 'gemini-2.5-flash',
};

function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

function summarizeGeminiError(stderr, selectedModel) {
  const text = String(stderr || '');

  if (text.includes('Requested entity was not found')) {
    return `The Gemini model "${selectedModel}" is not available in this CLI session. Try Gemini 3 Flash Preview or Gemini 2.5 Flash.`;
  }

  if (text.includes('You have exhausted your capacity on this model')) {
    return `The Gemini model "${selectedModel}" is temporarily unavailable for this account quota. Try Gemini 3 Flash Preview or Gemini 2.5 Flash.`;
  }

  const usefulLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('YOLO mode is enabled'))
    .filter((line) => !line.startsWith('Keychain initialization encountered'))
    .filter((line) => !line.startsWith('Require stack:'))
    .filter((line) => !line.startsWith('- /opt/homebrew'))
    .filter((line) => !line.startsWith('Using FileKeychain fallback'))
    .filter((line) => !line.startsWith('Loaded cached credentials.'))
    .filter((line) => !line.startsWith('Error when talking to Gemini API'))
    .filter((line) => !line.startsWith('Full report available at:'))
    .filter((line) => !line.startsWith('at '))
    .filter((line) => line !== 'An unexpected critical error occurred:[object Object]');

  return usefulLines[usefulLines.length - 1] || `Gemini request failed for model "${selectedModel}".`;
}

// ─────────────────────────────────────────────
// In-memory session tracker
// ─────────────────────────────────────────────

const activeSessions = new Map();

function getSession(clientSlug) {
  return activeSessions.get(clientSlug) || null;
}

function createSession(clientSlug, model) {
  const sessionId = `gem-${clientSlug}-${Date.now()}`;
  const session = {
    sessionId,
    clientSlug,
    model: model || DEFAULT_MODEL,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    taskCount: 0,
  };
  activeSessions.set(clientSlug, session);
  return session;
}

function touchSession(clientSlug) {
  const session = activeSessions.get(clientSlug);
  if (session) {
    session.lastActivity = Date.now();
    session.taskCount += 1;
  }
}

function removeSession(clientSlug) {
  activeSessions.delete(clientSlug);
}

// ─────────────────────────────────────────────
// Context file management
// ─────────────────────────────────────────────

function getContextPath(type, slug) {
  if (type === 'global') {
    return path.join(CONTEXTS_DIR, 'global', 'agency-context.md');
  }
  return path.join(CONTEXTS_DIR, type, `${slug}.md`);
}

function readContext(type, slug) {
  const filePath = getContextPath(type, slug);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

function writeContext(type, slug, content) {
  const filePath = getContextPath(type, slug);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendToContext(type, slug, section) {
  const existing = readContext(type, slug) || '';
  const timestamp = new Date().toISOString().split('T')[0];
  const newContent = existing + `\n\n---\n## Update: ${timestamp}\n\n${section}`;
  writeContext(type, slug, newContent);
}

// ─────────────────────────────────────────────
// Gemini CLI execution
// ─────────────────────────────────────────────

function runGemini(prompt, model) {
  return new Promise((resolve, reject) => {
    const selectedModel = normalizeModel(model);

    // -p: non-interactive (headless) mode
    // -y: auto-accept all actions (YOLO) — needed for unattended runs
    // -m: model selection
    const args = ['-p', prompt, '-y', '-m', selectedModel];

    const child = spawn(GEMINI_PATH, args, {
      cwd: __dirname,
      env: { ...process.env, HOME: process.env.HOME },
      timeout: 5 * 60 * 1000, // 5 minute timeout
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin so CLI doesn't wait for it
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(msg));
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Fail immediately on known terminal errors instead of waiting for CLI retries
      if (stderr.includes('You have exhausted your capacity on this model')) {
        fail(`The Gemini model "${selectedModel}" is temporarily unavailable — quota exceeded. Try again later or use Gemini 2.5 Flash.`);
      }
      if (stderr.includes('Requested entity was not found')) {
        fail(`The Gemini model "${selectedModel}" is not available in this CLI session.`);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(summarizeGeminiError(stderr, selectedModel)));
      }
    });

    child.on('error', (err) => {
      fail(`Failed to spawn Gemini: ${err.message}`);
    });
  });
}

// ─────────────────────────────────────────────
// Strip ANSI escape codes from Gemini CLI output
// Gemini CLI sometimes emits colour codes even in headless mode
// ─────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

// ─────────────────────────────────────────────
// Extract clean JSON from a response that may
// contain preamble, markdown fences, or trailing text
// ─────────────────────────────────────────────

function extractJson(raw) {
  // 1. Strip ANSI
  let text = stripAnsi(raw).trim();

  // 2. Remove markdown fences: ```json ... ``` or ``` ... ```
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  // 3. Try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) {
    // 4. Find first { or [ and last } or ] — handles preamble/postamble
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;
    if (firstBrace !== -1 && firstBracket !== -1) {
      start = Math.min(firstBrace, firstBracket);
    } else {
      start = firstBrace !== -1 ? firstBrace : firstBracket;
    }

    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);

    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (__) {
        // fall through
      }
    }

    throw new Error('Could not extract valid JSON from Gemini response');
  }
}

// ─────────────────────────────────────────────
// Build the analysis prompt with context
// ─────────────────────────────────────────────

function buildPrompt(task, clientSlug, data) {
  const clientContext = readContext('clients', clientSlug);
  const agencyContext = readContext('global', 'agency-context');

  let contextBlock = '';

  if (agencyContext) {
    contextBlock += `<agency_context>\n${agencyContext}\n</agency_context>\n\n`;
  }

  if (clientContext) {
    contextBlock += `<client_context>\n${clientContext}\n</client_context>\n\n`;
  }

  if (task === 'meeting_analysis') {
    return `${contextBlock}
You are an operations analyst for ${AGENCY_NAME}. Analyze the following meeting transcript and return a structured JSON response.

<meeting_info>
Title: ${data.title || 'Untitled Meeting'}
Client: ${data.clientName || 'Unknown'}
Date: ${data.date || 'Unknown'}
Platform: ${data.platform || 'Unknown'}
Type: ${data.meetingType || 'Unknown'}
</meeting_info>

<transcript>
${data.transcript}
</transcript>

Respond with ONLY valid JSON (no markdown fences, no preamble) in this exact structure:
{
  "summary": "2-3 paragraph meeting summary in markdown",
  "actionItems": [
    {
      "description": "what needs to be done",
      "assignee": "${TEAM_MEMBERS}",
      "dueDate": "YYYY-MM-DD or null if unclear",
      "priority": "high or medium or low"
    }
  ],
  "crmSuggestions": [
    {
      "field": "field name in your CRM",
      "currentValue": "what we have now or null",
      "suggestedValue": "what it should be",
      "reason": "why this change"
    }
  ],
  "clientIntelligence": "markdown block with insights about the client: communication style, preferences, concerns, project sentiment, relationship notes",
  "suggestedTags": ["relevant", "meeting", "tags"]
}`;
  }

  if (task === 'client_briefing') {
    return `${contextBlock}
You are preparing a briefing for an upcoming meeting with this client. Based on all available context, provide a concise briefing that covers:
1. Client background and relationship summary
2. Current project status and recent activity
3. Open action items or pending decisions
4. Communication style notes
5. Suggested talking points for the meeting

Meeting details:
Title: ${data.title || 'Unknown'}
Date: ${data.date || 'Unknown'}
Type: ${data.meetingType || 'Unknown'}

Respond in clear, concise markdown. No JSON needed.`;
  }

  if (task === 'email_draft') {
    return `${contextBlock}
Draft an email to this client based on the following instructions. Match the client's preferred communication style based on the context provided.

Instructions: ${data.instructions}
Subject context: ${data.subject || ''}
Tone: ${data.tone || 'professional but warm'}

Respond with ONLY valid JSON (no markdown, no preamble):
{
  "subject": "email subject line",
  "body": "email body in plain text",
  "bodyHtml": "email body in simple HTML"
}`;
  }

  if (task === 'quick_summary') {
    return `${contextBlock}
Summarize the following content in 2-3 sentences. Be concise and focus on actionable information.

<content>
${data.content}
</content>

Respond with plain text only. No JSON, no markdown formatting.`;
  }

  // Default: pass through raw prompt
  return `${contextBlock}\n\n${data.prompt || data.content || 'No input provided.'}`;
}

// ─────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────

// Available models — dynamically discovered for the current Gemini account.
// First call returns all candidates while a background probe runs.
// Subsequent calls within PROBE_CACHE_MS return the probed (accurate) list.
// Pass ?refresh=true to force a fresh probe.
app.get('/models', (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  // Always kick off a background probe if stale or force-refresh requested.
  // Never block the response waiting for it — the probe can take minutes.
  if (forceRefresh || (!modelCache && !probeRunning)) {
    if (forceRefresh) probeRunning = false; // allow restart
    probeAllModels().catch(console.error);
  }

  // Return cached probed list if available, otherwise full candidate list.
  const cacheValid = modelCache && (Date.now() - probeLastRan) < PROBE_CACHE_MS;
  res.json(cacheValid ? modelCache : CANDIDATE_MODELS.map(({ ...m }) => m));
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'gemini-cli',
    defaultModel: DEFAULT_MODEL,
    uptime: process.uptime(),
    activeSessions: activeSessions.size,
    contextsDir: CONTEXTS_DIR,
  });
});

// List active sessions
app.get('/api/sessions', (req, res) => {
  const sessions = [];
  for (const [slug, session] of activeSessions) {
    sessions.push({
      ...session,
      idleMinutes: Math.round((Date.now() - session.lastActivity) / 60000),
    });
  }
  res.json({ sessions });
});

app.get('/api/sessions/:clientSlug', (req, res) => {
  const session = getSession(req.params.clientSlug);
  if (!session) {
    return res.json({ active: false, clientSlug: req.params.clientSlug });
  }
  res.json({
    active: true,
    ...session,
    idleMinutes: Math.round((Date.now() - session.lastActivity) / 60000),
  });
});

app.delete('/api/sessions/:clientSlug', (req, res) => {
  const session = getSession(req.params.clientSlug);
  if (!session) {
    return res.status(404).json({ error: 'No active session for this client' });
  }
  removeSession(req.params.clientSlug);
  res.json({ closed: true, sessionId: session.sessionId });
});

// ─────────────────────────────────────────────
// Simple chat endpoint (playground / quick use)
// ─────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const {
    task = 'chat',
    clientSlug = 'playground',
    model,
    prompt,
    content,
  } = req.body;

  const input = prompt || content || '';
  if (!input.trim()) {
    return res.status(400).json({ error: 'Missing prompt or content' });
  }

  try {
    let session = getSession(clientSlug);
    if (!session) {
      session = createSession(clientSlug, model);
    } else {
      touchSession(clientSlug);
    }

    const fullPrompt = buildPrompt(task === 'chat' ? 'raw' : task, clientSlug, { prompt: input, content: input });
    const resolvedModel = normalizeModel(model || session.model);
    const raw = await runGemini(fullPrompt, resolvedModel);
    touchSession(clientSlug);

    res.json({ success: true, text: stripAnsi(raw), model: resolvedModel });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Main processing endpoint
// ─────────────────────────────────────────────

app.post('/api/process', async (req, res) => {
  const { task, clientSlug, data, model } = req.body;

  if (!task || !clientSlug) {
    return res.status(400).json({
      error: 'Missing required fields: task, clientSlug',
    });
  }

  const selectedModel = normalizeModel(model);
  console.log(`[${new Date().toISOString()}] task=${task} client=${clientSlug} model=${selectedModel}`);

  try {
    let session = getSession(clientSlug);
    if (!session) {
      session = createSession(clientSlug, selectedModel);
      console.log(`  New session: ${session.sessionId}`);
    } else {
      console.log(`  Resuming session: ${session.sessionId}`);
    }

    const prompt = buildPrompt(task, clientSlug, data || {});
    const rawResponse = await runGemini(prompt, selectedModel);
    touchSession(clientSlug);

    // Parse JSON for structured tasks
    let parsed = null;
    if (['meeting_analysis', 'email_draft'].includes(task)) {
      try {
        parsed = extractJson(rawResponse);
      } catch (parseErr) {
        console.warn(`  JSON parse failed: ${parseErr.message}`);
      }
    }

    // Auto-append meeting intelligence to context file
    if (task === 'meeting_analysis' && parsed?.clientIntelligence) {
      const meetingDate = data?.date || new Date().toISOString().split('T')[0];
      const meetingTitle = data?.title || 'Untitled Meeting';
      const section = `### Meeting: ${meetingTitle} (${meetingDate})\n\n**Summary:** ${parsed.summary?.substring(0, 200)}...\n\n**Intelligence:**\n${parsed.clientIntelligence}`;
      appendToContext('clients', clientSlug, section);
      console.log(`  Appended intelligence to contexts/clients/${clientSlug}.md`);
    }

    res.json({
      success: true,
      sessionId: session.sessionId,
      taskCount: session.taskCount,
      model: selectedModel,
      result: parsed || stripAnsi(rawResponse),
      raw: parsed ? rawResponse : undefined,
    });
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Context file CRUD
// ─────────────────────────────────────────────

app.get('/api/contexts/:type/:slug', (req, res) => {
  const { type, slug } = req.params;
  if (!['clients', 'projects', 'global'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type. Use: clients, projects, global' });
  }
  const content = readContext(type, type === 'global' ? null : slug);
  if (content === null) {
    return res.status(404).json({ error: 'Context file not found' });
  }
  res.json({ type, slug, content });
});

app.put('/api/contexts/:type/:slug', (req, res) => {
  const { type, slug } = req.params;
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Missing content in request body' });
  }
  writeContext(type, type === 'global' ? null : slug, content);
  res.json({ success: true, type, slug });
});

app.post('/api/contexts/:type/:slug/append', (req, res) => {
  const { type, slug } = req.params;
  const { section } = req.body;
  if (!section) {
    return res.status(400).json({ error: 'Missing section in request body' });
  }
  appendToContext(type, type === 'global' ? null : slug, section);
  res.json({ success: true, type, slug });
});

app.get('/api/contexts/:type', (req, res) => {
  const { type } = req.params;
  const dir = type === 'global'
    ? path.join(CONTEXTS_DIR, 'global')
    : path.join(CONTEXTS_DIR, type);

  if (!fs.existsSync(dir)) {
    return res.json({ type, files: [] });
  }

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const filePath = path.join(dir, f);
      const stats = fs.statSync(filePath);
      return {
        slug: f.replace('.md', ''),
        filename: f,
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
      };
    });

  res.json({ type, files });
});

// ─────────────────────────────────────────────
// Session cleanup (runs every hour)
// ─────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [slug, session] of activeSessions) {
    const idleMs = now - session.lastActivity;
    if (idleMs > SESSION_TIMEOUT_MS) {
      console.log(`[Cleanup] Closing idle session: ${session.sessionId} (idle ${Math.round(idleMs / 3600000)}h)`);
      removeSession(slug);
    }
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gemini CLI Bridge running on port ${PORT}`);
  console.log(`Agency: ${AGENCY_NAME}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Contexts directory: ${CONTEXTS_DIR}`);
  console.log(`Session timeout: ${SESSION_TIMEOUT_MS / 3600000}h`);

  try {
    const version = execSync(`${GEMINI_PATH} --version 2>&1`).toString().trim();
    console.log(`Gemini CLI: ${version}`);
  } catch (_) {
    console.warn('WARNING: Could not detect Gemini CLI. Make sure "gemini" is in PATH or GEMINI_PATH is set.');
  }
});
