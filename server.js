require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 10000;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== SERVE FRONTEND (caption.html) =====
// This guarantees Render ALWAYS loads your UI.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'caption.html'));
});

// ===== STATIC FILES =====
// Allows linked CSS/JS/images in caption.html
app.use(express.static(__dirname));

// ===== FREE TIER LIMIT =====
const FREE_TIER_LIMIT = 10;

// ===== IN-MEMORY USAGE TRACKING =====
// (Resets on each server restart — good enough for free-tier)
const usageTracker = {}; // { email: { freeUses: number, isPro: boolean } }

// ===== STRIPE CHECKOUT =====
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.DOMAIN}/?success=true`,
      cancel_url: `${process.env.DOMAIN}/?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// ===== CHECK SUBSCRIPTION =====
app.post('/check-subscription', async (req, res) => {
  try {
    const { email } = req.body;

    // If user already recorded in tracker as Pro, skip Stripe lookup
    if (usageTracker[email]?.isPro) {
      return res.json({ isPro: true, freeUses: 0 });
    }

    // Otherwise check Stripe
    const customers = await stripe.customers.list({ email });
    const customer = customers.data[0];

    if (!customer) {
      // New user: assign free tier
      if (!usageTracker[email]) {
        usageTracker[email] = { freeUses: 0, isPro: false };
      }
      return res.json({
        isPro: false,
        freeUses: FREE_TIER_LIMIT - usageTracker[email].freeUses,
      });
    }

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
    });

    if (subs.data.length > 0) {
      // Mark as Pro in memory
      usageTracker[email] = { freeUses: 0, isPro: true };
      return res.json({ isPro: true, freeUses: 0 });
    }

    // Not Pro — return remaining free uses
    if (!usageTracker[email]) {
      usageTracker[email] = { freeUses: 0, isPro: false };
    }

    return res.json({
      isPro: false,
      freeUses: FREE_TIER_LIMIT - usageTracker[email].freeUses,
    });
  } catch (err) {
    console.error('Subscription check error:', err);
    res.status(500).json({ error: 'Subscription check failed' });
  }
});

// ===== TRACK FREE USAGE =====
app.post('/track', (req, res) => {
  const { email } = req.body;

  if (!usageTracker[email]) {
    usageTracker[email] = { freeUses: 0, isPro: false };
  }

  if (!usageTracker[email].isPro) {
    usageTracker[email].freeUses += 1;
  }

  res.json({
    freeUses: FREE_TIER_LIMIT - usageTracker[email].freeUses,
    isPro: usageTracker[email].isPro,
  });
});

// ===== GENERATION ENDPOINT =====
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await client.chat.completions.create({
      model: 'mixtral-8x7b-32768',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt },
      ],
    });

    const text = completion.choices[0].message.content;
    res.json({ output: text });
  } catch (err) {
    console.error('Groq generate error:', err);
    res.status(500).json({ error: 'Could not generate content' });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
