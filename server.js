require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_TIER_LIMIT = 10;

// === 1. DATABASE CONNECTION ===
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// === 2. CONFIG & UTILS ===
let vipEmails = [];
try {
  vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim());
} catch (e) {
  console.log("No VIP list found or empty.");
}

function isVipEmail(email) {
  if (!email) return false;
  return vipEmails.includes(email.toLowerCase().trim());
}

// Server-side Engagement Scoring Logic
function computeEngagementScore(text, idea, platform, tone) {
    if (!text) return 30;
    const platformKey = (platform || "").toLowerCase();
    const totalWords = text.split(/\s+/).filter(Boolean).length;
    const allHashtags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
    
    let score = 45; // Base score

    // Heuristics
    if (totalWords > 10 && totalWords < 150) score += 10;
    if (allHashtags.length >= 5 && allHashtags.length <= 30) score += 10;
    if (platformKey.includes('instagram') && allHashtags.length > 10) score += 5;
    if (platformKey.includes('linkedin') && tone.toLowerCase().includes('professional')) score += 5;
    if (text.includes('👇') || text.includes('🔗') || text.includes('?')) score += 5; 

    // Random jitter to make it feel "alive"
    score += Math.floor(Math.random() * 5);

    return Math.min(Math.max(score, 10), 95); // Clamp 10-95
}

// === MIDDLEWARE ===
app.use(cors());
// Use JSON parser for everything EXCEPT webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.static('.')); // Serve static files (css, js, images)

// === ROUTES ===

// 1. HOME PAGE
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

// 2. GET /check-subscription
app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
        let user = await User.findOne({ email });
        if (!user) user = await User.create({ email });

        const isVip = isVipEmail(email);
        const isPro = isVip || user.isPro;

        res.json({ 
            isPro: isPro, 
            isVip: isVip,
            freeUses: user.freeGenerations 
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. POST /generate
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email } = req.body;
  if (!idea || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });

    const isVip = isVipEmail(email);
    const isPro = user.isPro || isVip;

    // Enforce Limits
    if (!isPro && user.freeGenerations >= FREE_TIER_LIMIT) {
      return res.status(402).json({ error: 'Limit reached. Please upgrade.' });
    }

    // --- SMART PROMPT LOGIC START ---
    let emojiInstruction = "Use emojis naturally."; // Default

    // Logic: If LinkedIn OR Professional -> Minimal Emojis
    if (platform.toLowerCase().includes('linkedin') || tone.toLowerCase().includes('professional')) {
        emojiInstruction = "Use minimal, professional emojis (max 1 per caption). Focus on clean structure.";
    } 
    // Logic: If Instagram/TikTok OR Fun/Bold -> Heavy Emojis
    else if (platform.toLowerCase().includes('instagram') || platform.toLowerCase().includes('tiktok') || tone.toLowerCase().includes('fun')) {
        emojiInstruction = "Use vibrant emojis often to break up text and add personality. Make it pop!";
    }
    // --- SMART PROMPT LOGIC END ---

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `
Platform: ${platform}
Tone: ${tone}
Post Idea: "${idea}"

Write:
- 5 short, punchy captions (under 280 characters each).
- **Instruction:** ${emojiInstruction}
- 20 relevant, trending hashtags.

Format exactly:
## Captions
1. "..."
2. "..."
3. "..."
4. "..."
5. "..."

## Hashtags
#tag1 #tag2 ...
    `.trim();
    
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 600,
    });
    
    const result = completion.choices[0]?.message?.content || "No result";
    
    // Calculate Score SERVER-SIDE
    const score = computeEngagementScore(result, idea, platform, tone);

    // Update Usage
    if (!isPro) {
      user.freeGenerations += 1;
      await user.save();
    }

    res.json({ result, score });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Generation failed' });
  }
});

// 4. POST /optimize (Boost)
app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, captions, previousScore } = req.body;
  if (!captions || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });

    const isVip = isVipEmail(email);
    const isPro = user.isPro || isVip;

    // Enforce Limits for Boost too
    if (!isPro && user.freeGenerations >= FREE_TIER_LIMIT) {
      return res.status(402).json({ error: 'Limit reached. Please upgrade.' });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const prompt = `
Rewrite these captions to be 10x more viral.
Original Idea: ${idea}
Platform: ${platform}
Tone: ${tone}
Current Captions:
${captions}

Make them punchier, use better hooks, and add 5 more niche hashtags.
Ensure emojis match the tone (${tone}).
    `.trim();

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.9, // Higher creativity
    });

    const result = completion.choices[0]?.message?.content || captions;
    
    // Boosted Score Logic
    let newScore = (previousScore || 50) + Math.floor(Math.random() * 15) + 10;
    if (newScore > 98) newScore = 98;

    // Update Usage
    if (!isPro) {
      user.freeGenerations += 1;
      await user.save();
    }

    res.json({ result, score: newScore });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Optimization failed' });
  }
});

// 5. POST /webhook (Syncs Stripe -> MongoDB)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook sig failed", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle Subscription Events
  try {
      if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
         const session = event.data.object;
         const email = session.customer_email || (session.metadata && session.metadata.user_email);
         if (email) {
             await User.findOneAndUpdate({ email }, { isPro: true, stripeCustomerId: session.customer });
             console.log(`✅ Upgraded user: ${email}`);
         }
      } else if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
         const session = event.data.object;
         const email = session.customer_email || (session.metadata && session.metadata.user_email);
         if (email) {
            // Check if they are VIP before removing Pro
            if (!isVipEmail(email)) {
                await User.findOneAndUpdate({ email }, { isPro: false });
                console.log(`⬇️ Downgraded user: ${email}`);
            }
         }
      }
  } catch (err) {
      console.error("Webhook handler error:", err);
  }

  res.json({ received: true });
});

// 6. CHECKOUT SESSION
app.post('/create-checkout-session', async (req, res) => {
  const { email, referralCode } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
          price: process.env.STRIPE_PRICE_ID, // Ensure this is set in Render Env Vars
          quantity: 1,
      }],
      mode: 'subscription',
      customer_email: email,
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      metadata: { user_email: email, referral_code: referralCode || '' },
      subscription_data: {
        metadata: { user_email: email, referral_code: referralCode || '' }
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// 7. AFFILIATE ROUTES
app.post('/create-connect-account', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: { transfers: { requested: true } },
      metadata: { user_email: email },
    });

    const origin = req.headers.origin || 'https://caption-ai-ze13.onrender.com';
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}?connect_refresh=1`,
      return_url: `${origin}?connect_return=1`,
      type: 'account_onboarding',
    });

    res.json({ connectAccountId: account.id, onboardingUrl: accountLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create Connect account' });
  }
});

app.get('/referral-link', (req, res) => {
  const { referralCode } = req.query;
  if (!referralCode) return res.status(400).json({ error: 'referralCode required' });

  const origin = req.headers.origin || 'https://caption-ai-ze13.onrender.com';
  res.json({ referralUrl: `${origin}?ref=${encodeURIComponent(referralCode)}` });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
