require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());

// Serve static files (caption.html etc.)
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

// === ROUTES ===

// Homepage
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// Generate captions (main endpoint, counts toward free tier)
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const key = email.toLowerCase().trim();
  let user = usage[key] || { generations: 0, subscribed: false };

  // Fallback: check Stripe subscription if we haven't marked them subscribed
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

  // === FREE TIER LIMIT: 10 GENERATIONS ===
  if (!user.subscribed && user.generations >= 10) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  user.generations++;
  usage[key] = user;

  // Prompt for initial captions + hashtags
  const prompt = `
You are a viral social media copywriter.

Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 characters each)
- 30 relevant, trending hashtags

Format **exactly** as:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 ...
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
    console.error('AI Error (generate):', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// Optimize / Boost endpoint (does NOT consume free trial count)
app.post('/optimize', async (req, res) => {
  const { originalText, idea, platform, tone, targetScore } = req.body || {};

  if (!originalText || !idea || !platform || !tone) {
    return res.status(400).json({ error: 'Missing fields for optimization' });
  }

  const prompt = `
You are a senior social media copywriter.

You are given an existing block of captions + hashtags and the original creative brief.
Your job is to REWRITE the captions to significantly increase engagement
while keeping the same topic, audience, and overall tone.

Brief:
- Platform: ${platform}
- Tone: ${tone}
- Idea: "${idea}"
- Target engagement score (approximate): ${targetScore || 'higher than current'}

Guidelines:
- Caption 1 must have a VERY strong hook that stops the scroll.
- Use concrete benefits, curiosity, and emotional language.
- Keep captions short and punchy, with line breaks for readability.
- Include a clear CTA in each caption (comment, share, save, click, etc.).
- For hashtags: mix 3-5 broad tags with 15-25 niche/long-tail tags.
- Avoid banned or overly generic tags (no #follow4follow, etc.).
- Keep the content brand-safe.

Return the improved content in EXACTLY this format:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 #tag3 ...

Here is the current version to improve:

"""${originalText}"""
  `.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 600,
    });

    const optimized = completion.choices[0]?.message?.content || originalText;
    res.json({ optimized });
  } catch (err) {
    console.error('AI Error (optimize):', err.message);
    res.status(500).json({ error: 'Optimization failed' });
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

// Stripe webhook: mark user subscribed
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

// START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Live URL: https://caption-ai-ze13.onrender.com`);
  console.log(`Webhook URL: https://caption-ai-ze13.onrender.com/webhook`);
});
