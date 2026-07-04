/**
 * RateCard Model
 *
 * Stores admin-configured pricing rules. One rate card = one unique
 * combination of (fromZone, toZone, orderType).
 *
 * Why this structure?
 * The spec says:
 *   - Intra-zone vs inter-zone rates (fromZone === toZone → intra)
 *   - Separate rates for B2B and B2C
 *   - COD surcharge per order type
 *   - All admin-configurable, no hardcoding
 *
 * So the rate lookup at order creation is:
 *   1. Detect pickup zone → fromZone
 *   2. Detect drop zone   → toZone
 *   3. Get orderType from order form (B2B or B2C)
 *   4. RateCard.findOne({ fromZone, toZone, orderType })
 *   5. Apply ratePerKg * billableWeight, add codSurcharge if COD
 *
 * The compound unique index prevents admin from creating two conflicting
 * rate cards for the same zone pair + order type.
 */

const mongoose = require("mongoose");

const rateCardSchema = new mongoose.Schema(
  {
    fromZone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone",
      required: [true, "From-zone is required"],
    },

    toZone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone",
      required: [true, "To-zone is required"],
    },

    orderType: {
      type: String,
      enum: ["B2B", "B2C"],
      required: [true, "Order type (B2B or B2C) is required"],
    },

    // Base charge per kg of billable weight
    // billableWeight = max(actualWeight, volumetricWeight)
    ratePerKg: {
      type: Number,
      required: [true, "Rate per kg is required"],
      min: [0, "Rate cannot be negative"],
    },

    // Minimum charge — even if the package is 0.1kg and ratePerKg is ₹10,
    // you'd only charge ₹1 which isn't viable. This is the floor.
    minimumCharge: {
      type: Number,
      required: [true, "Minimum charge is required"],
      min: [0, "Minimum charge cannot be negative"],
      default: 0,
    },

    // Added to the charge if paymentType === "COD"
    // Stored here (not hardcoded) because the spec says admin-configurable.
    // Can be 0 if admin doesn't want a surcharge for this zone pair.
    codSurcharge: {
      type: Number,
      required: [true, "COD surcharge is required (set 0 if not applicable)"],
      min: [0, "COD surcharge cannot be negative"],
      default: 0,
    },
  },
  { timestamps: true }
);

// ─── Compound unique index ───────────────────────────────────
// Ensures no duplicate rate card for the same (fromZone, toZone, orderType).
// If admin tries to create a second B2C rate card for Zone A → Zone B,
// MongoDB will reject it with a duplicate key error.
rateCardSchema.index(
  { fromZone: 1, toZone: 1, orderType: 1 },
  { unique: true }
);

module.exports = mongoose.model("RateCard", rateCardSchema);