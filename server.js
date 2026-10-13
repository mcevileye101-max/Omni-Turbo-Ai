const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// ---------- Configuration & Keys ----------
const GROQ_KEY = process.env.GROQ_API_KEY;
// Set this ONLY in Render Environment Variables (never hardcode it in code)
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

const OMNI_TURBO_SECRET_KEY =
  process.env.OMNI_TURBO_SECRET_KEY || "omni_turbo_ai_ultimate303vHx77";

const PUBLIC_MODEL = "omni-turbo-0.2";
const UPSTREAM_MODEL = "qwen/qwen3.8-27b";
const UPSTREAM_URL = "https://api.groq.com/openai/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 120000;

// Image provider (Pollinations unified API)
const POLLINATIONS_BASE = "https://gen.pollinations.ai";
const IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";
const IMAGE_TIMEOUT_MS = 90000;
const MAX_IMAGE_PROMPT_CHARS = 1000;

const SYSTEM_PROMPT = {
  role: "system",
  content: "You are Omni Turbo 0.2, an advanced AI gateway. Maintain a natural human tone, break down complex topics into core concepts, apply deep reasoning and logic, and provide clean code and problem-solving solutions."
};

// ---------- Helpers ----------
const MODEL_REGEX = /qwen\/qwen3\.8-27b/g;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function errorBody(message, type = "server_error") {
  return { error: { message, type } };
}

function isAuthorized(req) {
  const authHeader = req.headers.authorization;
  return Boolean(authHeader) && safeEqual(authHeader, `Bearer ${OMNI_TURBO_SECRET_KEY}`);
}

// Rate Limiter
const hits = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  hits.set(ip, entry);
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json(errorBody("Too many requests. Please slow down.", "rate_limit_error"));
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start > RATE_WINDOW_MS) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

app.set('trust proxy', 1);

// ---------- Image Generation ----------
// Server fetches the image itself (key stays private) and returns base64.
async function generateImage(prompt, { width = 1024, height = 1024 } = {}) {
  if (!POLLINATIONS_API_KEY) {
    throw new Error("Server is missing POLLINATIONS_API_KEY configuration.");
  }

  const seed = Math.floor(Math.random() * 1000000);
  const url =
    `${POLLINATIONS_BASE}/image/${encodeURIComponent(prompt.slice(0, MAX_IMAGE_PROMPT_CHARS))}` +
    `?model=${encodeURIComponent(IMAGE_MODEL)}&width=${width}&height=${height}&seed=${seed}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${POLLINATIONS_API_KEY}` },
      signal: controller.signal
    });

    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !type.startsWith('image/')) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 300); } catch (_) {}
      throw new Error(`Image provider error (${r.status}): ${detail || 'no details'}`);
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return { mime: type, b64: buf.toString('base64') };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error("Image generation timed out. Please try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// "generate image of a cat", "generate an image a cat", "create image of ...", "image of ...", "draw ..."
const IMAGE_TRIGGER = /^\s*(?:(?:generate|create|make)\s+(?:an?\s+)?image(?:\s+of)?|image\s+of|draw)\s+/i;

function extractPromptText(messages) {
  const lastUserMsg = messages.slice().reverse().find(m => m && m.role === 'user');
  if (!lastUserMsg) return "";
  if (typeof lastUserMsg.content === 'string') return lastUserMsg.content;
  if (Array.isArray(lastUserMsg.content)) {
    const textPart = lastUserMsg.content.find(c => c && c.type === 'text');
    return textPart ? textPart.text || "" : "";
  }
  return "";
}

// Generated images live in chat history as base64. Strip them before sending
// history to Groq so the text model doesn't choke on huge payloads.
const DATA_IMAGE_REGEX = /!\[[^\]]*\]\(data:image\/[^)]+\)/g;
function stripImagesFromHistory(messages) {
  return messages.map(m => {
    if (!m) return m;
    if (typeof m.content === 'string') {
      return { ...m, content: m.content.replace(DATA_IMAGE_REGEX, "[generated image]") };
    }
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(part =>
          part && part.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: part.text.replace(DATA_IMAGE_REGEX, "[generated image]") }
            : part
        )
      };
    }
    return m;
  });
}

