const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
// const Database = require('better-sqlite3'); // <-- Ensure this module is NOT required
const { Groq } = require('groq-sdk');
const stripe = require('stripe');

dotenv.config();

// --- Configuration ---
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FREE_TIER_LIMIT = 10;

if (!STRIPE_KEY || !GROQ_API_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// Initialize clients
const groq = new Groq({ apiKey: GROQ_API_KEY });
const stripeClient = stripe(STRIPE_KEY);
const app = express();
const PORT = process.env.PORT || 3000;

// In-memory data store for usage 
const usage = {};
const VIP_EMAILS = ['admin@caption.ai', 'vip@test.com'];

// --- Utility Functions (Mocking a database) ---

function isVipEmail(email) {
    return VIP_EMAILS.includes(email.toLowerCase());
}

function getUserUsage(email) {
    const key = email.toLowerCase().trim();
    if (!usage[key]) {
        usage[key] = { subscribed: false, generations: 0, lastCheck: 0 };
    }
    return { key, record: usage[key] };
}

async function refreshStripeSubscriptionStatus(email) {
    const { record } = getUserUsage(email);
    
    if (record.subscribed && (Date.now() - record.lastCheck < (1000 * 60 * 60 * 24))) {
        return true;
    }

    record.lastCheck = Date.now();
    return record.subscribed; 
}


// --- Middleware ---
app.use(cors({
    origin: ['http://localhost:8080', 'http://127.0.0.1:5500', 'https://caption-ai-ze13.onrender.com'], 
    methods: 'GET,POST',
    allowedHeaders: 'Content-Type',
}));

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // ... (Stripe webhook logic is omitted for brevity but would go here) ...
    res.json({ received: true });
});

app.use(express.json());


// --- API Endpoints ---

// 1. Check Subscription Status
app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    const isVipUser = isVipEmail(email);
    const isSubscribed = await refreshStripeSubscriptionStatus(email);

    res.json({ isPro: isSubscribed || isVipUser, vip: isVipUser });
});


// 2. Generate Content (Core AI Logic)
app.post('/generate', async (req, res) => {
    const { idea, platform, tone, email, currentGenerations } = req.body || {};

    if (!idea || !platform || !tone || !email) {
        return res.status(400).json({ error: 'All fields required' });
    }

    const { key, record } = getUserUsage(email);

    if (record.generations === 0) {
        record.generations = parseInt(currentGenerations) || 0; 
    }
    
    const isVipUser = isVipEmail(email);
    const isCurrentlySubscribed = await refreshStripeSubscriptionStatus(email);
    
    if (isCurrentlySubscribed) {
        record.subscribed = true;
    } else if (!isVipUser) {
        record.subscribed = false;
        record.generations = record.generations || 0; 
    }

    if (isVipUser) {
        record.subscribed = true;
    }
    
    if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
        return res.status(402).json({ error: 'Upgrade required' });
    }

    record.generations += 1;
    usage[key] = record; 
    
    const systemPrompt = `You are a viral social media content generator. Your task is to turn a simple "Post Idea" into a set of 5 professional, viral-ready caption options and a block of 30 highly relevant hashtags.

Instructions:
1. Generate 5 distinct caption ideas (numbered 1-5).
2. The captions must match the requested Tone and Platform.
3. Incorporate engaging elements (questions, hooks, emojis, CTAs).
4. After the 5 captions, include a single "## Hashtags" section.
5. Provide exactly 30 hashtags, separated by spaces. Use a mix of broad, medium, and niche tags.
6. The final output MUST contain only the captions and hashtags. Do not include any introductory or concluding text outside of the requested format.

Example Format:
## Captions
1. [Caption 1 text]
2. [Caption 2 text]
3. [Caption 3 text]
4. [Caption 4 text]
5. [Caption 5 text]

## Hashtags
#hashtag1 #hashtag2 #hashtag3 ... #hashtag30
`;
    
    const userPrompt = `Post Idea: ${idea}\nPlatform: ${platform}\nTone: ${tone}`;

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            model: "mixtral-8x7b-32768", 
            temperature: 0.7,
        });

        const result = completion.choices[0]?.message?.content || 'No result generated.';
        
        res.json({ result, newGenerationsCount: record.generations, isPro: record.subscribed, vip: isVipUser }); 

    } catch (err) {
        console.error("GROQ API Error:", err);
        record.generations -= 1; 
        usage[key] = record;
        res.status(500).json({ error: 'AI generation failed.' });
    }
});


// 3. Optimize Content (Boost Score)
app.post('/optimize', async (req, res) => {
    const { idea, platform, tone, email, captions, currentGenerations } = req.body || {};

    if (!captions || !email) {
        return res.status(400).json({ error: 'Captions and email required' });
    }

    const { key, record } = getUserUsage(email);

    if (record.generations === 0) {
        record.generations = parseInt(currentGenerations) || 0; 
    }
    
    const isVipUser = isVipEmail(email);
    const isCurrentlySubscribed = await refreshStripeSubscriptionStatus(email);
    
    if (isCurrentlySubscribed) {
        record.subscribed = true;
    } else if (!isVipUser) {
        record.subscribed = false;
        record.generations = record.generations || 0; 
    }

    if (isVipUser) {
        record.subscribed = true;
    }
    
    if (!record.subscribed && record.generations >= FREE_TIER_LIMIT) {
        return res.status(402).json({ error: 'Upgrade required' });
    }

    record.generations += 1;
    usage[key] = record; 
    
    const systemPrompt = `You are a viral social media optimization engine. Your task is to take a set of existing captions and hashtags and *improve* them for maximum engagement (saves, comments, shares) based on the target platform and tone.

Instructions for Optimization:
1. Improve the hook of each caption (the first sentence) for better scroll-stopping power.
2. Ensure there is a strong, specific Call-to-Action (CTA) in at least 3 of the 5 captions.
3. Optimize the hashtag list for maximum niche relevance and discoverability. You must return exactly 30 hashtags.
4. Maintain the original structure of 5 numbered captions followed by the "## Hashtags" block.
5. The output MUST ONLY contain the revised captions and hashtags.

Original Post Idea: ${idea}
Target Platform: ${platform}
Target Tone: ${tone}
`;
    
    const userPrompt = `REVISE THESE CAPTIONS AND HASHTAGS:\n\n${captions}`;

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            model: "mixtral-8x7b-32768",
            temperature: 0.8,
        });

        const result = completion.choices[0]?.message?.content || 'Optimization failed.';
        
        res.json({ result, newGenerationsCount: record.generations, isPro: record.subscribed, vip: isVipUser });

    } catch (err) {
        console.error("GROQ API Error:", err);
        record.generations -= 1; 
        usage[key] = record;
        res.status(500).json({ error: 'AI optimization failed.' });
    }
});


// 4. Stripe Checkout Session Creation
app.post('/create-checkout-session', async (req, res) => {
    const { email, referralCode } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    const YOUR_DOMAIN = 'https://caption-ai-ze13.onrender.com';

    try {
        const priceId = 'price_1P3y9eJ4tK7L6t8VfR6X0F2g'; // Example price ID for $7/month

        const session = await stripeClient.checkout.sessions.create({
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            customer_email: email, 
            success_url: `${YOUR_DOMAIN}?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${YOUR_DOMAIN}?canceled=true`,
            metadata: {
                referral_code: referralCode || 'none',
                user_email: email,
            },
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).json({ error: 'Failed to create Stripe checkout session.' });
    }
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});