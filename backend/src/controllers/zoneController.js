/**
 * Zone Controller
 *
 * Admin-only operations for managing zones and areas.
 *
 * Zones:  create, list, update, delete
 * Areas:  create (add pincode → zone mapping), list, delete
 *
 * All routes are protected with: protect + authorise("admin")
 * Regular users never touch these endpoints.
 */

const { Zone, Area } = require("../models/Zone");
const { AppError } = require("../utils/zoneDetection");

// ════════════════════════════════════════════════
// ZONE OPERATIONS
// ════════════════════════════════════════════════

// ─── POST /api/zones ────────────────────────────
/**
 * Create a new zone.
 * Admin names it (e.g. "Zone A", "North Delhi") and optionally describes it.
 */
const createZone = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: "Zone name is required." });
    }

    const zone = await Zone.create({ name, description });

    res.status(201).json({ success: true, zone });
  } catch (error) {
    // Duplicate zone name (unique index violation)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `A zone named "${req.body.name}" already exists.`,
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/zones ─────────────────────────────
/**
 * List all zones.
 * Used by admin panel dropdowns (when creating areas, rate cards, assigning agents).
 */
const getAllZones = async (req, res) => {
  try {
    // Sort alphabetically for consistent UI ordering
    const zones = await Zone.find().sort({ name: 1 });

    res.status(200).json({ success: true, count: zones.length, zones });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── PATCH /api/zones/:id ───────────────────────
/**
 * Update a zone's name or description.
 * ObjectId references on Areas, RateCards, Orders stay valid — we're
 * just changing the display name, not the _id.
 */
const updateZone = async (req, res) => {
  try {
    const { name, description } = req.body;

    // { new: true } returns the updated doc rather than the old one
    // runValidators: true re-runs schema validators on the update
    const zone = await Zone.findByIdAndUpdate(
      req.params.id,
      { name, description },
      { new: true, runValidators: true }
    );

    if (!zone) {
      return res.status(404).json({ success: false, message: "Zone not found." });
    }

    res.status(200).json({ success: true, zone });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "A zone with this name already exists." });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── DELETE /api/zones/:id ──────────────────────
/**
 * Delete a zone — but only if no areas or rate cards reference it.
 *
 * Why check before deleting?
 * MongoDB won't cascade-delete for us. If we delete Zone A while
 * Area documents still reference it, those areas become orphaned —
 * their zone field points to a document that doesn't exist. Zone
 * detection would then silently fail for those pincodes.
 *
 * We prevent this with explicit referential integrity checks.
 */
const deleteZone = async (req, res) => {
  try {
    const zoneId = req.params.id;

    // Check if any areas reference this zone
    const areaCount = await Area.countDocuments({ zone: zoneId });
    if (areaCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete zone: ${areaCount} area(s) are assigned to it. Reassign them first.`,
      });
    }

    // Check if any rate cards reference this zone
    // We require RateCard here to avoid circular deps at module level
    const RateCard = require("../models/RateCard");
    const rateCardCount = await RateCard.countDocuments({
      $or: [{ fromZone: zoneId }, { toZone: zoneId }],
    });
    if (rateCardCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete zone: ${rateCardCount} rate card(s) reference it. Remove them first.`,
      });
    }

    await Zone.findByIdAndDelete(zoneId);

    res.status(200).json({ success: true, message: "Zone deleted successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ════════════════════════════════════════════════
// AREA OPERATIONS (pincode → zone mappings)
// ════════════════════════════════════════════════

// ─── POST /api/zones/areas ──────────────────────
/**
 * Add a pincode → zone mapping.
 * This is how admin "teaches" the system which zone a pincode belongs to.
 */
const createArea = async (req, res) => {
  try {
    const { pincode, city, zoneId } = req.body;

    if (!pincode || !city || !zoneId) {
      return res.status(400).json({
        success: false,
        message: "Pincode, city, and zoneId are required.",
      });
    }

    // Verify the zone exists before creating the area
    const zone = await Zone.findById(zoneId);
    if (!zone) {
      return res.status(404).json({
        success: false,
        message: "Zone not found. Create the zone first.",
      });
    }

    const area = await Area.create({
      pincode: pincode.toString().trim(),
      city: city.trim(),
      zone: zoneId,
    });

    // Populate zone details for the response
    await area.populate("zone");

    res.status(201).json({ success: true, area });
  } catch (error) {
    // Duplicate pincode (unique index violation)
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `Pincode ${req.body.pincode} is already mapped to a zone. Update it instead.`,
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/zones/areas ───────────────────────
/**
 * List all areas, optionally filtered by zone.
 * GET /api/zones/areas           → all areas
 * GET /api/zones/areas?zone=xxx  → areas in a specific zone
 */
const getAllAreas = async (req, res) => {
  try {
    // Build filter dynamically — if ?zone= query param present, filter by it
    const filter = req.query.zone ? { zone: req.query.zone } : {};

    const areas = await Area.find(filter)
      .populate("zone", "name") // only fetch zone name, not full doc
      .sort({ pincode: 1 });    // sort by pincode for readability

    res.status(200).json({ success: true, count: areas.length, areas });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── PATCH /api/zones/areas/:id ─────────────────
/**
 * Move a pincode to a different zone, or update city name.
 * This is the "remap" operation — admin reorganises zones.
 * Existing orders with this pincode are NOT affected (zones are snapshotted).
 */
const updateArea = async (req, res) => {
  try {
    const { city, zoneId } = req.body;
    const updateData = {};

    if (city) updateData.city = city.trim();
    if (zoneId) {
      // Verify the target zone exists
      const zone = await Zone.findById(zoneId);
      if (!zone) {
        return res.status(404).json({ success: false, message: "Target zone not found." });
      }
      updateData.zone = zoneId;
    }

    const area = await Area.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    }).populate("zone", "name");

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found." });
    }

    res.status(200).json({ success: true, area });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── DELETE /api/zones/areas/:id ────────────────
/**
 * Remove a pincode mapping.
 * After deletion, orders to/from this pincode won't be possible
 * until admin adds it back.
 */
const deleteArea = async (req, res) => {
  try {
    const area = await Area.findByIdAndDelete(req.params.id);

    if (!area) {
      return res.status(404).json({ success: false, message: "Area not found." });
    }

    res.status(200).json({
      success: true,
      message: `Pincode ${area.pincode} removed from zone mapping.`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/zones/detect ──────────────────────
/**
 * Test endpoint — lets admin (or frontend) verify zone detection for a pincode.
 * GET /api/zones/detect?pincode=560001
 *
 * Useful for:
 *   - Admin panel "check coverage" feature
 *   - Frontend showing zone info as customer types the pincode
 */
const detectZoneForPincode = async (req, res) => {
  try {
    const { pincode } = req.query;

    if (!pincode) {
      return res.status(400).json({ success: false, message: "Pincode query param is required." });
    }

    // Reuse the utility — same logic as order creation uses
    const { detectZone } = require("../utils/zoneDetection");
    const zone = await detectZone(pincode, "Pincode");

    res.status(200).json({
      success: true,
      pincode,
      zone,
      message: `Pincode ${pincode} is in zone "${zone.name}".`,
    });
  } catch (error) {
    // AppError carries a statusCode — use it
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
};

module.exports = {
  createZone, getAllZones, updateZone, deleteZone,
  createArea, getAllAreas, updateArea, deleteArea,
  detectZoneForPincode,
};