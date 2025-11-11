// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// In-memory usage tracking (replace with DB later)
const usage = {};

// Generate captions
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const key = email.toLowerCase().trim();
  usage[key] = (usage[key] || 0) + 1;

  if (usage[key] > 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  try {
    const prompt = `Write 5 ${tone} Instagram captions for: "${idea}". Platform: ${platform}. Style: engaging, viral. Then list 30 relevant hashtags. Format: ## Captions\n1. ...\n## Hashtags\n#tag1 #tag2...`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama3-8b-8192',
      temperature: 0.7,
      max_tokens: 500,
    });

    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { email } = req.body;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price: 'price_1SRccGFrRDBGUN6Xabc123def', // ← YOUR PRICE ID
      quantity: 1,
    }],
    mode: 'subscription',
    success_url: `${req.headers.origin}?success=true`,
    cancel_url: `${req.headers.origin}?canceled=true`,
    customer_email: email,
  });
  res.json({ url: session.url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));