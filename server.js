require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email
const AFFILIATE_COMMISSION_RATE = 0.30; // 30% commission rate

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
// NOTE: For production, this should be a database (e.g., MongoDB, PostgreSQL)
const usage = {};

// === AFFILIATE TRACKING (In-Memory Simulation of DB) ===
// Stores { email: stripeAccountId } for quick webhook lookup
const affiliateAccounts = {}; 

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

// === AFFILIATE HELPER: Finds the Connect Account ID from the affiliate email ===
async function getAffiliateStripeId(email) {
  const key = email.toLowerCase().trim();
  
  // 1. Try in-memory cache
  if (affiliateAccounts[key]) {
    return affiliateAccounts[key];
  }

  // 2. Search Stripe Connect accounts (Fallback/Hydration for server restart)
  // This is a slow operation, a database is highly recommended for production
  try {
    const accounts = await stripe.accounts.list({ 
        limit: 100, // Adjust based on your expected number of affiliates
    });
    
    // Find account by metadata email (set during /create-connect-account)
    const affiliateAccount = accounts.data.find(a => 
      a.metadata && a.metadata.user_email && a.metadata.user_email.toLowerCase().trim() === key
    );

    if (affiliateAccount) {
        affiliateAccounts[key] = affiliateAccount.id; // Cache it
        return affiliateAccount.id;
    }
    return null;
  } catch(e) {
      console.error('Error listing Stripe accounts for lookup:', e.message);
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

// Route for creating a Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { email, referralCode } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        
        // 1. Look up or create the Stripe Customer
        let customer;
        const customers = await stripe.customers.list({ email, limit: 1 });
        if (customers.data.length > 0) {
            customer = customers.data[0];
        } else {
            customer = await stripe.customers.create({ email });
        }

        // 2. Create the Checkout Session
        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            mode: 'subscription',
            line_items: [
                {
                    price: process.env.STRIPE_PRO_PRICE_ID, // Ensure you set this environment variable
                    quantity: 1,
                },
            ],
            // Success and Cancel URLs should redirect back to your app
            success_url: `${process.env.APP_BASE_URL || 'https://caption-ai-ze13.onrender.com'}?success=true`,
            cancel_url: `${process.env.APP_BASE_URL || 'https://caption-ai-ze13.onrender.com'}?cancel=true`,

            // CRITICAL: Pass the referral code via metadata
            subscription_data: {
                metadata: {
                    user_email: email,
                    // If referralCode is empty, it will be an empty string, which is fine
                    referred_by_email: referralCode.toLowerCase().trim() || 'none', 
                },
            },
        });

        res.json({ url: session.url });

    } catch (err) {
        console.error('Stripe Error (checkout):', err.message);
        res.status(500).json({ error: 'Checkout failed' });
    }
});

