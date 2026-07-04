/**
 * Rate Calculation Engine
 *
 * The core pricing logic of the entire system. Given package details and
 * delivery info, calculates the final charge.
 *
 * Design principle: this is a PURE function (calculateCharge).
 * Given the same inputs, it always returns the same output. No DB writes,
 * no side effects. This makes it independently testable — you can call it
 * directly in a test without spinning up the whole API.
 *
 * The only "impure" part is the rate card lookup (a DB read), which is
 * necessary — we can't hardcode prices, the spec requires admin-configurable
 * rates. We isolate that DB read into its own step so the math stays pure.
 *
 * VOLUMETRIC_DIVISOR = 5000
 * Industry-standard constant for domestic courier services.
 * Formula: volumetricWeight (kg) = (L × B × H in cm) / 5000
 */

const RateCard = require("../models/RateCard");
const { detectBothZones, AppError } = require("./zoneDetection");

const VOLUMETRIC_DIVISOR = 5000;

// ─── Step 1: Volumetric weight ───────────────────────────────
/**
 * calculateVolumetricWeight
 *
 * @param {number} l - length in cm
 * @param {number} b - breadth in cm
 * @param {number} h - height in cm
 * @returns {number} volumetric weight in kg, rounded to 2 decimal places
 */
const calculateVolumetricWeight = (l, b, h) => {
  const raw = (l * b * h) / VOLUMETRIC_DIVISOR;

  // Round to 2 decimals — avoids floating point noise like 4.800000000001
  // Math.round(x * 100) / 100 is the standard JS rounding-to-2-decimals trick
  return Math.round(raw * 100) / 100;
};

// ─── Step 2: Billable weight ──────────────────────────────────
/**
 * calculateBillableWeight
 *
 * The courier always bills on whichever is HIGHER — protects margin
 * whether the package is dense (heavy/small) or bulky (light/large).
 *
 * @param {number} actualWeight     - in kg
 * @param {number} volumetricWeight - in kg
 * @returns {number} the weight to bill on
 */
const calculateBillableWeight = (actualWeight, volumetricWeight) => {
  return Math.max(actualWeight, volumetricWeight);
};

// ─── Step 3: Rate card lookup ─────────────────────────────────
/**
 * findRateCard
 *
 * Looks up the applicable rate card for a given zone pair + order type.
 * This is the ONE place in the codebase where pricing data is fetched —
 * keeping it centralised means there's exactly one query to optimise
 * or debug if pricing looks wrong.
 *
 * @param {ObjectId} fromZoneId
 * @param {ObjectId} toZoneId
 * @param {string}   orderType - "B2B" | "B2C"
 * @returns {Object} the RateCard document
 * @throws {AppError} 404 if no rate card configured for this combination
 */
const findRateCard = async (fromZoneId, toZoneId, orderType) => {
  const rateCard = await RateCard.findOne({
    fromZone: fromZoneId,
    toZone: toZoneId,
    orderType,
  });

  if (!rateCard) {
    // This is a genuinely useful error — tells admin EXACTLY what's missing
    throw new AppError(
      `No rate card configured for this route (${orderType}). ` +
      `Admin needs to add a rate card for this zone pair.`,
      404
    );
  }

  return rateCard;
};

// ─── Step 4 + 5: Apply rate + COD surcharge ──────────────────
/**
 * applyRate
 *
 * Pure calculation — takes the billable weight and a rate card,
 * returns the charge breakdown. No DB access here.
 *
 * @param {number} billableWeight
 * @param {Object} rateCard      - { ratePerKg, minimumCharge, codSurcharge }
 * @param {string} paymentType   - "Prepaid" | "COD"
 * @returns {{ baseCharge, codSurcharge, totalCharge }}
 */
