const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

// Aapki single Groq API key
const API_KEY = "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";
const MODEL_NAME = "llama-3.3-70b-versatile";

// Main API Endpoint jahan aapki apps requests bhejingi
app.post('/api/brain', async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Invalid format. 'messages' array is required." });
    }

    try {
        console.log("⚡ Omni Turbo processing request...");

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: messages,
                temperature: 0.7,
                max_tokens: 2048
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || "Groq API Error");
        }

        res.json({
            success: true,
            system: "Omni Turbo",
            response: data.choices[0].message
        });

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check route
app.get('/', (req, res) => {
    res.send("⚡ Omni Turbo Brain is online and ready!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`⚡ Omni Turbo running on port ${PORT}`);
});
