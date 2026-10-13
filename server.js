const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

// ---------- Config ----------
const GROQ_KEY = process.env.GROQ_API_KEY;
// Aapki Pollinations Secret Key image generation ke liye
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || "sk_yYtT2910mwEF96lkP6WcrLNbg693pogo";

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

app.set('trust proxy', 1);

// ---------- Multi-Model Endpoint (Text & Image Generation) ----------
app.post('/v1/chat/completions', rateLimit, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !safeEqual(authHeader, `Bearer ${OMNI_TURBO_SECRET_KEY}`)) {
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

  // Check if user is asking for image generation (e.g., "generate image of...")
  const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
  let promptText = "";
  if (lastUserMsg) {
    if (typeof lastUserMsg.content === 'string') {
      promptText = lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      const textPart = lastUserMsg.content.find(c => c.type === 'text');
      if (textPart) promptText = textPart.text;
    }
  }

  // Agar user image generate karne ko bole, toh Pollinations FLUX model par route karo
  const isImageRequest = promptText.toLowerCase().startsWith("generate image") || 
                         promptText.toLowerCase().startsWith("image of") ||
                         promptText.toLowerCase().startsWith("draw ");

  if (isImageRequest) {
    try {
      const cleanPrompt = promptText.replace(/^(generate image of|image of|draw)\s*/i, "");
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?model=flux&nologo=true`;
      
      // Return OpenAI compatible chat response with image markdown inside it
      const imageMarkdownResponse = {
        id: "chatcmpl-" + crypto.randomBytes(4).toString('hex'),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: PUBLIC_MODEL,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: `Ye lijiye aapki image:\n\n![Generated Image](${imageUrl})`
          },
          finish_reason: "stop"
        }]
      };
      return res.json(imageMarkdownResponse);
    } catch (err) {
      return res.status(500).json(errorBody("Image generation failed: " + err.message));
    }
  }

  // Standard Text Handling via Groq & Qwen
  if (!GROQ_KEY) {
    return res.status(500).json(errorBody("Server is missing GROQ_API_KEY configuration."));
  }

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
    model: PUBLIC_MODEL
  });
});

app.use((req, res) => {
  res.status(404).json(errorBody("Route not found.", "not_found_error"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Omni Turbo running on port ${PORT}`);
});
                         
