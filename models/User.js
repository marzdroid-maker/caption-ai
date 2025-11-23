const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    trim: true 
  },
  freeGenerations: { 
    type: Number, 
    default: 0 
  },
  isPro: { 
    type: Boolean, 
    default: false 
  },
  stripeCustomerId: { 
    type: String 
  },
  // NEW: Store the user's custom voice profile
  brandVoice: {
    type: String,
    default: "" 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('User', userSchema);
