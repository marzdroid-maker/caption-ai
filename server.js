
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// VIP override file
const VIP_LIST_PATH = path.join(__dirname, 'free-pro-users.json');
function isVipEmail(email) {
  try {
    const data = fs.readFileSync(VIP_LIST_PATH, 'utf8');
    const json = JSON.parse(data);
    return json.emails.includes(email.toLowerCase());
  } catch (err) {
    console.error("Error reading VIP list:", err);
    return false;
  }
}

// Serve caption.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'caption.html'));
});
app.use(express.static(__dirname));

const usageTracker = {};
const FREE_TIER_LIMIT = 10;

// Subscription check
app.post('/check-subscription', async (req, res) => {
  try {
    const { email } = req.body;

    // VIP override
    if (isVipEmail(email)) {
      usageTracker[email] = { freeUses: 0, isPro: true };
      return res.json({ isPro: true, freeUses: 0, vip: true });
    }

    if (usageTracker[email]?.isPro) {
      return res.json({ isPro: true, freeUses: 0 });
    }

    const customers = await stripe.customers.list({ email });
    const customer = customers.data[0];

    if (!customer) {
      if (!usageTracker[email]) {
        usageTracker[email] = { freeUses: 0, isPro: false };
      }
      return res.json({
        isPro: false,
        freeUses: FREE_TIER_LIMIT - usageTracker[email].freeUses
      });
    }

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active'
    });

    if (subs.data.length > 0) {
      usageTracker[email] = { freeUses: 0, isPro: true };
      return res.json({ isPro: true, freeUses: 0 });
    }

    if (!usageTracker[email]) {
      usageTracker[email] = { freeUses: 0, isPro: false };
    }

    return res.json({
      isPro: false,
      freeUses: FREE_TIER_LIMIT - usageTracker[email].freeUses
    });

  } catch (err) {
    console.error('Subscription check error:', err);
    res.status(500).json({ error: 'Subscription check failed' });
  }
});

// Track free usage
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
    isPro: usageTracker[email].isPro
  });
});

// Generate route
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await client.chat.completions.create({
      model: 'mixtral-8x7b-32768',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
      ]
    });

    res.json({ output: completion.choices[0].message.content });
  } catch (err) {
    console.error('Groq generate error:', err);
    res.status(500).json({ error: 'Could not generate content' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
