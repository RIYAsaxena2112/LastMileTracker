/**
 * User Model
 *
 * Stores ALL users in one collection: customers, delivery agents, and admins.
 * Why one collection? Auth logic (JWT, bcrypt) is identical for all roles.
 * The `role` field is what controls what each user can do — middleware reads it.
 *
 * Agent-specific fields (currentZone, isAvailable) are simply null for
 * customers and admins. This is intentional: simpler than 3 collections.
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true, // enforces unique index at DB level — no two users share an email
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
      // IMPORTANT: we never send password back in API responses
      // The `select: false` means it's excluded from queries by default
      select: false,
    },

    phone: {
      type: String,
      trim: true,
    },

    role: {
      type: String,
      // Only these three values are valid — mongoose will reject anything else
      enum: ["customer", "agent", "admin"],
      default: "customer",
    },

    // --- Agent-only fields ---
    // These are null/undefined for customers and admins.
    // An agent's current zone is used during auto-assignment to find the
    // nearest available agent to the pickup zone.

    currentZone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone", // tells Mongoose which collection to populate from
      default: null,
    },

    isAvailable: {
      // true  = agent has no active delivery, can be assigned
      // false = agent is currently handling an order
      // We index this field because auto-assignment queries:
      //   User.find({ role: "agent", isAvailable: true, currentZone: pickupZoneId })
      // Without an index, this would scan ALL users on every assignment.
      type: Boolean,
      default: true,
    },

    // When this agent was last assigned an order.
    // Used for round-robin tie-breaking: when multiple agents are available
    // in the same zone, the one who's been idle longest gets picked next.
    // Without this, assignment would always favour whichever agent happens
    // to come first in the query results — not fair distribution.
    lastAssignedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // Mongoose auto-manages createdAt and updatedAt timestamps
    timestamps: true,
  }
);

// --- Index for auto-assignment queries ---
// Compound index: role + isAvailable + currentZone
// When we query "find me an available agent in Zone X", this index makes it fast.
userSchema.index({ role: 1, isAvailable: 1, currentZone: 1 });

// --- Password hashing middleware ---
// This runs automatically BEFORE every .save() call.
// We only re-hash if the password field was actually modified —
// otherwise updating name/phone would re-hash the already-hashed password.
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    return next(); // password unchanged, skip hashing
  }

  // bcrypt salt rounds = 12
  // Higher = more secure but slower. 12 is a good balance for production.
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// --- Instance method: compare passwords ---
// Used during login. Takes the plain-text password the user typed,
// compares it against the stored hash.
// We put this on the model so controllers stay clean — they just call
// user.comparePassword(typedPassword) and get back true/false.
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// --- Remove sensitive fields from JSON output ---
// When Express sends res.json(user), mongoose calls .toJSON() internally.
// We override it here to strip password from every API response automatically.
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  return user;
};

module.exports = mongoose.model("User", userSchema);