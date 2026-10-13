const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Aapka Custom Gateway Token
const GATEWAY_TOKEN = "omni_turbo_ai_ultimate303vHx77";

// Auth Middleware jo token check karega
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${GATEWAY_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Gateway Token' });
    }
    next();
};

// 1. Chat Endpoint (/api/chat)
app.post('/api/chat', verifyToken, async (req, res) => {
    try {
        const { message } = req.body;
        const groqApiKey = process.env.GROQ_API_KEY;

        if (!groqApiKey) {
            return res.status(500).json({ error: 'GROQ_API_KEY missing in environment variables' });
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
        const reply = data.choices?.[0]?.message?.content || 'Jawab nahi mil paya.';
        
        res.json({ reply });
    } catch (error) {
        console.error('Chat Error:', error);
        res.status(500).json({ error: 'Server chat processing failed' });
    }
});

// 2. Image Generation Endpoint (/api/generate-image)
app.post('/api/generate-image', verifyToken, async (req, res) => {
    try {
        const { prompt } = req.body;
        const pollinationsKey = process.env.POLLINATIONS_API_KEY;

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const encodedPrompt = encodeURIComponent(prompt);
        // Pollinations image generation URL with API key configuration
        let imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux.1-schnell&nologo=true`;
        if (pollinationsKey) {
            imageUrl += `&key=${pollinationsKey}`;
        }

        res.json({ imageUrl });
    } xcatch (error) {
        console.error('Image Error:', error);
        res.status(500).json({ error: 'Image generation failed on server' });
    }
});

// Health check root route
app.get('/', (req, res) => {
    res.send('Omni Turbo 0.2 Backend Gateway is Live!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
