/**
 * RateCard Controller
 *
 * Two categories of routes:
 *   1. Admin CRUD — create/list/update/delete rate cards
 *   2. Charge preview — ANY logged-in user can get a price quote
 *      before placing an order (this is what calls calculateCharge)
 */

const RateCard = require("../models/RateCard");
const { calculateCharge } = require("../utils/rateEngine");

// ─── POST /api/rate-cards ───────────────────────────────────
/**
 * Admin creates a rate card for a (fromZone, toZone, orderType) combination.
 * If fromZone === toZone, this becomes the intra-zone rate.
 */
const createRateCard = async (req, res) => {
  try {
    const { fromZone, toZone, orderType, ratePerKg, minimumCharge, codSurcharge } = req.body;

    if (!fromZone || !toZone || !orderType || ratePerKg === undefined) {
      return res.status(400).json({
        success: false,
        message: "fromZone, toZone, orderType, and ratePerKg are required.",
      });
    }

    const rateCard = await RateCard.create({
      fromZone,
      toZone,
      orderType,
      ratePerKg,
      minimumCharge: minimumCharge ?? 0,
      codSurcharge: codSurcharge ?? 0,
    });

    await rateCard.populate(["fromZone", "toZone"]);

    res.status(201).json({ success: true, rateCard });
  } catch (error) {
    // Compound unique index violation — duplicate (fromZone, toZone, orderType)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "A rate card already exists for this zone pair and order type. Update it instead.",
      });
    }
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(". ") });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/rate-cards ────────────────────────────────────
/**
 * List all rate cards, with populated zone names for admin display.
 * Optional filters: ?orderType=B2C, ?fromZone=xxx
 */
const getAllRateCards = async (req, res) => {
  try {
    const filter = {};
    if (req.query.orderType) filter.orderType = req.query.orderType;
    if (req.query.fromZone) filter.fromZone = req.query.fromZone;

    const rateCards = await RateCard.find(filter)
      .populate("fromZone", "name")
      .populate("toZone", "name")
      .sort({ orderType: 1 });

    res.status(200).json({ success: true, count: rateCards.length, rateCards });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── PATCH /api/rate-cards/:id ──────────────────────────────
/**
 * Update pricing on an existing rate card.
 * IMPORTANT: this does NOT affect past orders — charge is snapshotted
 * on each Order at creation time. Only future orders use the new rate.
 */
const updateRateCard = async (req, res) => {
  try {
    const { ratePerKg, minimumCharge, codSurcharge } = req.body;

    const rateCard = await RateCard.findByIdAndUpdate(
      req.params.id,
      { ratePerKg, minimumCharge, codSurcharge },
      { new: true, runValidators: true }
    ).populate(["fromZone", "toZone"]);

    if (!rateCard) {
      return res.status(404).json({ success: false, message: "Rate card not found." });
    }

    res.status(200).json({ success: true, rateCard });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── DELETE /api/rate-cards/:id ─────────────────────────────
const deleteRateCard = async (req, res) => {
  try {
    const rateCard = await RateCard.findByIdAndDelete(req.params.id);

    if (!rateCard) {
      return res.status(404).json({ success: false, message: "Rate card not found." });
    }

    res.status(200).json({ success: true, message: "Rate card deleted." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── POST /api/rate-cards/preview ───────────────────────────
/**
 * THE CHARGE PREVIEW ENDPOINT.
 *
 * Spec requirement: "The charge is shown before the customer confirms."
 * This is exactly that. Customer fills the order form, frontend calls
 * this endpoint, shows the price, THEN customer clicks confirm which
 * triggers actual order creation.
 *
 * Critically: this calls the exact same calculateCharge() function that
 * order creation uses. Same inputs always produce the same price — no
 * drift between "what was quoted" and "what was charged".
 *
 * Open to all authenticated roles — customer previews their own order,
 * admin previews when creating an order on behalf of a customer.
 */
const previewCharge = async (req, res) => {
  try {
    const {
      pickupPincode,
      dropPincode,
      l,
      b,
      h,
      actualWeight,
      orderType,
      paymentType,
    } = req.body;

    // calculateCharge handles its own validation and throws AppError
    // with the right statusCode if anything is wrong
    const result = await calculateCharge({
      pickupPincode,
      dropPincode,
      l: Number(l),
      b: Number(b),
      h: Number(h),
      actualWeight: Number(actualWeight),
      orderType,
      paymentType,
    });

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    // AppError carries the right HTTP status (400/404); fall back to 500
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
};

module.exports = {
  createRateCard, getAllRateCards, updateRateCard, deleteRateCard,
  previewCharge,
};