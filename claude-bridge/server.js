const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 9002;
const CONTEXTS_DIR = process.env.CONTEXTS_DIR || path.join(__dirname, 'contexts');
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || null;
const AGENCY_NAME = process.env.AGENCY_NAME || 'Your Agency';
const TEAM_MEMBERS = process.env.TEAM_MEMBERS || 'Team Member or Client';

const KNOWN_MODELS = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Current recommended Claude Code default for most work.',
    contextWindow: 200000,
    isFree: false,
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    description: 'Balanced Claude model with strong reasoning and speed.',
    contextWindow: 200000,
    isFree: false,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    description: 'Fast Claude model for quick responses and lightweight tasks.',
    contextWindow: 200000,
    isFree: false,
  },
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    description: 'Highest-capability Claude model available in this bridge.',
    contextWindow: 200000,
    isFree: false,
  },
  {
    id: 'claude-opus-4-1',
    name: 'Claude Opus 4.1',
    description: 'Previous Opus generation still available in Claude Code.',
    contextWindow: 200000,
    isFree: false,
  },
];

const MODEL_ALIASES = {
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
};

function normalizeModel(model) {
  if (!model || model === 'default') return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

function summarizeClaudeError(stderr, selectedModel) {
  const text = String(stderr || '');

  if (text.includes('deprecated and will reach end-of-life')) {
    return `The Claude model "${selectedModel}" is deprecated in Claude Code. Try Claude Sonnet 4.6, Claude Sonnet 4.5, or Claude Haiku 4.5.`;
  }

  if (text.includes("There's an issue with the selected model")) {
    return `The Claude model "${selectedModel}" is not available in this Claude Code install. Try Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5, or Claude Opus 4.1.`;
  }

  return text.trim() || `Claude request failed for model "${selectedModel || 'default'}".`;
}

// ─────────────────────────────────────────────
// In-memory session tracker
// ─────────────────────────────────────────────

const activeSessions = new Map();

function getSession(clientSlug) {
  return activeSessions.get(clientSlug) || null;
}

function createSession(clientSlug) {
  const sessionId = `ops-${clientSlug}-${Date.now()}`;
  const session = {
    sessionId,
    clientSlug,
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
// Claude Code CLI execution
// ─────────────────────────────────────────────

function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const selectedModel = normalizeModel(model);

    // -p: print mode (non-interactive); --model: select specific model
    const args = ['-p', prompt];
    if (selectedModel) {
      args.push('--model', selectedModel);
    }

    const child = spawn(claudePath, args, {
      cwd: __dirname,
      env: { ...process.env, HOME: process.env.HOME },
      timeout: 5 * 60 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin so CLI doesn't wait for it
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(summarizeClaudeError(stderr, selectedModel)));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude: ${err.message}`));
    });
  });
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

Respond with ONLY valid JSON:
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

// Available models
app.get('/models', (req, res) => {
  res.json(KNOWN_MODELS);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'claude-cli',
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
// Simple chat endpoint
// ─────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { task = 'chat', clientSlug = 'playground', model, prompt, content } = req.body;
  const input = prompt || content || '';

  if (!input.trim()) {
    return res.status(400).json({ error: 'Missing prompt or content' });
  }

  try {
    let session = getSession(clientSlug);
    if (!session) {
      session = createSession(clientSlug);
    } else {
      touchSession(clientSlug);
    }

    const fullPrompt = buildPrompt(task === 'chat' ? 'raw' : task, clientSlug, { prompt: input, content: input });
    const raw = await runClaude(fullPrompt, model);
    touchSession(clientSlug);

    res.json({ success: true, text: raw, tokenCount: 0, model: model || 'default' });
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
    return res.status(400).json({ error: 'Missing required fields: task, clientSlug' });
  }

  console.log(`[${new Date().toISOString()}] Processing: task=${task}, client=${clientSlug}, model=${model || 'default'}`);

  try {
    let session = getSession(clientSlug);
    if (!session) {
      session = createSession(clientSlug);
      console.log(`  New session: ${session.sessionId}`);
    } else {
      console.log(`  Resuming session: ${session.sessionId}`);
    }

    const prompt = buildPrompt(task, clientSlug, data || {});
    const rawResponse = await runClaude(prompt, model);
    touchSession(clientSlug);

    let parsed = null;
    if (['meeting_analysis', 'email_draft'].includes(task)) {
      try {
        const cleaned = rawResponse
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('  Failed to parse JSON response, returning raw text');
      }
    }

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
      model: model || 'default',
      result: parsed || rawResponse,
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
      console.log(`[Cleanup] Closing idle session: ${session.sessionId} (${slug}, idle ${Math.round(idleMs / 3600000)}h)`);
      removeSession(slug);
    }
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude CLI Bridge running on port ${PORT}`);
  console.log(`Agency: ${AGENCY_NAME}`);
  console.log(`Contexts directory: ${CONTEXTS_DIR}`);
  console.log(`Session timeout: ${SESSION_TIMEOUT_MS / 3600000}h`);

  try {
    const version = execSync('claude --version 2>&1').toString().trim();
    console.log(`Claude CLI: ${version}`);
  } catch (err) {
    console.warn('WARNING: Could not detect Claude CLI. Make sure "claude" is in PATH or CLAUDE_PATH is set.');
  }
});
