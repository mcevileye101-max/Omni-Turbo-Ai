const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

// Internal Groq Key (Render Environment Variable)
const GROQ_KEY = process.env.GROQ_API_KEY;

// Custom Key Validation
const OMNI_TURBO_SECRET_KEY = "omni_turbo_ai_ultimate303vHx77";

// OpenAI-Style Endpoint
app.post('/v1/chat/completions', async (req, res) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || authHeader !== `Bearer ${OMNI_TURBO_SECRET_KEY}`) {
        return res.status(401).json({
            error: {
                message: "Invalid or missing Custom API Key.",
                type: "authentication_error"
            }
        });
    }

    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Invalid format. 'messages' array is required." });
    }

    try {
        // Backend internal request to Groq using Qwen
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "qwen/qwen3.8-27b",
                messages: messages,
                temperature: 0.7
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "Internal Engine Error");
        }

        // Overwrite the model name in response to show YOUR custom brand
        data.model = "omni-turbo-0.2";

        res.json(data);

    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

app.get('/', (req, res) => {
    res.json({
        status: "active",
        service: "Omni Turbo 0.2 AI Engine",
        model: "omni-turbo-0.2"
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`⚡ Omni Turbo running on port ${PORT}`);
});
