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

function computeEngagementScore(text, idea, platform, tone) {
    if (!text) return 30;
    const platformKey = (platform || "").toLowerCase();
    const totalWords = text.split(/\s+/).filter(Boolean).length;
    const allHashtags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
    
    let score = 45; 
    if (totalWords > 10 && totalWords < 150) score += 10;
    if (allHashtags.length >= 5 && allHashtags.length <= 30) score += 10;
    if (platformKey.includes('instagram') && allHashtags.length > 10) score += 5;
    if (platformKey.includes('linkedin') && tone.toLowerCase().includes('professional')) score += 5;
    if (text.includes('👇') || text.includes('🔗') || text.includes('?')) score += 5; 
    score += Math.floor(Math.random() * 5);
    return Math.min(Math.max(score, 10), 95); 
}

// === MIDDLEWARE ===
app.use(cors());

// INCREASED LIMIT TO 50MB FOR IMAGE UPLOADS
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json({ limit: '50mb' })(req, res, next); // <--- CHANGED
  }
});
app.use(express.static('.'));

// === ROUTES ===

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/caption.html');
});

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
            freeUses: user.freeGenerations,
            hasVoice: !!user.brandVoice
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Save Voice
app.post('/save-voice', async (req, res) => {
    const { email, samples } = req.body;
    if (!email || !samples) return res.status(400).json({ error: 'Missing data' });

    try {
        let user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const isVip = isVipEmail(email);
        const isPro = user.isPro || isVip;

        if (!isPro) return res.status(402).json({ error: 'Upgrade to Pro to use Style Thief.' });

        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const analysisPrompt = `
        Analyze these social media posts and extract a "Voice Profile" instructions list.
        Identify: Sentence length, emoji usage frequency, slang, tone, and structure.
        
        POST SAMPLES:
        "${samples}"

        Output ONLY the instructions to give to an AI to replicate this style. Start with "Write in a style that is..."
        `;

        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: analysisPrompt }],
            model: 'llama-3.3-70b-versatile',
        });

        const voiceProfile = completion.choices[0]?.message?.content || "";
        
        user.brandVoice = voiceProfile;
        await user.save();

        res.json({ success: true, voiceProfile });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Voice analysis failed' });
    }
});

app.post('/delete-voice', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
        await User.findOneAndUpdate({ email }, { brandVoice: "" });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to delete voice' });
    }
});

// === VISION ENABLED GENERATE ROUTE ===
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email, useVoice, image } = req.body; // Added 'image'
  
  // If image is present, 'idea' is optional. If no image, 'idea' is required.
  if ((!idea && !image) || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });

    const isVip = isVipEmail(email);
    const isPro = user.isPro || isVip;

    if (!isPro && user.freeGenerations >= FREE_TIER_LIMIT) {
      return res.status(402).json({ error: 'Limit reached. Please upgrade.' });
    }

    // Style Logic
    let styleInstruction = "";
    if (useVoice && user.brandVoice) {
        styleInstruction = `⚠️ IMPORTANT: Ignore the standard tone. ${user.brandVoice}`;
    } else {
        if (platform.toLowerCase().includes('linkedin') || tone.toLowerCase().includes('professional')) {
            styleInstruction = "Use minimal, professional emojis. Focus on clean structure.";
        } else if (platform.toLowerCase().includes('instagram') || tone.toLowerCase().includes('fun')) {
            styleInstruction = "Use vibrant emojis often. Make it pop!";
        }
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    
    let messages = [];
    let model = 'llama-3.3-70b-versatile'; // Default text model

    // VISION LOGIC
    if (image) {
        model = 'llama-3.2-11b-vision-preview'; // Vision model
        const userPrompt = `
        Platform: ${platform}
        Tone: ${tone}
        Context/Idea: ${idea || "Describe the image"}
        
        Write 5 viral social media captions based on this image.
        ${styleInstruction}
        Include 20 trending hashtags.
        Format exactly: ## Captions (numbered list) ## Hashtags.
        `;

        messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: userPrompt },
                    { type: 'image_url', image_url: { url: image } } // Base64 Image
                ]
            }
        ];
    } else {
        // STANDARD TEXT LOGIC
        const prompt = `
        Platform: ${platform}
        Tone: ${tone}
        Post Idea: "${idea}"

        Write:
        - 5 short, punchy captions (under 280 characters each).
        - **Style Instruction:** ${styleInstruction}
        - 20 relevant, trending hashtags.

        Format exactly:
        ## Captions
        1. "..."
        ...
        ## Hashtags
        #tag1 ...
        `.trim();
        
        messages = [{ role: 'user', content: prompt }];
    }
    
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: model,
      temperature: 0.7,
      max_tokens: 1024,
    });
    
    const result = completion.choices[0]?.message?.content || "No result";
    const score = computeEngagementScore(result, idea || "image", platform, tone);

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

app.post('/optimize', async (req, res) => {
  const { idea, platform, tone, email, captions, previousScore } = req.body;
  if (!captions || !email) return res.status(400).json({ error: 'Missing fields' });

  try {
    let user = await User.findOne({ email });
    if (!user) user = await User.create({ email });

    const isVip = isVipEmail(email);
    const isPro = user.isPro || isVip;

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
      temperature: 0.9,
    });

    const result = completion.choices[0]?.message?.content || captions;
    let newScore = (previousScore || 50) + Math.floor(Math.random() * 15) + 10;
    if (newScore > 98) newScore = 98;

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

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
      if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
         const session = event.data.object;
         const email = session.customer_email || (session.metadata && session.metadata.user_email);
         if (email) await User.findOneAndUpdate({ email }, { isPro: true, stripeCustomerId: session.customer });
      } else if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
         const session = event.data.object;
         const email = session.customer_email || (session.metadata && session.metadata.user_email);
         if (email && !isVipEmail(email)) await User.findOneAndUpdate({ email }, { isPro: false });
      }
  } catch (err) { console.error(err); }
  res.json({ received: true });
});

app.post('/create-checkout-session', async (req, res) => {
  const { email, referralCode } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      metadata: { user_email: email, referral_code: referralCode || '' },
      subscription_data: { metadata: { user_email: email, referral_code: referralCode || '' } }
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/create-connect-account', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
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
  } catch (err) { res.status(500).json({ error: 'Failed to create Connect account: ' + err.message }); }
});

app.get('/referral-link', (req, res) => {
  const { referralCode } = req.query;
  if (!referralCode) return res.status(400).json({ error: 'referralCode required' });
  const origin = req.headers.origin || 'https://caption-ai-ze13.onrender.com';
  res.json({ referralUrl: `${origin}?ref=${encodeURIComponent(referralCode)}` });
});

app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
