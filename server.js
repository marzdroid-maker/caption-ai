require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG ===
const FREE_TIER_LIMIT = 10; // 🔟 free generations per email
const AFFILIATE_COMMISSION_RATE = 0.30; // 30% commission
const SUBSCRIPTION_PRICE_ID = process.env.STRIPE_SUBSCRIPTION_PRICE_ID; // Ensure this is set in .env!

// Load VIP emails and define helper functions
const vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim());
console.log(`VIP list loaded. Found ${vipEmails.length} VIP emails.`);

function isVipEmail(email) {
  const key = email.toLowerCase().trim();
  return vipEmails.includes(key);
}

// === DATABASE SETUP (for Affiliate/Referral Persistence) ===
// Use a persistent file-based DB for critical data
const db = new Database(path.join(__dirname, 'caption_ai.db'));

// Create tables if they don't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS affiliates (
        email TEXT PRIMARY KEY,
        stripe_account_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS referrals (
        referred_email TEXT PRIMARY KEY,
        referrer_email TEXT NOT NULL
    );
`);

// Prepared statements for affiliate logic
const getAffiliateStmt = db.prepare('SELECT stripe_account_id FROM affiliates WHERE email = ?');
const setAffiliateStmt = db.prepare('INSERT OR REPLACE INTO affiliates (email, stripe_account_id) VALUES (?, ?)');
const getReferrerStmt = db.prepare('SELECT referrer_email FROM referrals WHERE referred_email = ?');
const setReferralStmt = db.prepare('INSERT OR IGNORE INTO referrals (referred_email, referrer_email) VALUES (?, ?)');

// Helper function to get the referrer's Stripe Account ID
function getReferrerStripeAccountId(referredEmail) {
    const referrerRecord = getReferrerStmt.get(referredEmail.toLowerCase());
    if (!referrerRecord) return null;

    const affiliateRecord = getAffiliateStmt.get(referrerRecord.referrer_email);
    return affiliateRecord ? affiliateRecord.stripe_account_id : null;
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

// === IN-MEMORY USAGE TRACKING (for session/generations only) ===
const usage = {};
// ... (rest of usage functions and Groq setup remain the same) ...


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
    // ... (Your existing function body remains the same) ...
    // NOTE: For brevity, I am not duplicating your existing function body.
    // Ensure your existing refreshStripeSubscriptionStatus function is here.
    try {
        const customers = await stripe.customers.list({ email });
        if (customers.data.length === 0) return false;

        const customer = customers.data[0];
        const subscriptions = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1,
        });

        return subscriptions.data.length > 0;
    } catch (e) {
        console.error('Stripe status check failed:', e.message);
        return false;
    }
}


// === AFFILIATE ENDPOINTS ===

/**
 * Endpoint for an affiliate to register their Stripe Connect Account ID
 */
app.post('/affiliate-onboard', (req, res) => {
    const { email, stripeAccountId } = req.body;
    if (!email || !stripeAccountId) {
        return res.status(400).json({ error: 'Email and Stripe Account ID required' });
    }
    
    try {
        setAffiliateStmt.run(email.toLowerCase(), stripeAccountId);
        console.log(`Affiliate onboarded: ${email} with Account ID: ${stripeAccountId}`);
        res.json({ success: true, message: 'Affiliate account saved.' });
    } catch (e) {
        console.error('Affiliate onboard error:', e);
        res.status(500).json({ error: 'Failed to save affiliate account.' });
    }
});

/**
 * Endpoint to check if a user is an affiliate and get their Stripe Account ID
 */
app.get('/check-affiliate', (req, res) => {
    const email = req.query.email;
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    const record = getAffiliateStmt.get(email.toLowerCase());
    if (record) {
        res.json({ isAffiliate: true, stripeAccountId: record.stripe_account_id });
    } else {
        res.json({ isAffiliate: false });
    }
});

// ... (Your existing /generate and /check-subscription routes remain the same) ...
app.post('/generate', async (req, res) => {
    // ... (Your existing /generate function body remains the same) ...
    const { idea, platform, tone, email, currentGenerations } = req.body || {}; 

    if (!idea || !platform || !tone || !email) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    // ... (Your existing subscription/free-tier logic remains the same) ...
    
    // Enforce free tier
    // ... (Your existing free-tier check remains the same) ...
    
    try {
        // ... (Your existing Groq AI call remains the same) ...
        const completion = await groq.chat.completions.create({
            model: "mixtral-8x7b-instruct",
            temperature: 0.7,
            max_tokens: 1500,
            messages: [
                // ... (Your existing message structure remains the same) ...
            ]
        });

        const result = completion.choices[0]?.message?.content || 'No result found.';
        
        // ... (Your existing scoring/response logic remains the same) ...
        res.json({ result: result, generationsLeft: record.subscribed ? 'unlimited' : (FREE_TIER_LIMIT - record.generations) });

    } catch (e) {
        // ... (Your existing error handling remains the same) ...
        console.error('AI Generation Error:', e);
        res.status(500).json({ error: 'AI generation failed' });
    }
});

app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);
    const isVip = isVipEmail(email);

    res.json({ isPro: isCurrentlySubscribedOnStripe, vip: isVip });
});


// === STRIPE CHECKOUT MODIFICATION (ADD REFERRAL) ===
app.post('/create-checkout-session', async (req, res) => {
    const { email, referralCode } = req.body || {}; // <-- NOW ACCEPTING referralCode

    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        // Look up or create customer
        let customer;
        const customers = await stripe.customers.list({ email });
        if (customers.data.length > 0) {
            customer = customers.data[0];
        } else {
            customer = await stripe.customers.create({ email });
        }

        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: SUBSCRIPTION_PRICE_ID, // Use your Stripe Price ID
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: req.headers.origin + '/?success=true',
            cancel_url: req.headers.origin + '/?canceled=true',
            subscription_data: {
                // Pass the referral code AND the user's email into metadata
                metadata: {
                    user_email: email,
                    referral_code: referralCode || '' // Store the referrer's email
                }
            }
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Stripe Error (checkout):', err.message);
        res.status(500).json({ error: 'Checkout failed' });
    }
});


// === STRIPE WEBHOOK MODIFICATION (ADD COMMISSION TRANSFER) ===
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
        case 'checkout.session.completed':
            {
                const session = event.data.object;
                const customerEmail = session.customer_details.email || session.metadata.user_email;
                const referralCode = session.metadata.referral_code;

                if (customerEmail) {
                    const key = customerEmail.toLowerCase().trim();
                    usage[key] = { generations: 0, subscribed: true };
                    console.log(`User subscribed: ${customerEmail}`);
                    
                    // 1. RECORD REFERRAL
                    if (referralCode) {
                        setReferralStmt.run(customerEmail.toLowerCase(), referralCode.toLowerCase());
                        console.log(`Referral recorded: ${customerEmail} referred by ${referralCode}`);
                    }
                }
                
                // FALL THROUGH to handle commission immediately after first payment
            }
        // Intentional fallthrough for both first payment (session completed) and recurring payments (invoice paid)
        case 'invoice.paid':
            {
                const invoice = event.data.object;
                const customerEmail = invoice.customer_email;
                const amount = invoice.amount_paid; // Amount in cents

                if (customerEmail && amount > 0) {
                    // 2. CHECK FOR REFERRER
                    const referrerStripeAccountId = getReferrerStripeAccountId(customerEmail);

                    if (referrerStripeAccountId) {
                        const commissionAmount = Math.round(amount * AFFILIATE_COMMISSION_RATE); // 30% of payment
                        
                        try {
                            // 3. CREATE STRIPE TRANSFER (Payout the commission)
                            await stripe.transfers.create({
                                amount: commissionAmount,
                                currency: 'usd', // Assuming USD
                                destination: referrerStripeAccountId,
                                metadata: {
                                    customer_email: customerEmail,
                                    invoice_id: invoice.id,
                                }
                            });
                            console.log(`Commission of $${(commissionAmount / 100).toFixed(2)} transferred to affiliate ${referrerStripeAccountId} for user ${customerEmail}`);
                        } catch (transferError) {
                            console.error('Stripe Transfer failed:', transferError.message);
                            // Log the error but continue, as the subscription is still valid
                        }
                    }
                }
            }
            break;

        case 'invoice.payment_failed': 
            {
                // ... (Your existing payment_failed logic remains the same) ...
                const invoice = event.data.object;
                const email = invoice.customer_email || (invoice.metadata ? invoice.metadata.user_email : null);

                if (email && !isVipEmail(email)) {
                    const { key, record } = getUserUsage(email);
                    record.subscribed = false;
                    record.generations = 0;
                    console.log(`Subscription payment failed. User downgraded: ${email}`);
                }
            }
            break;
            
        case 'customer.subscription.deleted':
            {
                const subscription = event.data.object;
                // You can add logic here to mark the user as unsubscribed if needed, though invoice.payment_failed should cover most cases
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
  // Your live and webhook URLs here
});