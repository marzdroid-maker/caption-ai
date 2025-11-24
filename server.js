require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Groq } = require('groq-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 3000;

// DATABASE
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// CONFIG
const FREE_TIER_LIMIT = 10;
const AFFILIATE_COMMISSION_PERCENT = 0.30; // 30% Commission

let vipEmails = [];
try { vipEmails = require('./free-pro-users.json').emails.map(e => e.toLowerCase().trim()); } catch (e) {}

function isVipEmail(email) {
  if (!email) return false;
  return vipEmails.includes(email.toLowerCase().trim());
}

function computeEngagementScore(text) {
    if (!text) return 30;
    let score = 45; 
    const totalWords = text.split(/\s+/).filter(Boolean).length;
    const allHashtags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
    if (totalWords > 10 && totalWords < 150) score += 10;
    if (allHashtags.length >= 5) score += 10;
    score += Math.floor(Math.random() * 5);
    return Math.min(Math.max(score, 10), 95); 
}

// MIDDLEWARE
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('.'));

// ROUTES
app.get('/', (req, res) => res.sendFile(__dirname + '/caption.html'));

app.get('/check-subscription', async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    try {
        let user = await User.findOne({ email });
        if (!user) user = await User.create({ email });
        res.json({ isPro: isVipEmail(email) || user.isPro, isVip: isVipEmail(email), freeUses: user.freeGenerations, hasVoice: !!user.brandVoice });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/save-voice', async (req, res) => {
    const { email, samples } = req.body;
    if (!email || !samples) return res.status(400).json({ error: 'Missing data' });
    try {
        let user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!(isVipEmail(email) || user.isPro)) return res.status(402).json({ error: 'Upgrade to Pro.' });

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: `Analyze style of these posts:\n${samples}\nOutput instructions to replicate style.` }],
            model: 'llama-3.3-70b-versatile',
        });
        user.brandVoice = completion.choices[0]?.message?.content || "";
        await user.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Analysis failed' }); }
});

app.post('/delete-voice', async (req, res) => {
    const { email } = req.body;
    try { await User.findOneAndUpdate({ email }, { brandVoice: "" }); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email, useVoice, image } = req.body;
  if ((!idea && !image) || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });
    const isPro = isVipEmail(email) || user.isPro;

    if (!isPro && user.freeGenerations >= FREE_TIER_LIMIT) return res.status(402).json({ error: 'Limit reached' });

    let styleInstruction = "";
    if (useVoice && user.brandVoice) styleInstruction = `STYLE: ${user.brandVoice}`;

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    let model = 'llama-3.3-70b-versatile'; 
    let messages = [];

    if (image) {
        // USING LIVE VISION MODEL (Llama 4)
        model = 'meta-llama/llama-4-scout-17b-16e-instruct'; 
        messages = [{ role: 'user', content: [
            { type: 'text', text: `Platform: ${platform}, Tone: ${tone}. Write 5 viral captions. ${styleInstruction}` },
            { type: 'image_url', image_url: { url: image } } 
        ]}];
    } else {
        messages = [{ role: 'user', content: `Platform: ${platform}, Tone: ${tone}. Idea: ${idea}. Write 5 viral captions. ${styleInstruction}` }];
    }
    
    const completion = await groq.chat.completions.create({ messages, model });
    const result = completion.choices[0]?.message?.content || "No result";
    const score = computeEngagementScore(result);

    if (!isPro) { user.freeGenerations++; await user.save(); }
    res.json({ result, score });

  } catch (err) {
    console.error("Gen Error:", err.message);
    // Handle decommissioned model error gracefully
    if (err.message && err.message.includes("model_decommissioned")) {
         res.status(500).json({ error: "System Upgrade: Model updating. Please try again in 5m." });
    } else {
         res.status(500).json({ error: err.message });
    }
  }
});

app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, captions } = req.body;
  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });
    const isPro = isVipEmail(email) || user.isPro;
    if (!isPro && user.freeGenerations >= FREE_TIER_LIMIT) return res.status(402).json({ error: 'Limit reached' });

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: `Rewrite to be more viral:\n${captions}` }],
      model: 'llama-3.3-70b-versatile',
    });
    
    if (!isPro) { user.freeGenerations++; await user.save(); }
    res.json({ result: completion.choices[0]?.message?.content, score: 85 });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
      const event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      if (event.type === 'checkout.session.completed') {
         const session = event.data.object;
         const email = session.customer_email || session.metadata?.user_email;
         if (email) await User.findOneAndUpdate({ email }, { isPro: true, stripeCustomerId: session.customer });
         
         const referralCode = session.metadata?.referral_code;
         if (referralCode && session.amount_total > 0) {
             await stripe.transfers.create({
                 amount: Math.floor(session.amount_total * AFFILIATE_COMMISSION_PERCENT),
                 currency: 'usd',
                 destination: referralCode,
             }).catch(e => console.error('Transfer failed', e));
         }
      }
  } catch (err) { console.error(err); }
  res.json({ received: true });
});

app.post('/create-checkout-session', async (req, res) => {
  const { email, referralCode } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      success_url: `${req.headers.origin}?success=true`,
      cancel_url: `${req.headers.origin}?canceled=true`,
      metadata: { user_email: email, referral_code: referralCode || '' },
      subscription_data: { metadata: { user_email: email, referral_code: referralCode || '' } }
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/create-connect-account', async (req, res) => {
  try {
    const account = await stripe.accounts.create({ type: 'express', email: req.body.email, capabilities: { transfers: { requested: true }, card_payments: { requested: true } } });
    const link = await stripe.accountLinks.create({ account: account.id, refresh_url: 'https://example.com', return_url: 'https://example.com', type: 'account_onboarding' });
    res.json({ connectAccountId: account.id, onboardingUrl: link.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/referral-link', (req, res) => {
  res.json({ referralUrl: `${req.headers.origin || 'https://caption-ai-ze13.onrender.com'}?ref=${encodeURIComponent(req.query.referralCode)}` });
});

app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