const applyRate = (billableWeight, rateCard, paymentType) => {
  // Base charge: weight × rate, but never below the minimum floor
  const rawBaseCharge = billableWeight * rateCard.ratePerKg;
  const baseCharge = Math.max(rawBaseCharge, rateCard.minimumCharge);

  // COD surcharge only applies if payment type is COD
  // Comes from the rate card itself — admin-configurable per zone pair
  const codSurcharge = paymentType === "COD" ? rateCard.codSurcharge : 0;

  const totalCharge = baseCharge + codSurcharge;

  // Round everything to 2 decimals for currency display
  return {
    baseCharge: Math.round(baseCharge * 100) / 100,
    codSurcharge: Math.round(codSurcharge * 100) / 100,
    totalCharge: Math.round(totalCharge * 100) / 100,
  };
};

// ─── Orchestrator: the full calculation ──────────────────────
/**
 * calculateCharge
 *
 * This is the function controllers actually call. It runs the full
 * pipeline: zone detection → volumetric weight → billable weight →
 * rate card lookup → final charge.
 *
 * Used in TWO places:
 *   1. Charge preview endpoint (before customer confirms the order)
 *   2. Order creation (to snapshot the charge onto the Order document)
 *
 * Both call this SAME function — guarantees the preview price and the
 * final charged price can never drift apart, since it's the same code path.
 *
 * @param {Object} input
 * @param {string} input.pickupPincode
 * @param {string} input.dropPincode
 * @param {number} input.l
 * @param {number} input.b
 * @param {number} input.h
 * @param {number} input.actualWeight
 * @param {string} input.orderType   - "B2B" | "B2C"
 * @param {string} input.paymentType - "Prepaid" | "COD"
 *
 * @returns {Object} full breakdown — everything needed to display
 *                    a price quote AND everything needed to snapshot
 *                    onto the Order document
 */
const calculateCharge = async ({
  pickupPincode,
  dropPincode,
  l,
  b,
  h,
  actualWeight,
  orderType,
  paymentType,
}) => {
  // ── Validate numeric inputs early ──
  // Defensive checks before any math — bad input should fail loudly,
  // not silently produce NaN or a negative charge.
  if ([l, b, h, actualWeight].some((val) => typeof val !== "number" || val <= 0)) {
    throw new AppError(
      "Length, breadth, height, and actual weight must all be positive numbers.",
      400
    );
  }

  if (!["B2B", "B2C"].includes(orderType)) {
    throw new AppError("Order type must be B2B or B2C.", 400);
  }

  if (!["Prepaid", "COD"].includes(paymentType)) {
    throw new AppError("Payment type must be Prepaid or COD.", 400);
  }

  // ── Step A: Zone detection (reuses the utility from Task 1.3) ──
  const { pickupZone, dropZone, isIntraZone } = await detectBothZones(
    pickupPincode,
    dropPincode
  );

  // ── Step B: Volumetric weight ──
  const volumetricWeight = calculateVolumetricWeight(l, b, h);

  // ── Step C: Billable weight ──
  const billableWeight = calculateBillableWeight(actualWeight, volumetricWeight);

  // ── Step D: Rate card lookup ──
  // Note: fromZone/toZone are literally the same ObjectId when isIntraZone
  // is true — we don't need a separate "intra rate" code path. The admin
  // simply creates a rate card where fromZone === toZone, and this same
  // query finds it naturally.
  const rateCard = await findRateCard(pickupZone._id, dropZone._id, orderType);

  // ── Step E: Apply rate + COD surcharge ──
  const { baseCharge, codSurcharge, totalCharge } = applyRate(
    billableWeight,
    rateCard,
    paymentType
  );

  // Return everything — the controller decides what to show the customer
  // vs what to snapshot onto the Order document
  return {
    pickupZone,
    dropZone,
    isIntraZone,
    volumetricWeight,
    billableWeight,
    rateCardUsed: {
      ratePerKg: rateCard.ratePerKg,
      minimumCharge: rateCard.minimumCharge,
      codSurcharge: rateCard.codSurcharge,
    },
    chargeBreakdown: { baseCharge, codSurcharge },
    totalCharge,
  };
};

module.exports = {
  calculateVolumetricWeight,
  calculateBillableWeight,
  findRateCard,
  applyRate,
  calculateCharge,
};