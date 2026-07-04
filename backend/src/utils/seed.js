/**
 * Seed Script
 *
 * Populates the database with enough data to test the full order flow
 * end-to-end without manually creating zones/areas/rate cards through
 * Postman one at a time.
 *
 * Run with: node src/utils/seed.js
 *
 * Creates:
 *   - 1 admin account
 *   - 2 zones (Zone A, Zone B)
 *   - 4 areas (2 pincodes per zone)
 *   - 4 rate cards (intra A, intra B, inter A→B, inter B→A — each B2C only
 *     for brevity; duplicate the pattern for B2B if you want to test that too)
 *
 * Safe to re-run — it clears existing seed data first (NOT your real
 * customer/order data, just zones/areas/rate cards/admin).
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

const User = require("../models/User");
const { Zone, Area } = require("../models/Zone");
const RateCard = require("../models/RateCard");

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB for seeding...\n");

    // ── Clear existing config data (NOT orders — those are real data) ──
    await Zone.deleteMany({});
    await Area.deleteMany({});
    await RateCard.deleteMany({});
    await User.deleteMany({ email: "admin@lastmile.test" }); // only remove seed admin
    console.log("Cleared existing zones, areas, rate cards, and seed admin.\n");

    // ── Create admin account ──
    const admin = await User.create({
      name: "Admin User",
      email: "admin@lastmile.test",
      password: "admin1234", // hashed automatically by pre-save hook
      role: "admin",
    });
    console.log(`Admin created: ${admin.email} / admin1234`);

    // ── Create zones ──
    const zoneA = await Zone.create({ name: "Zone A", description: "South Bangalore" });
    const zoneB = await Zone.create({ name: "Zone B", description: "North Delhi" });
    console.log(`Zones created: ${zoneA.name}, ${zoneB.name}`);

    // ── Create areas (pincode → zone mapping) ──
    await Area.create([
      { pincode: "560001", city: "Bangalore", zone: zoneA._id },
      { pincode: "560002", city: "Bangalore", zone: zoneA._id },
      { pincode: "110001", city: "New Delhi", zone: zoneB._id },
      { pincode: "110002", city: "New Delhi", zone: zoneB._id },
    ]);
    console.log("Areas created: 560001, 560002 → Zone A | 110001, 110002 → Zone B");

    // ── Create rate cards ──
    // Intra-zone (fromZone === toZone) and inter-zone, B2C only for this seed.
    // Add B2B rows the same way if you want to test that path too.
    await RateCard.create([
      {
        fromZone: zoneA._id, toZone: zoneA._id, orderType: "B2C",
        ratePerKg: 10, minimumCharge: 40, codSurcharge: 15,
      },
      {
        fromZone: zoneB._id, toZone: zoneB._id, orderType: "B2C",
        ratePerKg: 10, minimumCharge: 40, codSurcharge: 15,
      },
      {
        fromZone: zoneA._id, toZone: zoneB._id, orderType: "B2C",
        ratePerKg: 15, minimumCharge: 50, codSurcharge: 20,
      },
      {
        fromZone: zoneB._id, toZone: zoneA._id, orderType: "B2C",
        ratePerKg: 15, minimumCharge: 50, codSurcharge: 20,
      },
    ]);
    console.log("Rate cards created: intra-A, intra-B, A→B, B→A (all B2C)\n");

    console.log("Seed complete. You can now:");
    console.log("  1. Login as admin@lastmile.test / admin1234");
    console.log("  2. Register a customer via POST /api/auth/register");
    console.log("  3. Preview a charge: pickup 560001 → drop 110001, B2C, COD");
    console.log("  4. Create the order via POST /api/orders\n");

    process.exit(0);
  } catch (error) {
    console.error("Seed error:", error);
    process.exit(1);
  }
};

seed();