const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

// Internal Real Groq Key (Render Environment Variable se uthayega)
const GROQ_KEY = process.env.GROQ_API_KEY;

// Aapki Exact Custom Secret Key
const OMNI_TURBO_SECRET_KEY = "omni_turbo_ai_ultimate303vHx77";

// Official OpenAI-Style Endpoint
app.post('/v1/chat/completions', async (req, res) => {
    const authHeader = req.headers.authorization;

    // Custom Key Validation Check
    if (!authHeader || authHeader !== `Bearer ${OMNI_TURBO_SECRET_KEY}`) {
        return res.status(401).json({
            error: {
                message: "Invalid or missing Custom API Key. Authorization header must be 'Bearer omni_turbo_ai_ultimate303vHx77'",
                type: "authentication_error"
            }
        });
    }

    const { messages, model } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Invalid format. 'messages' array is required." });
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model || "qwen/qwen3.8-27b",
                messages: messages,
                temperature: 0.7,
                max_tokens: 2048
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "Groq API Error");
        }

        // Exact OpenAI/Groq Compatible Response Format
        res.json(data);

    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// Root Health Check Route
app.get('/', (req, res) => {
    res.json({
        status: "active",
        service: "Omni Turbo AI Gateway",
        endpoint: "/v1/chat/completions"
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`⚡ Omni Turbo running on port ${PORT}`);
});
