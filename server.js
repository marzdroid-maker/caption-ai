require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_LIMIT = 10; // 10 free generations

// === MIDDLEWARE ===
app.use(cors());

// Serve static HTML + assets
app.use(express.static('.'));

// JSON parsing for non-webhook routes
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') next();
  else express.json()(req, res, next);
});

// === IN-MEMORY DB ===
const usage = {};

// === SETUP GROQ ===
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// === ENGAGEMENT SCORE FUNCTION — SAME AS FRONTEND ===
function computeEngagementScore(text, { idea, platform, tone }) {
  if (!text || typeof text !== 'string') return 40;

  text = text.trim();
  idea = (idea || '').trim();
  platform = (platform || '').trim();
  tone = (tone || '').trim();

  const cleaned = text.replace(/^#+\s*captions?/i, '').trim();
  const totalChars = cleaned.length;
  const totalWords = cleaned.split(/\s+/).length;
  const lines = cleaned.split('\n').filter(l => l.trim().length > 0);
  const hashtagMatches = cleaned.match(/#[A-Za-z0-9_]+/g) || [];
  const uniqueHashtags = [...new Set(hashtagMatches.map(h => h.toLowerCase()))];
  const emojiMatches = cleaned.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/gu) || [];

  const ctaRegex = /(comment|save|share|tag|link in bio|dm me|reply|retweet|quote this|swipe)/i;
  const hasCTA = ctaRegex.test(cleaned);

  const questionHooks = (cleaned.match(/\?/g) || []).length;
  const numberedHooks = (cleaned.match(/^\s*\d+\./gm) || []).length;

  let base = 35;

  // Hook score (0–25)
  let hookScore = 0;
  const first160 = cleaned.slice(0, 160);

  if (first160[0] === first160[0]?.toUpperCase()) hookScore += 4;
  if (first160.length >= 40 && first160.length <= 160) hookScore += 5;
  if (questionHooks > 0) hookScore += 4;
  if (ctaRegex.test(first160)) hookScore += 4;
  if (emojiMatches.length >= 1 && emojiMatches.length <= 8) hookScore += 4;
  if (idea && first160.toLowerCase().includes(idea.split(/\s+/)[0].toLowerCase()))
    hookScore += 4;
  if (numberedHooks >= 2) hookScore += 4;

  hookScore = Math.min(hookScore, 25);

  // Structure score (0–20)
  let structureScore = 0;
  if (lines.length >= 6 && lines.length <= 22) structureScore += 8;
  if (totalChars >= 350 && totalChars <= 1600) structureScore += 6;
  const longLines = lines.filter(l => l.length > 180).length;
  if (longLines <= 2) structureScore += 4;

  const capsRatio =
    (cleaned.match(/[A-Z]/g) || []).length /
      (cleaned.match(/[a-zA-Z]/g) || []).length || 0;

  if (capsRatio < 0.45) structureScore += 2;

  structureScore = Math.min(structureScore, 20);

  // Hashtag score (0–20)
  let hashtagScore = 0;
  const nHash = uniqueHashtags.length;

  if (nHash >= 15 && nHash <= 32) hashtagScore += 10;
  else if (nHash >= 10 && nHash < 15) hashtagScore += 6;
  else if (nHash > 32 && nHash <= 45) hashtagScore += 4;

  const longTags = uniqueHashtags.filter(h => h.length >= 9).length;
  const shortTags = uniqueHashtags.filter(h => h.length <= 6).length;

  if (longTags >= 5 && longTags <= 20) hashtagScore += 5;
  if (shortTags >= 3 && shortTags <= 15) hashtagScore += 3;

  if (platform && uniqueHashtags.some(h => h.includes(platform.toLowerCase()))) {
    hashtagScore += 2;
  }

  hashtagScore = Math.min(hashtagScore, 20);

  // Platform fit (0–15)
  let fitScore = 0;
  const lowerTone = tone.toLowerCase();
  const lowerPlatform = platform.toLowerCase();

  if (lowerPlatform === 'linkedin') {
    if (lowerTone.includes('professional')) fitScore += 8;
    if (emojiMatches.length <= 4) fitScore += 4;
    if (totalChars >= 400) fitScore += 3;
  } else if (lowerPlatform === 'twitter') {
    if (totalChars <= 800) fitScore += 5;
    if (emojiMatches.length >= 1 && emojiMatches.length <= 6) fitScore += 5;
    if (lowerTone.includes('bold') || lowerTone.includes('fun')) fitScore += 3;
    if (hasCTA) fitScore += 2;
  } else if (lowerPlatform === 'instagram' || lowerPlatform === 'tiktok') {
    if (emojiMatches.length >= 2) fitScore += 5;
    if (hasCTA) fitScore += 4;
    if (nHash >= 18) fitScore += 4;
    if (
      lowerTone.includes('fun') ||
      lowerTone.includes('casual') ||
      lowerTone.includes('inspirational')
    )
      fitScore += 2;
  } else {
    fitScore += 4;
  }

  fitScore = Math.min(fitScore, 15);

  // Penalties (0 to -20)
  let penalty = 0;
  if (totalChars < 200) penalty -= 10;
  if (totalChars > 2200) penalty -= 6;

  const hashToWord = nHash / (totalWords || 1);
  if (hashToWord > 0.45) penalty -= 6;

  if (emojiMatches.length > 18) penalty -= 4;

  // Randomness for non-deterministic feel (-5..+5)
  const seedStr = (idea + platform + tone + cleaned).toLowerCase();
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) | 0;
  }
  const randomOffset = (hash % 11) - 5;

  let score = base + hookScore + structureScore + hashtagScore + fitScore + penalty + randomOffset;
  score = Math.round(Math.max(10, Math.min(score, 92)));

  return score;
}

