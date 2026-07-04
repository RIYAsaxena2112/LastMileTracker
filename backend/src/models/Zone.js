/**
 * Zone Model
 *
 * Admin-created geographic zones. A zone is a named region like "Zone A"
 * or "North Delhi". Zones don't store pincodes directly — Areas do.
 *
 * Why separate Zone from Area?
 * Because one zone covers many pincodes. If we stored pincodes directly
 * on Zone, we'd have an array that keeps growing. More importantly, the
 * same zone can be referenced from RateCards and Orders — a simple ObjectId
 * reference is cleaner than embedding pincode logic everywhere.
 *
 * Zone detection flow:
 *   user inputs pincode → find Area with that pincode → Area.zone = the zone
 */

const mongoose = require("mongoose");

const zoneSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Zone name is required"],
      unique: true, // "Zone A" can only exist once
      trim: true,
    },

    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

const Zone = mongoose.model("Zone", zoneSchema);

// ─────────────────────────────────────────────────────────────
// Area Model (in same file — they're tightly related)
// ─────────────────────────────────────────────────────────────

/**
 * Area Model
 *
 * Maps a pincode (or city name) to a zone. Admin manages these.
 *
 * This is the lookup table for zone detection:
 *   "Customer typed pincode 110001 → which zone is that?"
 *   → Area.findOne({ pincode: "110001" }).populate("zone")
 *
 * Why store pincode as String and not Number?
 * Pincodes can start with 0 (e.g., "011001"). Numbers drop leading zeros.
 * Always treat pincodes as strings.
 */

const areaSchema = new mongoose.Schema(
  {
    pincode: {
      type: String,
      required: [true, "Pincode is required"],
      unique: true, // one pincode belongs to exactly one zone — no ambiguity
      trim: true,
    },

    city: {
      type: String,
      required: [true, "City name is required"],
      trim: true,
    },

    // Which zone this pincode belongs to.
    // ref: "Zone" lets us do .populate("zone") to get full zone details.
    zone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone",
      required: [true, "Zone is required for an area"],
      index: true, // we often query "all areas in zone X" (admin panel)
    },
  },
  { timestamps: true }
);

const Area = mongoose.model("Area", areaSchema);

module.exports = { Zone, Area };