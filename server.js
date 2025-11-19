require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email

// === MIDDLEWARE ===
app.use(cors());

// Serve static files (caption.html, terms, etc.)
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

// Small helper to get or init usage record

// === VIP PRO LIST (influencers, etc.) ===
const VIP_LIST_PATH = path.join(__dirname, 'free-pro-users.json');

function isVipEmail(email) {
  if (!email) return false;
  try {
    const raw = fs.readFileSync(VIP_LIST_PATH, 'utf8');
    const data = JSON.parse(raw);
    const list = (data.emails || []).map(e => String(e).toLowerCase().trim());
    return list.includes(String(email).toLowerCase().trim());
  } catch (err) {
    console.error('VIP list read error:', err.message);
    return false;
  }
}
function getUserUsage(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) {
    usage[key] = { generations: 0, subscribed: false };
  }
  return { key, record: usage[key] };
}

async function refreshStripeSubscriptionStatus(email) {
  try {
    const customers = await stripe.customers.list({ email });
    if (customers.data.length === 0) return false;

    const customer = customers.data[0];
    const subs = await stripe.subscriptions.list({ customer: customer.id });
    const activeSub = subs.data.find(s => s.status === 'active');
    return !!activeSub;
  } catch (err) {
    console.error('Stripe subscription check failed:', err.message);
    return false;
  }
}


// === NIGHTLY STRIPE SYNC ===
async function nightlyStripeRefresh() {
  console.log("Running nightly Stripe subscription sync...");
  for (const email of Object.keys(usage)) {
    try {
      if (isVipEmail(email)) {
        usage[email].subscribed = true;
        continue;
      }
      const isSubscribed = await refreshStripeSubscriptionStatus(email);
      usage[email].subscribed = !!isSubscribed;
    } catch (err) {
      console.error("Nightly sync error for", email, err.message);
    }
  }
  console.log("Nightly Stripe sync complete.");
}

// Kick off initial sync and schedule every 24 hours
nightlyStripeRefresh();
setInterval(nightlyStripeRefresh, 24 * 60 * 60 * 1000);
// === ROUTES ===

// Homepage
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// Check subscription (Stripe + VIP override) for frontend
app.get('/check-subscription', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.json({ isPro: false });
    }

    // VIP override: emails in free-pro-users.json are always Pro
    if (isVipEmail(email)) {
      const { key, record } = getUserUsage(email);
      record.subscribed = true;
      usage[key] = record;
      return res.json({ isPro: true, vip: true });
    }

    // Stripe subscription check
    const isSubscribed = await refreshStripeSubscriptionStatus(email);
    const { key, record } = getUserUsage(email);
    record.subscribed = !!isSubscribed;
    usage[key] = record;

    return res.json({ isPro: !!isSubscribed });
  } catch (err) {
    console.error('Error in /check-subscription:', err.message);
    return res.json({ isPro: false });
  }
});


// Generate captions
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body || {};

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const { key, record } = getUserUsage(email);

  // VIP override: influencers get full Pro access without Stripe
  if (isVipEmail(email)) {
    record.subscribed = true;
  } else {
    // Check Stripe subscription (best-effort)
    const isSubscribed = await refreshStripeSubscriptionStatus(email);
    if (isSubscribed) {
      record.subscribed = true;
    }
  }

  // Enforce free tier
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const prompt = `
You are a viral social media copywriter.

Platform: ${platform}
Tone: ${tone}
Post Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 characters each)
- 30 relevant, trending hashtags

Rules:
- Keep everything brand-safe.
- Match the tone and platform norms.
- Do NOT explain anything.
- Do NOT number hashtags.

Format exactly:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 #tag3 ...
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 600,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error (/generate):', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// Optimize / boost captions
app.post('/optimize', async (req, res) => {
  const {
    idea,
    platform,
    tone,
    email,
    captions,
    previousScore,
  } = req.body || {};

  if (!idea || !platform || !tone || !email || !captions) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { key, record } = getUserUsage(email);

  // Check subscription again
  const isSubscribed = await refreshStripeSubscriptionStatus(email);
  if (isSubscribed) {
    record.subscribed = true;
  }

  // Enforce free tier for Boost calls as well
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const boostPrompt = `
You are a senior social media copywriter.

A creator has this current AI output:

${captions}

Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"
Current engagement score (0-100): ${typeof previousScore === 'number' ? previousScore : 'unknown'}

Your job:
- Rewrite the 5 captions and hashtags to realistically increase engagement.
- Make hooks stronger, CTAs clearer, and hashtags more targeted and niche-rich.
- Keep the core idea and brand-safe tone.
- Keep length in a similar range (don't write a novel).
- Match platform norms (LinkedIn more professional, TikTok more playful, etc.).
- Do NOT explain what you did.
- Do NOT add extra sections.

Format EXACTLY the same as before:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 #tag3 ...
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: boostPrompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
      max_tokens: 700,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error (/optimize):', err.message);
    res.status(500).json({ error: 'AI optimization failed' });
  }
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const { email } = req.body || {};
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
    console.error('Stripe Error (checkout):', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// Stripe webhook to mark user as subscribed
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
