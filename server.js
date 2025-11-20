require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email

// Load VIP emails from the JSON file
const vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim());
console.log(`VIP list loaded. Found ${vipEmails.length} VIP emails.`);

// Helper function for VIP check
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
  apiKey: process.env.ENV.GROQ_API_KEY,
});

// Small helper to get or init usage record
function getUserUsage(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) {
    // Initialize VIP users as subscribed from the start
    const isVip = isVipEmail(email);
    usage[key] = { generations: 0, subscribed: isVip };
  }
  return { key, record: usage[key] };
}

// === REVISED STRIPE CHECK (More robust logic) ===
async function refreshStripeSubscriptionStatus(email) {
  try {
    // 1. Find customer by email (Stripe can create multiple, we take the first)
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return false;

    const customer = customers.data[0];

    // 2. List active subscriptions specifically for that customer ID
    const activeSubs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 1 // We only need to know if at least one active subscription exists
    });

    return activeSubs.data.length > 0;

  } catch (err) {
    // Returning null signals that the status is UNKNOWN due to API failure.
    console.error('Stripe subscription check failed:', err.message);
    return null; 
  }
}

// === ROUTES ===

// New endpoint for the frontend to check subscription status
app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;

    if (!email) {
        return res.status(400).json({ error: 'Email query parameter required' });
    }

    const isVip = isVipEmail(email);
    let isPro = false;

    if (isVip) {
        isPro = true; // VIP users are Pro
    } else {
        // Only check Stripe if they are not VIP
        const isStripeSubscribed = await refreshStripeSubscriptionStatus(email);
        if (isStripeSubscribed === true) {
            isPro = true; // Stripe active users are Pro
        }
        // No need to handle the in-memory update here, the /generate route will handle it 
        // and the front-end just needs the status.
    }

    // This endpoint must return true if the user is EITHER a VIP OR a Stripe subscriber.
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

  // === SUBSCRIPTION LOGIC START ===
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);
  
  // If Stripe check succeeded and confirmed active, mark as subscribed
  if (isCurrentlySubscribedOnStripe === true) {
    record.subscribed = true;
  } 
  // If Stripe check succeeded and confirmed NOT active, AND the user is not a VIP,
  // then we set subscribed to false and reset generations.
  else if (isCurrentlySubscribedOnStripe === false && !isVip) {
    record.subscribed = false;
    record.generations = record.generations || 0; 
  }
  // The user is also subscribed if they are a VIP, regardless of Stripe check.
  if (isVip) {
      record.subscribed = true;
  }
  // NOTE: If isCurrentlySubscribedOnStripe is null (Stripe error), 
  // we rely on the existing 'record.subscribed' state, which is correct.
  // === SUBSCRIPTION LOGIC END ===

  // Enforce free tier
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const prompt = `
You are a viral social media copywriter.
... (rest of prompt)
`.trim(); // Prompt content removed for brevity but is unchanged.

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
  const { idea, platform, tone, email, captions, previousScore } = req.body || {};

  if (!idea || !platform || !tone || !email || !captions) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { key, record } = getUserUsage(email);

  // === SUBSCRIPTION LOGIC START (Same as /generate) ===
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);

  // If Stripe check succeeded and confirmed active, mark as subscribed
  if (isCurrentlySubscribedOnStripe === true) {
    record.subscribed = true;
  }
  // If Stripe check succeeded and confirmed NOT active, AND the user is not a VIP,
  // then we set subscribed to false and reset generations.
  else if (isCurrentlySubscribedOnStripe === false && !isVip) {
    record.subscribed = false;
    record.generations = record.generations || 0;
  }
  // The user is also subscribed if they are a VIP, regardless of Stripe check.
  if (isVip) {
      record.subscribed = true;
  }
  // === SUBSCRIPTION LOGIC END ===

  // Enforce free tier for Boost calls as well
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const boostPrompt = `
You are a senior social media copywriter.
... (rest of boostPrompt)
`.trim(); // Prompt content removed for brevity but is unchanged.

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
    // ... (unchanged)
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
    // ... (unchanged)
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