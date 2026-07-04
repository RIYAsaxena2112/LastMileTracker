/**
 * Order Model
 *
 * The central entity. Everything in this system revolves around orders.
 *
 * Key design decisions explained:
 *
 * 1. SNAPSHOTTED ZONES (pickup.zone / drop.zone stored on order)
 *    Admin can remap pincodes to different zones at any time. If we only
 *    stored the pincode and re-detected the zone later, old orders would
 *    show wrong zones. We snapshot the resolved zone at order creation time.
 *
 * 2. SNAPSHOTTED PRICING (charge, chargeBreakdown, billableWeight)
 *    Admin can change rate cards. Past orders must not be affected.
 *    We calculate and store the full charge breakdown at creation time.
 *
 * 3. THREE USER REFERENCES (customer, agent, createdBy)
 *    - customer: who the delivery is for
 *    - agent: who delivers it (null until assigned)
 *    - createdBy: who created the order (customer self-service OR admin on behalf)
 *    These can all be different people.
 *
 * 4. STATUS IS ON THE ORDER (current status only)
 *    The full history lives in TrackingLog. Order.status is just the
 *    current snapshot — useful for filtering without joining logs.
 */

const mongoose = require("mongoose");
const crypto = require("crypto"); // built-in Node module — no install needed

// ─── Sub-schema for address (used for both pickup and drop) ──
// Using a sub-schema keeps the main schema clean and enforces the same
// shape for pickup and drop addresses.
const addressSchema = new mongoose.Schema(
  {
    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
    },

    pincode: {
      type: String,
      required: [true, "Pincode is required"],
      trim: true,
    },

    city: {
      type: String,
      trim: true,
    },

    // Resolved zone — snapshotted at order creation via zone detection
    zone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone",
      required: true,
    },
  },
  { _id: false } // don't create a separate _id for this embedded sub-document
);

// ─── Main Order schema ───────────────────────────────────────
const orderSchema = new mongoose.Schema(
  {
    // Human-readable order number for customer-facing display and support queries
    // e.g., "ORD-1A2B3C" — generated automatically before save
    orderNumber: {
      type: String,
      unique: true,
    },

    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Customer reference is required"],
      index: true, // customer frequently queries their own orders
    },

    // Null until admin assigns manually or auto-assignment runs
    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true, // agent queries their assigned orders
    },

    // Who actually pressed "Create Order" — could be customer or admin
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    pickup: {
      type: addressSchema,
      required: true,
    },

    drop: {
      type: addressSchema,
      required: true,
    },

    // Package dimensions in centimeters
    // Stored so we can audit/dispute volumetric weight calculations later
    dimensions: {
      l: { type: Number, required: [true, "Length is required"], min: 0 },
      b: { type: Number, required: [true, "Breadth is required"], min: 0 },
      h: { type: Number, required: [true, "Height is required"], min: 0 },
    },

    // Actual weight in kg — as declared by customer
    actualWeight: {
      type: Number,
      required: [true, "Actual weight is required"],
      min: [0, "Weight cannot be negative"],
    },

    // Calculated: L × B × H ÷ 5000 — stored for transparency
    volumetricWeight: {
      type: Number,
      required: true,
    },

    // max(actualWeight, volumetricWeight) — what the rate card is applied to
    billableWeight: {
      type: Number,
      required: true,
    },

    orderType: {
      type: String,
      enum: ["B2B", "B2C"],
      required: [true, "Order type is required"],
    },

    paymentType: {
      type: String,
      enum: ["Prepaid", "COD"],
      required: [true, "Payment type is required"],
    },

    // Final charge shown to customer before confirmation — snapshotted
    charge: {
      type: Number,
      required: true,
      min: 0,
    },

    // Breakdown stored separately for invoice display and debugging
    // e.g., { baseCharge: 120, codSurcharge: 20 }
    chargeBreakdown: {
      baseCharge: { type: Number, default: 0 },
      codSurcharge: { type: Number, default: 0 },
    },

    // Current status of the order — single source of truth for filtering
    // Full history is in TrackingLog
    status: {
      type: String,
      enum: [
        "Pending",       // order created, no agent yet
        "Assigned",      // agent assigned, waiting for pickup
        "Picked Up",     // agent picked up from sender
        "In Transit",    // on the way
        "Out for Delivery", // last mile — near drop address
        "Delivered",     // successfully handed over
        "Failed",        // delivery attempt failed
        "Rescheduled",   // customer rescheduled after failure
      ],
      default: "Pending",
      index: true, // admin filters orders by status frequently
    },

    // Set when customer reschedules after a failed delivery
    scheduledDate: {
      type: Date,
      default: null,
    },

    // Failure reason captured from agent at time of failure
    failureReason: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// ─── Compound indexes for admin filtering ────────────────────
// Admin queries: "show me all Failed orders in Zone A"
// Without this index, MongoDB scans every order.
orderSchema.index({ status: 1, "pickup.zone": 1 });
orderSchema.index({ status: 1, agent: 1 });

// ─── Auto-generate order number before first save ────────────
// We use nanoid to generate a short unique string.
// Only runs if orderNumber isn't already set.
orderSchema.pre("save", function (next) {
  if (!this.orderNumber) {
    // Format: ORD-{8 random alphanumeric chars}
    // nanoid(8) gives e.g. "V1StGXR8" — short, URL-safe, collision-resistant
    // crypto.randomBytes(4) gives 4 random bytes → 8 hex chars
    // e.g. "ORD-A1B2C3D4" — short, unique, no extra package needed
    this.orderNumber = `ORD-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);