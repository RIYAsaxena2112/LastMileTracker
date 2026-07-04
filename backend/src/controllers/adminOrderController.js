/**
 * Admin Order Management Controller
 *
 * Spec requirement: "Admin can view all orders, filter by status/zone/agent,
 * and override any order status."
 *
 * The override piece already exists — overrideStatus in statusController.js
 * (Task 2.2). This file adds the LIST/FILTER view.
 *
 * SECURITY NOTES (see system design write-up for full reasoning):
 * ─────────────────────────────────────────────────────────────
 * 1. Route-level: protect + authorise("admin") only — enforced in
 *    orderRoutes.js, not duplicated here, but this controller assumes
 *    it's never reachable by other roles.
 * 2. Pagination is mandatory, not optional — page/limit are clamped to
 *    safe bounds so a request can never trigger an unbounded collection
 *    scan/load.
 * 3. Filters are WHITELISTED, never passed through raw. req.query.status
 *    is checked against the known enum list; req.query.zone/agent are
 *    checked as valid Mongo ObjectIds before being used in the filter.
 *    This blocks NoSQL operator injection (e.g. ?status[$ne]=null).
 */

const mongoose = require("mongoose");
const Order = require("../models/Order");

// Same enum as the Order model — kept as a constant here for validation,
// not duplicated logic (statusTransitions.js owns the lifecycle graph,
// this is just "what values are even legal").
const VALID_STATUSES = [
  "Pending", "Assigned", "Picked Up", "In Transit",
  "Out for Delivery", "Delivered", "Failed", "Rescheduled",
];

const MAX_PAGE_SIZE = 50; // hard ceiling — no request can ask for more than this

// ─── GET /api/orders/admin/all ──────────────────────────────
/**
 * getAllOrdersAdmin
 *
 * Query params (all optional):
 *   ?status=Failed          — must match VALID_STATUSES exactly
 *   ?zone=<ObjectId>        — matches EITHER pickup.zone OR drop.zone
 *   ?agent=<ObjectId>       — must be a valid ObjectId shape
 *   ?page=1&limit=20        — pagination, limit clamped to MAX_PAGE_SIZE
 */
const getAllOrdersAdmin = async (req, res) => {
  try {
    const filter = {};

    // ── Whitelist: status ──
    // Only accept values that are EXACTLY in our known enum. Anything
    // else (including objects like { $ne: null } sent as a query param)
    // is silently ignored rather than passed into the Mongoose query.
    if (req.query.status) {
      if (typeof req.query.status !== "string" || !VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}.`,
        });
      }
      filter.status = req.query.status;
    }

    // ── Whitelist: zone ──
    // Checks BOTH pickup and drop zone, since an admin filtering "Zone A"
    // wants to see orders touching that zone in either direction.
    // mongoose.Types.ObjectId.isValid() rejects anything that isn't a
    // legitimate 24-char hex ObjectId shape — blocks injection attempts.
    if (req.query.zone) {
      if (typeof req.query.zone !== "string" || !mongoose.Types.ObjectId.isValid(req.query.zone)) {
        return res.status(400).json({ success: false, message: "Invalid zone filter." });
      }
      filter.$or = [
        { "pickup.zone": req.query.zone },
        { "drop.zone": req.query.zone },
      ];
    }

    // ── Whitelist: agent ──
    if (req.query.agent) {
      if (typeof req.query.agent !== "string" || !mongoose.Types.ObjectId.isValid(req.query.agent)) {
        return res.status(400).json({ success: false, message: "Invalid agent filter." });
      }
      filter.agent = req.query.agent;
    }

    // ── Pagination — clamped, never trusted blindly ──
    // Number() on a non-numeric string gives NaN; the || fallback catches
    // that. Math.min caps the limit so nobody can request limit=999999.
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Run the count and the page fetch in parallel — independent queries,
    // same Promise.all pattern used in zoneDetection.js
    const [orders, totalCount] = await Promise.all([
      Order.find(filter)
        .populate("customer", "name email phone")
        .populate("agent", "name email phone")
        .populate("pickup.zone", "name")
        .populate("drop.zone", "name")
        .sort({ createdAt: -1 }) // newest first — most relevant to admin
        .skip(skip)
        .limit(limit),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: orders.length,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
      orders,
    });

  } catch (error) {
    console.error("Get all orders (admin) error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getAllOrdersAdmin };