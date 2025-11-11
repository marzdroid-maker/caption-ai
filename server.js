require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.')); // Serve caption.html

// In-memory usage tracking (email → { generations, subscribed })
const usage = {};

// Groq AI Setup
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// === ROUTES ===

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// Generate captions
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const key = email.toLowerCase().trim();
  const user = usage[key] || { generations: 0, subscribed: false };

  // Check subscription or free tier
  if (!user.subscribed && user.generations >= 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  // Increment usage
  user.generations++;
  usage[key] = user;

  const prompt = `
You are a viral social media copywriter.
Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 chars each)
- 30 relevant, trending hashtags

Format:
## Captions
1. "..."
2. "..."
...

## Hashtags
#Tag1 #Tag2 ...
  `.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 500,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error:', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// Create Stripe checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      customer_email: email,
      success_url: `${req.headers.origin}?success=true`,
      cancel_url: `${req.headers.origin}?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe Error:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// === STRIPE WEBHOOK: MARK USER AS SUBSCRIBED ===
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;

    if (email) {
      const key = email.toLowerCase().trim();
      usage[key] = { generations: 0, subscribed: true };
      console.log(`User subscribed: ${email}`);
    }
  }

  res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Live URL: https://caption-ai-ze13.onrender.com`);
});