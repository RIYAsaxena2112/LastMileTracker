/**
 * RateCard Routes
 *
 *   POST   /api/rate-cards            → admin only, create rate card
 *   GET    /api/rate-cards            → admin only, list/filter
 *   PATCH  /api/rate-cards/:id        → admin only, update pricing
 *   DELETE /api/rate-cards/:id        → admin only, delete
 *   POST   /api/rate-cards/preview    → any logged-in user, charge preview
 *
 * The preview route is intentionally open to all authenticated roles —
 * customers need it before confirming an order, admins need it when
 * creating an order on a customer's behalf.
 */

const express = require("express");
const router = express.Router();

const { protect, authorise } = require("../middleware/auth");
const {
  createRateCard, getAllRateCards, updateRateCard, deleteRateCard,
  previewCharge,
} = require("../controllers/rateCardController");

// Preview route — defined first, open to any authenticated user
router.post("/preview", protect, previewCharge);

// Admin-only CRUD
router
  .route("/")
  .post(protect, authorise("admin"), createRateCard)
  .get(protect, authorise("admin"), getAllRateCards);

router
  .route("/:id")
  .patch(protect, authorise("admin"), updateRateCard)
  .delete(protect, authorise("admin"), deleteRateCard);

module.exports = router;