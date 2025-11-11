// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // ← SERVES caption.html + assets

// IN-MEMORY USAGE TRACKING (replace with DB later)
const usage = {};

// GENERATE CAPTIONS
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const key = email.toLowerCase().trim();
  usage[key] = (usage[key] || 0) + 1;

  if (usage[key] > 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  try {
    const prompt = `Write 5 ${tone} captions for: "${idea}". Platform: ${platform}. Engaging, viral. Then list 30 relevant hashtags. Format: ## Captions\n1. ...\n## Hashtags\n#tag1 #tag2...`;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 500,
    });

    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    console.error('AI Error:', err);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// CREATE STRIPE CHECKOUT SESSION
app.post('/create-checkout-session', async (req, res) => {
  const { email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${req.headers.origin}?success=true`,
      cancel_url: `${req.headers.origin}?canceled=true`,
      customer_email: email,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe Error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// SERVE FRONTEND
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// INIT GROQ
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);
});