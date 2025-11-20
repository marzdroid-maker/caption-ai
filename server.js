require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email

// Fix 1: Load VIP emails and define helper functions
const vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim());
console.log(`VIP list loaded. Found ${vipEmails.length} VIP emails.`);

function isVipEmail(email) {
  const key = email.toLowerCase().trim();
  return vipEmails.includes(key);
}

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

// Fix 2: Update getUserUsage to check VIP status on initialization
function getUserUsage(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) {
    // Initialize VIP users as subscribed from the start
    const isVip = isVipEmail(email);
    usage[key] = { generations: 0, subscribed: isVip };
  }
  return { key, record: usage[key] };
}

async function refreshStripeSubscriptionStatus(email) {
  try {
    // Use a more robust check: find the customer, then check their subscriptions
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return false;

    const customer = customers.data[0];
    const activeSubs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1 
    });
    return activeSubs.data.length > 0;
  } catch (err) {
    console.error('Stripe subscription check failed:', err.message);
    // Return null to signal UNKNOWN status, allowing existing state to persist
    return null; 
  }
}

// === ROUTES ===

// Fix 4: Add missing endpoint for the frontend to check subscription status
app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;

    if (!email) {
        return res.status(400).json({ error: 'Email query parameter required' });
    }

    const isVip = isVipEmail(email);
    let isPro = false;

    if (isVip) {
        isPro = true;
    } else {
        // Only check Stripe if they are not VIP
        const isStripeSubscribed = await refreshStripeSubscriptionStatus(email);
        if (isStripeSubscribed === true) {
            isPro = true;
        }
    }

    // Returns true if the user is EITHER a VIP OR a Stripe subscriber.
    res.json({ 
        isPro: isPro,
        isVip: isVip,
    });
});

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

  // Fix 3: Refactored Subscription Logic
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);
  
  if (isCurrentlySubscribedOnStripe === true) {
    record.subscribed = true;
  } 
  // If Stripe confirms inactive AND they are not VIP, set subscribed to false.
  else if (isCurrentlySubscribedOnStripe === false && !isVip) {
    record.subscribed = false;
    record.generations = record.generations || 0; 
  }
  // VIP status guarantees subscribed = true
  if (isVip) {
      record.subscribed = true;
  }
  // End Fix 3

  // Enforce free tier
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const prompt = `
You are a viral social media copywriter.
...
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

  // Fix 3: Refactored Subscription Logic (Same as /generate)
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);

  if (isCurrentlySubscribedOnStripe === true) {
    record.subscribed = true;
  }
  else if (isCurrentlySubscribedOnStripe === false && !isVip) {
    record.subscribed = false;
    record.generations = record.generations || 0;
  }
  if (isVip) {
      record.subscribed = true;
  }
  // End Fix 3

  // Enforce free tier for Boost calls as well
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const boostPrompt = `
You are a senior social media copywriter.
...
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
  const { email, referralCode } = req.body || {};
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
      metadata: {
        user_email: email,
        referral_code: referralCode || ''
      },
      subscription_data: {
        metadata: {
          user_email: email,
          referral_code: referralCode || ''
        }
      }
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
      // When checkout completes, immediately mark the user as subscribed and reset generations
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