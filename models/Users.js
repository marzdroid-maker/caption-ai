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
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

module.exports = mongoose.model('User', userSchema);
