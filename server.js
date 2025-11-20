// --- Only this function body changes in server.js ---
app.post('/generate', async (req, res) => {
  const { idea, platform, tone, email, currentGenerations } = req.body || {}; // <-- ADDED: currentGenerations

  if (!idea || !platform || !tone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const { key, record } = getUserUsage(email);

  // Set initial generations count from client if it's the first time seeing this user
  if (record.generations === 0) {
      // Use the count from localStorage, but default to 0
      record.generations = parseInt(currentGenerations) || 0; 
  }
  
  // Subscription Logic (Unchanged from your last working version)
  const isVip = isVipEmail(email);
  const isCurrentlySubscribedOnStripe = await refreshStripeSubscriptionStatus(email);
  
  // ... (rest of the subscription logic is the same) ...
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
  // ... (rest of AI generation code is the same) ...

  try {
    // ... AI call ...
    const result = completion.choices[0]?.message?.content || 'No result';
    
    // IMPORTANT: Send back the NEW count so the client can save it
    res.json({ result, newGenerationsCount: record.generations }); // <-- ADDED: newGenerationsCount
  } catch (err) {
    // ... error handling ...
  }
});