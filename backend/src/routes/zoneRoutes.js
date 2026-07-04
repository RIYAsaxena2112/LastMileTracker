/**
 * Zone Routes
 *
 * All zone and area management routes are admin-only.
 * The protect + authorise("admin") chain runs on every route here.
 *
 * Exception: GET /api/zones and GET /api/zones/detect are also accessible
 * to agents (for their zone assignment UI) — see inline comments.
 *
 * Route map:
 *
 *  Zones
 *    POST   /api/zones              → createZone
 *    GET    /api/zones              → getAllZones
 *    PATCH  /api/zones/:id          → updateZone
 *    DELETE /api/zones/:id          → deleteZone
 *
 *  Areas (pincode mappings)
 *    POST   /api/zones/areas        → createArea
 *    GET    /api/zones/areas        → getAllAreas
 *    PATCH  /api/zones/areas/:id    → updateArea
 *    DELETE /api/zones/areas/:id    → deleteArea
 *
 *  Utility
 *    GET    /api/zones/detect       → detectZoneForPincode
 */

const express = require("express");
const router = express.Router();

const { protect, authorise } = require("../middleware/auth");
const {
  createZone, getAllZones, updateZone, deleteZone,
  createArea, getAllAreas, updateArea, deleteArea,
  detectZoneForPincode,
} = require("../controllers/zoneController");

// ─── Zone routes ─────────────────────────────────────────────
router
  .route("/")
  .post(protect, authorise("admin"), createZone)
  // Agents also need to see zones (for their zone assignment dropdown)
  .get(protect, authorise("admin", "agent"), getAllZones);

router
  .route("/:id")
  .patch(protect, authorise("admin"), updateZone)
  .delete(protect, authorise("admin"), deleteZone);

// ─── Zone detection utility ──────────────────────────────────
// Must be defined BEFORE /areas routes to avoid Express treating
// "detect" as an :id parameter
// Accessible to all logged-in users — frontend uses this to show
// zone info as customer types their pincode
router.get("/detect", protect, detectZoneForPincode);

// ─── Area routes ─────────────────────────────────────────────
router
  .route("/areas")
  .post(protect, authorise("admin"), createArea)
  .get(protect, authorise("admin"), getAllAreas);

router
  .route("/areas/:id")
  .patch(protect, authorise("admin"), updateArea)
  .delete(protect, authorise("admin"), deleteArea);

module.exports = router;