// === HELPERS ===
function getUserRecord(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) usage[key] = { generations: 0, subscribed: false };
  return { key, record: usage[key] };
}

async function checkStripeSubscription(email, record) {
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (customers.data.length > 0) {
      const subs = await stripe.subscriptions.list({
        customer: customers.data[0].id,
        status: 'active',
        limit: 1,
      });

      if (subs.data.length > 0) {
        record.subscribed = true;
        return true;
      }
    }
  } catch (err) {
    console.error('Stripe check error:', err.message);
  }
  return record.subscribed;
}

// === ROUTES ===

// Home → caption.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// === GENERATE ===
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const { key, record } = getUserRecord(email);

  await checkStripeSubscription(email, record);

  if (!record.subscribed && record.generations >= FREE_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  const prompt = `
Platform: ${platform}
Tone: ${tone}
Post Idea: "${idea}"

Write 5 short captions + 30 hashtags. Strict format:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 ...
`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 550,
    });

    const result = completion.choices[0].message.content;
    const score = computeEngagementScore(result, { idea, platform, tone });

    record.generations++;
    usage[key] = record;

    res.json({
      result,
      score,
      remainingFree: record.subscribed ? null : FREE_LIMIT - record.generations,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// === BOOST ===
app.post('/boost', async (req, res) => {
  const { idea, platform, tone, email, originalText } = req.body;

  if (!idea || !platform || !tone || !email || !originalText) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const { key, record } = getUserRecord(email);
  await checkStripeSubscription(email, record);

  if (!record.subscribed && record.generations >= FREE_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  const prompt = `
Platform: ${platform}
Tone: ${tone}

Rewrite these captions to get higher engagement:

${originalText}

Maintain same structure: 5 captions + hashtags.
`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
      max_tokens: 600,
    });

    const boosted = completion.choices[0].message.content;
    const boostedScore = computeEngagementScore(boosted, { idea, platform, tone });

    record.generations++;
    usage[key] = record;

    res.json({
      result: boosted,
      score: boostedScore,
      remainingFree: record.subscribed ? null : FREE_LIMIT - record.generations,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Boost failed' });
  }
});

// === STRIPE CHECKOUT ===
app.post('/create-checkout-session', async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      success_url: `${req.headers.origin}?success=true`,
      cancel_url: `${req.headers.origin}?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// === STRIPE WEBHOOK ===
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_email;
      if (email) {
        usage[email.toLowerCase()] = { generations: 0, subscribed: true };
        console.log('Subscription activated for:', email);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
