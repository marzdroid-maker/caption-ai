require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());

// Serve static files (caption.html)
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

// Helper: get or init user record
function getUser(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) {
    usage[key] = { generations: 0, subscribed: false };
  }
  return { user: usage[key], key };
}

// Helper: check Stripe subscription (best-effort)
async function refreshSubscriptionFromStripe(email, user) {
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

  const { user, key } = getUser(email);

  // Check subscription
  await refreshSubscriptionFromStripe(email, user);

  // Enforce free tier limit
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
      max_tokens: 500,
    });

    const result = completion.choices[0]?.message?.content || 'No result';
    res.json({ result });
  } catch (err) {
    console.error('AI Error (generate):', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// 🔥 NEW: Optimize captions for higher engagement
app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, current } = req.body;

  if (!idea || !platform || !tone || !email || !current) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const { user, key } = getUser(email);

  // Check subscription
  await refreshSubscriptionFromStripe(email, user);

  // Same free-tier limit for optimization
  if (!user.subscribed && user.generations >= 3) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  user.generations++;
  usage[key] = user;

  const prompt = `
You are a senior viral social media copywriter.

The creator is posting on:
- Platform: ${platform}
- Tone: ${tone}
- Core idea: "${idea}"

They already generated this caption bundle (5 captions + 30 hashtags):

${current}

Your job:
- Rewrite this bundle to maximize engagement:
  - Stronger hook (first line must stop the scroll)
  - Clear, benefit-driven language
  - Scannable formatting (short lines, white space)
  - Strong CTAs (save, share, comment, click, DM, etc.)
  - Hashtags that mix broad + niche tags and match the topic

Rules:
- KEEP THE SAME OVERALL FORMAT:
  - "## Captions" on its own line
  - Then a numbered list 1–5 of captions
  - "## Hashtags" on its own line
  - Then 30 hashtags in a single line separated by spaces
- KEEP IT BELIEVABLE: no insane claims or fake numbers.
- Do NOT explain or add commentary — return ONLY the optimized captions + hashtags in the same format.
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

// Stripe webhook: mark user as subscribed
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