// Step 1 Affiliate route: create a Stripe Connect Express account for payouts
app.post('/create-connect-account', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    const key = email.toLowerCase().trim();

    // Create an Express Connect account for this user
    const account = await stripe.accounts.create({
      type: 'express',
      email: key, // Use lowercased, trimmed email
      capabilities: {
        transfers: { requested: true },
      },
      metadata: {
        user_email: key, // Store the email in metadata for lookup
      },
    });
    
    // Store the account ID in our memory map for quick lookups later (simulating DB)
    affiliateAccounts[key] = account.id;

    const origin =
      process.env.APP_BASE_URL ||
      'https://caption-ai-ze13.onrender.com';

    // Create an onboarding link so the user can finish setting up payouts
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}/affiliate-onboarding-failed.html`,
      return_url: `${origin}/affiliate-onboarding-success.html`,
      type: 'account_onboarding',
    });

    return res.json({
      connectAccountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (err) {
    console.error('Create Connect Account Error:', err.message);
    return res.status(500).json({ error: 'Failed to create Connect account' });
  }
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
  } else if (isCurrentlySubscribedOnStripe === false && !isVip) {
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

  // AI Prompt Logic
  const PROMPT = `
    You are a senior viral social media copywriter. Your task is to generate 5 distinct, high-performing captions and 30 relevant hashtags based on the user's idea.
    Platform: ${platform}
    Tone: ${tone}
    Post Idea: "${idea}"

    Guidelines:
    1. Output MUST be ONLY the captions and hashtags in one block of text.
    2. Start each caption with a strong hook relevant to the platform.
    3. Include a call-to-action (CTA) in at least 3 of the 5 captions.
    4. Provide exactly 30 unique, highly relevant, and varied hashtags at the end of the text.
    5. The captions should be optimized for the platform:
       - Instagram: Punchy, visually-driven language. Encourage saving/sharing.
       - Twitter: Short, provocative, and conversational.
       - LinkedIn: Professional, insightful, and focused on business/career growth.
       - TikTok: Very short, high-energy, and often uses emojis to hook.

    Format your response cleanly with line breaks between captions and hashtags.
  `;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: PROMPT,
        },
      ],
      model: 'mixtral-8x7b-32768', 
      temperature: 0.8,
    });

    // Increment usage only on successful AI generation
    record.generations += 1;
    usage[key] = record;
    
    res.json({ result: chatCompletion.choices[0]?.message?.content });

  } catch (error) {
    console.error('Groq API Error:', error);
    res.status(500).json({ error: 'Failed to generate captions. Please try again.' });
  }
});

// Optimize captions
app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, captions, previousScore } = req.body || {};

  if (!captions || !email) {
    return res.status(400).json({ error: 'All required fields must be provided' });
  }

  const { key, record } = getUserUsage(email);

  // Subscription check is critical for the Boost feature
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);
  
  if (isCurrentlySubscribedOnStripe === true) {
    record.subscribed = true;
  } else if (isCurrentlySubscribedOnStripe === false && !isVip) {
    record.subscribed = false;
  }

  if (isVip) {
    record.subscribed = true;
  }

  // Enforce free tier for Boost calls as well
  if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
    return res.status(402).json({ error: 'Upgrade required' });
  }
  
  // No need to increment counter as this is a follow-up action.
  
  const boostPrompt = `
    You are a senior viral social media copywriter. Your task is to take the user's existing captions and REWRITE them for higher engagement.
    Platform: ${platform}
    Tone: ${tone}
    Original Idea: "${idea}"
    Previous Captions: ${captions}

    Your goals:
    - Improve hooks dramatically
    - Make each caption more scroll-stopping
    - Tailor style to the platform (Instagram = punchy, hashtag-rich, high-save potential)
    - Increase emotional impact, clarity, and shareability
    - Maintain professionalism and original message, but make it go viral.

    Output MUST be ONLY the rewritten captions and hashtags in one block of text.
  `;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: boostPrompt,
        },
      ],
      model: 'mixtral-8x7b-32768', 
      temperature: 0.8,
    });

    res.json({ result: chatCompletion.choices[0]?.message?.content });

  } catch (error) {
    console.error('Groq API Error (Boost):', error);
    res.status(500).json({ error: 'Failed to optimize captions. Please try again.' });
  }
});

// Stripe webhook to mark user as subscribed and process affiliate transfers
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Ensure this is set
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      endpointSecret
    );
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'invoice.payment_succeeded': 
        {
            const invoice = event.data.object;
            // Get email from invoice (or metadata if customer_email isn't directly present on invoice)
            const email = invoice.customer_email || (invoice.metadata ? invoice.metadata.user_email : null);
            
            // Get the subscription metadata to find the referrer
            const subscriptionId = invoice.subscription;
            let referredByEmail = 'none';

            if (subscriptionId) {
                try {
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    referredByEmail = subscription.metadata.referred_by_email || 'none';
                } catch (subErr) {
                    console.error('Error retrieving subscription for webhook:', subErr.message);
                }
            }


            if (email) {
                const key = email.toLowerCase().trim();
                // Mark as subscribed and reset generations upon successful payment
                usage[key] = { generations: 0, subscribed: true };
                console.log(`User subscribed: ${email}`);

                // AFFILIATE COMMISSION LOGIC
                if (referredByEmail && referredByEmail !== 'none') {
                    console.log(`Processing commission for: ${referredByEmail}`);
                    const affiliateStripeAccountId = await getAffiliateStripeId(referredByEmail);

                    if (affiliateStripeAccountId) {
                        // Amount is in cents. Calculate 30% commission.
                        const totalAmountPaid = invoice.amount_paid; 
                        // Note: Stripe sometimes applies discounts/coupons before calculating amount_paid
                        const amountToTransfer = Math.round(totalAmountPaid * AFFILIATE_COMMISSION_RATE); 

                        // Ensure transfer amount is positive
                        if (amountToTransfer > 50) { // Min 50 cents transfer to avoid micro-fees
                            try {
                                await stripe.transfers.create({
                                    amount: amountToTransfer,
                                    currency: invoice.currency, // 'usd' in most cases
                                    destination: affiliateStripeAccountId,
                                    // Linking the transfer to the original charge is best practice
                                    source_transaction: invoice.charge, 
                                    metadata: {
                                        original_invoice_id: invoice.id,
                                        referral_email: referredByEmail,
                                        commission_rate: AFFILIATE_COMMISSION_RATE.toString(),
                                    },
                                });
                                console.log(`SUCCESS: Paid $${amountToTransfer / 100} commission to affiliate: ${referredByEmail}`);
                            } catch (transferErr) {
                                console.error('Stripe Transfer Error:', transferErr.message);
                                // You should log this error and follow up manually
                            }
                        } else {
                             console.log(`Skipped affiliate transfer. Amount too low or zero: ${amountToTransfer}`);
                        }
                    } else {
                        console.log(`WARN: Affiliate account not found for email: ${referredByEmail}`);
                    }
                }
            }
        }
        break;

    case 'invoice.payment_failed': 
        {
            const invoice = event.data.object;
            // Get email from invoice (or metadata if customer_email isn't directly present on invoice)
            const email = invoice.customer_email || (invoice.metadata ? invoice.metadata.user_email : null);

            if (email && !isVipEmail(email)) { // Do not reset VIP status
                const { key, record } = getUserUsage(email);
                record.subscribed = false;
                record.generations = 0; // Reset count as access is revoked
                console.log(`Subscription payment failed. User downgraded: ${email}`);
            }
        }
        break;

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