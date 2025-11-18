require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Base URL for redirects (Stripe onboarding, success links)
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://caption-ai-ze13.onrender.com';

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

// === AFFILIATE SYSTEM (30% recurring revenue share) ===
// In-memory affiliate registry: affiliateEmail -> { referralCode, stripeAccountId, createdAt }
const affiliates = {};

// Track who referred which subscriber: subscriberEmail -> { referrerEmail, codeUsed, createdAt }
const referrals = {};

// Generate a stable referral code from email
function generateReferralCode(email) {
  return Buffer.from(email.toLowerCase().trim())
    .toString('base64')
    .replace(/=/g, '')
    .slice(0, 12);
}


// === GROQ AI SETUP ===
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Small helper to get or init usage record
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

// === ROUTES ===

// Homepage
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// Generate captions
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body || {};

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const { key, record } = getUserUsage(email);

  // Check Stripe subscription (best-effort)
  const isSubscribed = await refreshStripeSubscriptionStatus(email);
  if (isSubscribed) {
    record.subscribed = true;
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

// === AFFILIATE ONBOARDING & INFO ===

// Any user can become an affiliate and earn 30% recurring commissions.
app.get('/affiliate/onboard', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Reuse existing affiliate record if present
    let record = affiliates[email];

    if (!record) {
      // 1) Create a Stripe Connect Standard account for this user
      const account = await stripe.accounts.create({
        type: 'standard',
        email
      });

      // 2) Generate a referral code for this affiliate
      const referralCode = generateReferralCode(email);

      record = affiliates[email] = {
        stripeAccountId: account.id,
        referralCode,
        createdAt: new Date().toISOString()
      };
    }

    // 3) Create onboarding link so Stripe can collect payout details
    const link = await stripe.accountLinks.create({
      account: record.stripeAccountId,
      refresh_url: `${APP_BASE_URL}/affiliate/retry`,
      return_url: `${APP_BASE_URL}/affiliate/success?email=${encodeURIComponent(email)}`,
      type: 'account_onboarding'
    });

    return res.json({
      url: link.url,
      referralCode: record.referralCode
    });
  } catch (err) {
    console.error('Error in /affiliate/onboard:', err.message);
    return res.status(500).json({ error: 'Failed to start affiliate onboarding' });
  }
});

// Get affiliate info (for showing their referral link)
app.get('/affiliate/info', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ isAffiliate: false });

  const record = affiliates[email];
  if (!record) return res.json({ isAffiliate: false });

  res.json({
    isAffiliate: true,
    referralCode: record.referralCode,
    referralLink: `${APP_BASE_URL}?ref=${record.referralCode}`
  });
});

app.post('/create-checkout-session', async (req, res) => {
  const { email, referralCode } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const customerEmail = email.toLowerCase().trim();

  try {
    // Try to resolve affiliate from referralCode
    let affiliateRecord = null;
    let referrerEmail = null;

    if (referralCode) {
      for (const [affEmail, rec] of Object.entries(affiliates)) {
        if (rec.referralCode === referralCode) {
          affiliateRecord = rec;
          referrerEmail = affEmail;
          break;
        }
      }
    }

    // Record referral mapping for analytics
    if (affiliateRecord && referrerEmail && !referrals[customerEmail]) {
      referrals[customerEmail] = {
        referrerEmail,
        codeUsed: referralCode,
        createdAt: new Date().toISOString()
      };
    }

    const priceId = process.env.STRIPE_PRICE_ID;

    let paymentIntentData;
    if (affiliateRecord && affiliateRecord.stripeAccountId) {
      try {
        const price = await stripe.prices.retrieve(priceId);
        const amountCents = price.unit_amount || 0;
        const appFee = Math.round(amountCents * 0.70); // your 70%

        paymentIntentData = {
          application_fee_amount: appFee,
          transfer_data: {
            destination: affiliateRecord.stripeAccountId // affiliate gets the remainder (~30%)
          }
        };
      } catch (err) {
        console.error('Failed to retrieve price for affiliate split:', err.message);
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      customer_email: customerEmail,
      success_url: `${APP_BASE_URL}?success=true`,
      cancel_url: `${APP_BASE_URL}?canceled=true`,
      payment_intent_data: paymentIntentData
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err.message);
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