function sendChatReply(res, content, stream) {
  const id = "chatcmpl-" + crypto.randomBytes(4).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const base = { id, object: "chat.completion.chunk", created, model: PUBLIC_MODEL };
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  return res.json({
    id,
    object: "chat.completion",
    created,
    model: PUBLIC_MODEL,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop"
    }]
  });
}

// ---------- Multi-Model Chat & Image Gateway Endpoint ----------
app.post('/v1/chat/completions', rateLimit, async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json(errorBody("Invalid or missing Custom API Key.", "authentication_error"));
  }

  const {
    messages,
    stream = false,
    temperature = 0.7,
    max_tokens,
    top_p,
    stop
  } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json(errorBody("Invalid format. 'messages' array is required.", "invalid_request_error"));
  }

  // ----- Image branch -----
  const promptText = extractPromptText(messages);
  if (IMAGE_TRIGGER.test(promptText)) {
    const cleanPrompt = promptText.replace(IMAGE_TRIGGER, "").trim();
    if (!cleanPrompt) {
      return res.status(400).json(errorBody("Please describe the image you want.", "invalid_request_error"));
    }
    try {
      const { mime, b64 } = await generateImage(cleanPrompt);
      const content = `Ye lijiye aapki image:\n\n![Generated Image](data:${mime};base64,${b64})`;
      return sendChatReply(res, content, Boolean(stream));
    } catch (err) {
      return res.status(500).json(errorBody("Image generation error: " + err.message));
    }
  }

  // ----- Text branch (Groq & Qwen) -----
  if (!GROQ_KEY) {
    return res.status(500).json(errorBody("Server is missing GROQ_API_KEY configuration."));
  }

  const updatedMessages = [SYSTEM_PROMPT, ...stripImagesFromHistory(messages)];

  const payload = {
    model: UPSTREAM_MODEL,
    messages: updatedMessages,
    temperature,
    stream: Boolean(stream)
  };
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  if (top_p !== undefined) payload.top_p = top_p;
  if (stop !== undefined) payload.stop = stop;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const groqResponse = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!groqResponse.ok) {
      let errData = {};
      try { errData = await groqResponse.json(); } catch (_) {}
      throw new Error(errData.error?.message || "Internal Engine Error");
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const reader = groqResponse.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          res.write(line.replace(MODEL_REGEX, PUBLIC_MODEL) + "\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) res.write(buffer.replace(MODEL_REGEX, PUBLIC_MODEL));
      return res.end();
    }

    const data = await groqResponse.json();
    data.model = PUBLIC_MODEL;
    res.json(data);

  } catch (error) {
    const message = error.name === 'AbortError'
      ? "Upstream request timed out or was cancelled."
      : (error.message || "An error occurred while processing your request.");

    if (res.headersSent) {
      res.write(`data: ${JSON.stringify(errorBody(message))}\n\n`);
      return res.end();
    }
    res.status(500).json(errorBody(message));
  } finally {
    clearTimeout(timeout);
  }
});

// ---------- OpenAI-compatible Image Endpoint ----------
// POST /v1/images/generations  { "prompt": "a red fox", "size": "1024x1024" }
app.post('/v1/images/generations', rateLimit, async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json(errorBody("Invalid or missing Custom API Key.", "authentication_error"));
  }

  const { prompt, size = "1024x1024" } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json(errorBody("'prompt' is required.", "invalid_request_error"));
  }

  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  const width = m ? Math.min(parseInt(m[1], 10), 2048) : 1024;
  const height = m ? Math.min(parseInt(m[2], 10), 2048) : 1024;

  try {
    const { b64 } = await generateImage(prompt.trim(), { width, height });
    res.json({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: b64 }] });
  } catch (err) {
    res.status(500).json(errorBody("Image generation error: " + err.message));
  }
});

// Models List Endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: [{ id: PUBLIC_MODEL, object: "model", owned_by: "omni-turbo" }]
  });
});

app.get('/', (req, res) => {
  res.json({
    status: "active",
    service: "Omni Turbo 0.2 Multi-Modal Engine",
    model: PUBLIC_MODEL,
    image: Boolean(POLLINATIONS_API_KEY)
  });
});

app.use((req, res) => {
  res.status(404).json(errorBody("Route not found.", "not_found_error"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Omni Turbo running on port ${PORT}`);
});
