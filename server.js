// === server.js — with Affiliate Enablement ===
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
const FREE_TIER_LIMIT = 10;

// === MIDDLEWARE ===
app.use(cors());
app.use(express.static('.'));
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') next();
  else express.json()(req, res, next);
});

// === IN-MEMORY USAGE ===
const usage = {};

// === AFFILIATE SYSTEM (30% recurring revenue) ===
const affiliates = {}; // email → { referralCode, stripeAccountId, createdAt }
const referrals = {};  // customerEmail → { referrerEmail, codeUsed, createdAt }

function generateReferralCode(email) {
  return Buffer.from(email.toLowerCase().trim())
    .toString("base64")
    .replace(/=/g, "")
    .slice(0, 12);
}

function getUserUsage(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) usage[key] = { generations: 0, subscribed: false };
  return { key, record: usage[key] };
}

async function refreshStripeSubscriptionStatus(email) {
  try {
    const customers = await stripe.customers.list({ email });
    if (customers.data.length === 0) return false;
    const subs = await stripe.subscriptions.list({ customer: customers.data[0].id });
    return !!subs.data.find(s => s.status === "active");
  } catch {
    return false;
  }
}

// === GROQ ===
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// === ROUTES ===
app.get('/', (req, res) => res.sendFile(__dirname + '/caption.html'));

// ===== Generate captions =====
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body || {};
  if (!idea || !platform || !tone || !email)
    return res.status(400).json({ error: 'All fields required' });

  const { key, record } = getUserUsage(email);
  if (await refreshStripeSubscriptionStatus(email)) record.subscribed = true;
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT)
    return res.status(402).json({ error: 'Upgrade required' });

  record.generations++;
  usage[key] = record;

  const prompt = `
You are a viral social media copywriter.
Platform: ${platform}
Tone: ${tone}
Post Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 chars)
- 30 trending hashtags

Format:

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
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 600
    });
    res.json({ result: completion.choices[0]?.message?.content || "" });
  } catch (e) {
    res.status(500).json({ error: "AI generation failed" });
  }
});

// ===== Optimize captions =====
app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, captions, previousScore } = req.body || {};
  if (!idea || !platform || !tone || !email || !captions)
    return res.status(400).json({ error: 'Missing fields' });

  const { key, record } = getUserUsage(email);
  if (await refreshStripeSubscriptionStatus(email)) record.subscribed = true;
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT)
    return res.status(402).json({ error: 'Upgrade required' });

  record.generations++;
  usage[key] = record;

  const boostPrompt = `
Rewrite these 5 captions to increase engagement but keep tone and idea:

${captions}

Platform: ${platform}
Tone: ${tone}
Idea: "${idea}"
Current Score: ${previousScore}

FORMAT:

## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 #tag3 ...
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: boostPrompt }],
      temperature: 0.8,
      max_tokens: 700
    });
    res.json({ result: completion.choices[0]?.message?.content || "" });
  } catch {
    res.status(500).json({ error: "AI optimization failed" });
  }
});

// === AFFILIATE: ONBOARD ===
app.get('/affiliate/onboard', async (req, res) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });

    let record = affiliates[email];

    if (!record) {
      const account = await stripe.accounts.create({
        type: "standard",
        email
      });

      record = affiliates[email] = {
        referralCode: generateReferralCode(email),
        stripeAccountId: account.id,
        createdAt: new Date().toISOString()
      };
    }

    const link = await stripe.accountLinks.create({
      account: record.stripeAccountId,
      refresh_url: `${APP_BASE_URL}/affiliate/retry`,
      return_url: `${APP_BASE_URL}/affiliate/success?email=${encodeURIComponent(email)}`,
      type: 'account_onboarding'
    });

    res.json({ url: link.url, referralCode: record.referralCode });
  } catch (e) {
    res.status(500).json({ error: "Affiliate onboarding failed" });
  }
});

// === AFFILIATE: INFO ===
app.get('/affiliate/info', (req, res) => {
  const email = (req.query.email || "").trim().toLowerCase();
  const record = affiliates[email];
  if (!record) return res.json({ isAffiliate: false });

  res.json({
    isAffiliate: true,
    referralCode: record.referralCode,
    referralLink: `${APP_BASE_URL}?ref=${record.referralCode}`
  });
});

// === CHECKOUT SESSION (with optional affiliate payout) ===
app.post('/create-checkout-session', async (req, res) => {
  const { email, referralCode } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email required" });

  const customerEmail = email.toLowerCase().trim();

  let affiliateRecord = null;
  let referrerEmail = null;

  if (referralCode) {
    for (const [k, v] of Object.entries(affiliates)) {
      if (v.referralCode === referralCode) {
        affiliateRecord = v;
        referrerEmail = k;
      }
    }
  }

  if (affiliateRecord && referrerEmail && !referrals[customerEmail]) {
    referrals[customerEmail] = {
      referrerEmail,
      codeUsed: referralCode,
      createdAt: new Date().toISOString()
    };
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  let paymentIntentData = undefined;

  if (affiliateRecord?.stripeAccountId) {
    const price = await stripe.prices.retrieve(priceId);
    const amt = price.unit_amount || 0;
    const appFee = Math.round(amt * 0.70);
    paymentIntentData = {
      application_fee_amount: appFee,
      transfer_data: { destination: affiliateRecord.stripeAccountId }
    };
  }

  const metadata = referralCode
    ? { referral_code: referralCode, referrer_email: referrerEmail }
    : {};

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      customer_email: customerEmail,
      success_url: `${APP_BASE_URL}?success=true`,
      cancel_url: `${APP_BASE_URL}?canceled=true`,
      payment_intent_data: paymentIntentData,
      metadata,
      subscription_data: {
        metadata
      }
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: "Checkout failed" });
  }
});

// === WEBHOOK ===
app.post('/webhook', express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    return res.status(400).send("Webhook error");
  }

  if (event.type === "checkout.session.completed") {
    const email = event.data.object.customer_email;
    if (email) {
      const key = email.toLowerCase().trim();
      usage[key] = { generations: 0, subscribed: true };
    }
  }

  res.json({ received: true });
});

// === HEALTH ===
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
