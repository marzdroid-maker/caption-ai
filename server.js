require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
app.use(cors());

// Serve static files (caption.html, terms.html, etc.)
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
const MAX_FREE_GENERATIONS = 10;

// === GROQ AI SETUP ===
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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

  // Check subscription status via Stripe as a fallback
  try {
    const customers = await stripe.customers.list({ email });
    if (customers.data.length > 0) {
      const customer = customers.data[0];
      const subs = await stripe.subscriptions.list({ customer: customer.id });
      if (subs.data.length > 0 && subs.data[0].status === 'active') {
        user.subscribed = true;
        usage[key] = user;
        console.log(`${email} is subscribed (Stripe check)`);
      }
    }
  } catch (err) {
    console.error('Stripe subscription check failed:', err.message);
  }

  // Enforce free tier limit (10 free generations)
  if (!user.subscribed && user.generations >= MAX_FREE_GENERATIONS) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  user.generations++;
  usage[key] = user;

  // AI prompt for captions + hashtags
  const prompt = `
You are a viral social media copywriter.
Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 characters each)
- 30 relevant, trending hashtags

Important:
- Make the captions scroll-stopping with strong hooks and clear CTAs.
- Tailor language, style, and emoji usage to the platform and tone.
- Hashtags should be a mix of broad + niche tags, no duplicates.

Format exactly as:

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
    console.error('AI Error (generate):', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// Optimize captions for higher engagement (Boost My Score)
app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, currentText } = req.body;

  if (!idea || !platform || !tone || !email || !currentText) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const key = email.toLowerCase().trim();
  let user = usage[key] || { generations: 0, subscribed: false };
  usage[key] = user; // ensure key exists

  // NOTE: Boost does NOT consume an extra "generation" count.
  // It is a value-add on top of an existing generation, free or Pro.

  const prompt = `
You are a senior social media copywriter and engagement strategist.

User inputs:
- Platform: ${platform}
- Tone: ${tone}
- Idea: "${idea}"

They already generated captions and hashtags (see below). Your job:
- Rewrite the FULL set of 5 captions + 30 hashtags to significantly increase engagement:
  - Stronger hooks
  - Clearer CTAs (comments, saves, shares, clicks)
  - Better scannability (line breaks, lists, etc.) where appropriate
  - Platform-appropriate style and emoji usage

Constraints:
- Keep exactly 5 captions.
- Each caption must stay under 280 characters.
- Keep ~30 hashtags, no duplicates.
- Preserve the original intent of the idea, but make it more compelling and viral-friendly.
- Tailor the writing style for the platform and tone.

Return ONLY in this exact format (no explanations):

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 #tag3 ...

---

Current captions and hashtags:
${currentText}
`.trim();

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
      max_tokens: 700,
    });

    const result = completion.choices[0]?.message?.content || currentText;
    res.json({ result });
  } catch (err) {
    console.error('AI Error (optimize):', err.message);
    // On failure, just return the original text so the UI can decide what to do.
    res.status(500).json({ error: 'Optimization failed', result: currentText });
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
    console.error('Stripe Error (checkout):', err.message);
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
      console.log(`User subscribed via webhook: ${email}`);
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
