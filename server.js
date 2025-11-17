require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT_PER_EMAIL = 10;
const FREE_TIER_LIMIT_PER_IP = 20;   // secondary protection
const DAILY_RESET_MS = 24 * 60 * 60 * 1000;

// === USAGE TRACKERS ===
let freeUsageTracker = {};       // { email: { count, lastReset } }
let ipUsageTracker = {};         // { ip: { count, lastReset } }

// === HELPERS ===
function shouldReset(record) {
  if (!record) return true;
  return Date.now() - record.lastReset > DAILY_RESET_MS;
}

function incrementUsage(tracker, key) {
  if (!tracker[key] || shouldReset(tracker[key])) {
    tracker[key] = { count: 1, lastReset: Date.now() };
  } else {
    tracker[key].count += 1;
  }
}

function getUsage(tracker, key) {
  if (!tracker[key] || shouldReset(tracker[key])) return 0;
  return tracker[key].count;
}

// === MIDDLEWARE ===
app.use(cors());
app.use(express.static('.'));  // Serve static files including caption.html

// Raw body needed ONLY for Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// === IN-MEMORY SUBSCRIBERS ===
let subscribers = {};   // { email: true }

// === STRIPE WEBHOOK HANDLER ===
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const email = event.data.object.customer_details.email;
      if (email) {
        subscribers[email] = true;
        console.log(`User upgraded to PRO: ${email}`);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// === CHECK SUBSCRIPTION ===
app.get('/check-subscription', (req, res) => {
  const email = req.query.email;
  const isPro = !!subscribers[email];
  res.json({ isPro });
});

// === GENERATE ROUTE (Free tier + Pro logic) ===
app.post('/generate', async (req, res) => {
  try {
    const { email, prompt } = req.body;
    const userIP =
      req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

    const isPro = !!subscribers[email];

    // If NOT PRO, enforce limits
    if (!isPro) {
      const emailUsage = getUsage(freeUsageTracker, email);
      const ipUsage = getUsage(ipUsageTracker, userIP);

      if (emailUsage >= FREE_TIER_LIMIT_PER_EMAIL) {
        return res.status(429).json({
          error:
            "You’ve used all 10 free generations for this account. Upgrade to Pro to continue."
        });
      }

      if (ipUsage >= FREE_TIER_LIMIT_PER_IP) {
        return res.status(429).json({
          error:
            "This network has reached its daily free usage limit. Upgrade to Pro to continue."
        });
      }

      incrementUsage(freeUsageTracker, email);
      incrementUsage(ipUsageTracker, userIP);
    }

    // Groq API call
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await client.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192"
    });

    res.json({ output: completion.choices[0].message.content });

  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// === PRO-ONLY ANALYZE ENDPOINT ===
app.post('/analyze', (req, res) => {
  const { email } = req.body;

  if (!subscribers[email]) {
    return res
      .status(403)
      .json({ error: "This feature is Pro only." });
  }

  res.json({ result: "Pro analysis successful!" });
});

// === PRO VIRAL POSTS ===
app.get('/pro-viral-posts', (req, res) => {
  const email = req.query.email;

  if (!subscribers[email]) {
    return res.status(403).json({ error: "Pro required" });
  }

  res.json({
    posts: [
      "Here are your viral posts...",
      "More high-performing content..."
    ]
  });
});

// === FRONTEND ROUTE FIX (IMPORTANT) ===
// THIS FIXES THE "Cannot GET /" ERROR
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// === START SERVER ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
