// Corrected server.js minimal including affiliate and original routes placeholder
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// helpers
function isVipEmail(email){ return false; }
async function refreshStripeSubscriptionStatus(email){ return false; }

// check subscription
app.get('/check-subscription', async (req,res)=>{
  const email = req.query.email;
  if(!email) return res.status(400).json({error:'Email query parameter required'});
  const isVip = isVipEmail(email);
  let isPro = isVip;
  if(!isVip){
    const sub = await refreshStripeSubscriptionStatus(email);
    if(sub===true) isPro=true;
  }
  return res.json({isPro, isVip});
});

// affiliate
app.post('/create-connect-account', async (req,res)=>{
  try{
    const {email}=req.body||{};
    if(!email || !email.includes('@')) return res.status(400).json({error:'A valid email is required'});
    const account = await stripe.accounts.create({
      type:'express',
      email,
      capabilities:{transfers:{requested:true}},
      metadata:{user_email:email}
    });
    const origin = req.headers.origin || process.env.APP_BASE_URL || 'https://caption-ai-ze13.onrender.com';
    const link = await stripe.accountLinks.create({
      account:account.id,
      refresh_url:`${origin}?connect_refresh=1`,
      return_url:`${origin}?connect_return=1`,
      type:'account_onboarding'
    });
    return res.json({connectAccountId:account.id, onboardingUrl:link.url});
  }catch(err){
    return res.status(500).json({error:'Failed to create Connect account'});
  }
});

// root
app.get('/',(req,res)=> res.sendFile(__dirname+'/caption.html'));

app.listen(PORT,()=>console.log('Running',PORT));
