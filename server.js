require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONSTANTS ===
const FREE_TIER_LIMIT = 10;

// === MIDDLEWARE ===
app.use(cors());

// Normal JSON parsing for all routes *except* /webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Additional JSON parser (prevents req.body = {} inside affiliate routes)
app.use(express.json());

// Serve static files
app.use(express.static('.'));

// In-memory per-email usage counter
const usage = new Map();

// === AFFILIATE ROUTES ===

// Create Stripe Connect Account
app.post('/create-connect-account', async (req, res) => {
  try {
    const { email } = req.body || {};

    console.log("Affiliate request body:", req.body);

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email is required." });
    }

    // Create Express connect account
    const account = await stripe.accounts.create({
      type: "express",
      email,
      capabilities: {
        transfers: { requested: true }
      },
      metadata: {
        user_email: email
      }
    });

    const origin =
      req.headers.origin ||
      process.env.APP_BASE_URL ||
      "https://caption-ai-ze13.onrender.com";

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url:
        process.env.INFLUENCER_ONBOARD_REFRESH_URL ||
        `${origin}?connect_refresh=1`,
      return_url:
        process.env.INFLUENCER_ONBOARD_RETURN_URL ||
        `${origin}?connect_return=1`,
      type: "account_onboarding"
    });

    return res.json({
      connectAccountId: account.id,
      referralCode: account.id,
      onboardingUrl: accountLink.url
    });
  } catch (err) {
    console.error("Create Connect Account Error:", err);
    return res.status(500).json({ error: "Failed to create Connect account" });
  }
});

// Return a referral link
app.get('/referral-link', (req, res) => {
  try {
    const referralCode = req.query.referralCode;

    if (!referralCode) {
      return res
        .status(400)
        .json({ error: "referralCode query parameter missing" });
    }

    const origin =
      req.headers.origin ||
      process.env.APP_BASE_URL ||
      "https://caption-ai-ze13.onrender.com";

    return res.json({
      referralUrl: `${origin}/?ref=${encodeURIComponent(referralCode)}`
    });
  } catch (err) {
    console.error("Referral Link Error:", err);
    return res.status(500).json({ error: "Failed to create referral link" });
  }
});

// === GROQ AI ROUTES ===
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function runGeneration(promptText) {
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: promptText }],
    model: "llama3-70b-8192"
  });
  return completion.choices[0].message.content;
}

// Generate captions
app.post('/generate', async (req, res) => {
  try {
    const { email, postIdea, platform, tone } = req.body;

    if (!email) return res.status(400).json({ error: "Email is required." });

    const count = usage.get(email) || 0;
    const isPaidUser =
      process.env.FREE_PRO_USERS &&
      JSON.parse(process.env.FREE_PRO_USERS).includes(email);

    if (!isPaidUser && count >= FREE_TIER_LIMIT) {
      return res.status(403).json({ error: "Free tier limit reached" });
    }

    usage.set(email, count + 1);

    const text = `Write 5 captions + 30 hashtags for: ${postIdea}
Platform: ${platform}
Tone: ${tone}
Give an engagement score from 1-100.`;

    const output = await runGeneration(text);
    return res.json({ output });
  } catch (err) {
    console.error("Generation Error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

// === STRIPE WEBHOOK ===
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      res.json({ received: true });
    } catch (err) {
      console.error("Webhook Error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
