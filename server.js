const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// ---------- Config ----------
// Internal Groq Key (Render Environment Variable)
const GROQ_KEY = process.env.GROQ_API_KEY;

// Custom Secret Key (set OMNI_TURBO_SECRET_KEY in Render env for better security;
// falls back to the existing key so nothing breaks)
const OMNI_TURBO_SECRET_KEY =
  process.env.OMNI_TURBO_SECRET_KEY || "omni_turbo_ai_ultimate303vHx77";

const PUBLIC_MODEL = "omni-turbo-0.2";
const UPSTREAM_MODEL = "qwen/qwen3.8-27b";
const UPSTREAM_URL = "https://api.groq.com/openai/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 120000;

// Advanced System Prompt for Tone, Reasoning, and Deep Thinking
const SYSTEM_PROMPT = {
  role: "system",
  content: "You are Omni Turbo 0.2, an advanced AI gateway. Maintain a natural human tone, break down complex topics into core concepts, apply deep reasoning and logic, and provide clean code and problem-solving solutions with easy understanding."
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

// Simple in-memory rate limiter (per IP, 60 requests / minute)
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

// Render sits behind a proxy
app.set('trust proxy', 1);

// ---------- OpenAI-Style Endpoint with Streaming ----------
app.post('/v1/chat/completions', rateLimit, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !safeEqual(authHeader, `Bearer ${OMNI_TURBO_SECRET_KEY}`)) {
    return res.status(401).json(errorBody("Invalid or missing Custom API Key.", "authentication_error"));
  }

  if (!GROQ_KEY) {
    return res.status(500).json(errorBody("Server is missing GROQ_API_KEY configuration."));
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

  // Prepend System Context for Advanced Capabilities
  const updatedMessages = [SYSTEM_PROMPT, ...messages];

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
    // Client disconnected mid-stream: stop upstream work
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

    // Handle Server-Sent Events (SSE) Streaming
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

        // Process only complete lines so the model name is never split across chunks
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          // Overwrite model identity in streaming chunks
          res.write(line.replace(MODEL_REGEX, PUBLIC_MODEL) + "\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) res.write(buffer.replace(MODEL_REGEX, PUBLIC_MODEL));
      return res.end();
    }

    // Standard Non-Streaming Response with Model Overwrite
    const data = await groqResponse.json();
    data.model = PUBLIC_MODEL;
    res.json(data);

  } catch (error) {
    const message = error.name === 'AbortError'
      ? "Upstream request timed out or was cancelled."
      : (error.message || "An error occurred while processing your request.");

    if (res.headersSent) {
      // Streaming already started: send an SSE error event and close
      res.write(`data: ${JSON.stringify(errorBody(message))}\n\n`);
      return res.end();
    }
    res.status(500).json(errorBody(message));
  } finally {
    clearTimeout(timeout);
  }
});

// OpenAI-compatible model list (helps clients like Postman / SDKs)
app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: [{ id: PUBLIC_MODEL, object: "model", owned_by: "omni-turbo" }]
  });
});

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({
    status: "active",
    service: "Omni Turbo 0.2 AI Engine",
    model: PUBLIC_MODEL
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json(errorBody("Route not found.", "not_found_error"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Omni Turbo running on port ${PORT}`);
});
