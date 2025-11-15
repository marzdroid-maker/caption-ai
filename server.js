require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());

// Serve static files (caption.html, etc.)
app.use(express.static('.'));

// Parse JSON for all routes EXCEPT /webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// === IN-MEMORY USAGE TRACKING ===
const usage = {};

// === GROQ AI SETUP ===
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// === HELPERS ===
async function ensureStripeSubscription(email, user) {
  try {
    const customers = await stripe.customers.list({ email });
    if (customers.data.length > 0) {
      const customer = customers.data[0];
      const subs = await stripe.subscriptions.list({ customer: customer.id });
      if (subs.data.length > 0 && subs.data[0].status === 'active') {
        user.subscribed = true;
        console.log(`${email} is subscribed (Stripe check)`);
      }
    }
  } catch (err) {
    console.error('Stripe subscription check failed:', err.message);
  }
}

// === ROUTES ===

// Homepage
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
  let user = usage[key] || { generations: 0, subscribed: false };

  // Check subscription via Stripe (fallback)
  await ensureStripeSubscription(email, user);

  // Enforce free tier
  if (!user.subscribed && user.generations >= 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

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
3. "..."
4. "..."
5. "..."

## Hashtags
#Tag1 #Tag2 ...
  `.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 700,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error (generate):', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// ⭐ Boost captions (improve engagement)
app.post('/boost', async (req, res) => {
  const { idea, platform, tone, email, captions } = req.body;

  if (!idea || !platform || !tone || !email || !captions) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const key = email.toLowerCase().trim();
  let user = usage[key] || { generations: 0, subscribed: false };

  // Check subscription via Stripe
  await ensureStripeSubscription(email, user);

  // Free tier: count boost as a "generation" too
  if (!user.subscribed && user.generations >= 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  user.generations++;
  usage[key] = user;

  const prompt = `
You are a world-class viral social media copywriter.

We already have AI-generated captions + hashtags, but we want to BOOST ENGAGEMENT.

Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"

CURRENT OUTPUT:
${captions}

Your job:
- Rewrite and improve the 5 captions to maximize:
  - Hook in the first line
  - Clarity and readability (short lines, strong flow)
  - Strong, specific CTA
- Clean up and optimize the hashtag set:
  - Mix of 2–3 broad tags and 10+ niche/targeted tags
  - Avoid duplicates and spammy tags

IMPORTANT:
- Keep the same structure and formatting as the current output.
- Return in EXACTLY this format:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#Tag1 #Tag2 #Tag3 ...
  `.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
      max_tokens: 800,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error (boost):', err.message);
    res.status(500).json({ error: 'AI boost failed' });
  }
});

// Create checkout session
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

// Stripe webhook
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
  console.log(`Webhook URL: https://caption-ai-ze13.onrender.com/webhook`);
});
