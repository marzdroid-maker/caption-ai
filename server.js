require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email

// Load VIP emails and define helper functions
const vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim());
console.log(`VIP list loaded. Found ${vipEmails.length} VIP emails.`);

function isVipEmail(email) {
  const key = email.toLowerCase().trim();
  return vipEmails.includes(key);
}

// === MIDDLEWARE ===
app.use(cors());
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

function getUserUsage(email) {
  const key = email.toLowerCase().trim();
  if (!usage[key]) {
    const isVip = isVipEmail(email);
    usage[key] = { generations: 0, subscribed: isVip };
  }
  return { key, record: usage[key] };
}

async function refreshStripeSubscriptionStatus(email) {
  try {
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
    return null; 
  }
}

// === ROUTES ===

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
        const isStripeSubscribed = await refreshStripeSubscriptionStatus(email);
        if (isStripeSubscribed === true) {
            isPro = true;
        }
    }

    res.json({ 
        isPro: isPro,
        isVip: isVip,
    });
});

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

  // Subscription Logic
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
  const { idea, platform, tone, email, captions, previousScore } = req.body || {};

  if (!idea || !platform || !tone || !email || !captions) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { key, record } = getUserUsage(email);

  // Subscription Logic
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

  // Enforce free tier for Boost calls as well
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }

  record.generations += 1;
  usage[key] = record;

  const boostPrompt = `
You are a senior viral social media copywriter.

Your task is to take the user's existing captions and REWRITE them for higher engagement.

Platform: ${platform}
Tone: ${tone}
Original Idea: "${idea}"
Previous Captions:
${captions}

Your goals:
- Improve hooks dramatically
- Make each caption more scroll-stopping
- Tailor style to the platform (Instagram = punchy, hashtag-rich, high-save potential)
- Increase emotional impact, clarity, and shareability
- Maintain professionalism if tone = Professional
- Remove generic filler
- Add variation across captions
- Keep all captions under 280 characters

When rewriting:
- Produce *5 improved captions*
- Produce *30 optimized hashtags* based on the topic
- Ensure hashtags are trending, niche-targeted, and relevant
- Do NOT explain what you are doing
- Do NOT output anything except the improved captions and hashtags

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


// --- Create a Stripe Connect account for a user (to receive referral payouts) ---
app.post('/create-connect-account', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // Create an Express Connect account for this user
    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        transfers: { requested: true }
      },
      metadata: {
        user_email: email
      }
    });

    // Generate an onboarding link so they can complete KYC and enable payouts
    const origin = req.headers.origin || process.env.APP_BASE_URL || 'https://example.com';
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}/connect/onboarding/refresh`,
      return_url: `${origin}/connect/onboarding/complete`,
      type: 'account_onboarding'
    });

    // We use the Connect account ID as the referral code
    const referralCode = account.id;

    return res.json({
      connectAccountId: account.id,
      referralCode,
      onboardingUrl: accountLink.url
    });
  } catch (err) {
    console.error('Create Connect account error:', err.message);
    return res.status(500).json({ error: 'Failed to create Connect account' });
  }
});

// --- Simple endpoint to get a referral link for a given referralCode ---
app.get('/referral-link', (req, res) => {
  const referralCode = req.query.referralCode;
  if (!referralCode) {
    return res.status(400).json({ error: 'referralCode query parameter required' });
  }

  const origin = req.headers.origin || process.env.APP_BASE_URL || 'https://example.com';
  const referralUrl = `${origin}/?ref=${encodeURIComponent(referralCode)}`;
  return res.json({ referralUrl });
});

// Stripe webhook to mark user as subscribed (REVISED LOGIC to handle payment failed)
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
  
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email || (session.metadata ? session.metadata.user_email : null);

      if (email) {
        const key = email.toLowerCase().trim();
        // Mark as subscribed and reset generations upon successful payment
        usage[key] = { generations: 0, subscribed: true };
        console.log(`User subscribed via checkout.session.completed: ${email}`);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const email = invoice.customer_email || (invoice.metadata ? invoice.metadata.user_email : null);

      // Mark as subscribed in our in-memory usage map
      if (email) {
        const key = email.toLowerCase().trim();
        usage[key] = { generations: 0, subscribed: true };
        console.log(`User subscription payment succeeded: ${email}`);
      }

      // --- Referral commission logic (30% via Stripe Connect) ---
      try {
        const subscriptionId = invoice.subscription;
        if (subscriptionId) {
          // Retrieve subscription to access metadata, including referral_code
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const referralCode = subscription.metadata && subscription.metadata.referral_code;

          // We treat referralCode as the Stripe Connect account ID (e.g. acct_xxx)
          if (referralCode && referralCode.startsWith('acct_')) {
            const amountPaid = invoice.amount_paid; // in smallest currency unit (e.g. cents)
            const currency = invoice.currency || 'usd';

            // 30% commission
            const commissionAmount = Math.round(amountPaid * 0.30);

            if (commissionAmount > 0) {
              await stripe.transfers.create({
                amount: commissionAmount,
                currency,
                destination: referralCode,
                metadata: {
                  referral_code: referralCode,
                  subscription_id: subscriptionId,
                  invoice_id: invoice.id,
                  type: 'referral_commission_30_percent'
                }
              });

              console.log(
                `Referral commission sent: ${commissionAmount} ${currency} to ${referralCode} for subscription ${subscriptionId}`
              );
            }
          }
        }
      } catch (err) {
        console.error('Referral commission error (invoice.payment_succeeded):', err.message);
      }

      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const email = invoice.customer_email || (invoice.metadata ? invoice.metadata.user_email : null);

      if (email && !isVipEmail(email)) { // Do not reset VIP status
        const { key, record } = getUserUsage(email);
        record.subscribed = false;
        record.generations = 0; // Reset count as access is revoked
        console.log(`Subscription payment failed. User downgraded: ${email}`);
      }
      break;
    }

    default:
      // No action needed for other events
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