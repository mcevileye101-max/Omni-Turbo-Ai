const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Custom Security Token
const GATEWAY_TOKEN = "omni_turbo_ai_ultimate303vHx77";

// Token Verification
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${GATEWAY_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized Access' });
    }
    next();
};

// Root Health Check Route
app.get('/', (req, res) => {
    res.send('Omni Turbo Text AI Backend is Active!');
});

// Chat API Route
app.post('/api/chat', verifyToken, async (req, res) => {
    try {
        const { message } = req.body;
        const groqApiKey = process.env.GROQ_API_KEY;

        if (!groqApiKey) {
            return res.status(500).json({ error: 'GROQ_API_KEY Missing on Server' });
        }

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${groqApiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: message }]
            })
        });

        const data = await response.json();

        if (data.choices && data.choices[0]?.message?.content) {
            res.json({ reply: data.choices[0].message.content });
        } else {
            res.status(500).json({ error: 'Invalid response from Groq API' });
        }

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
