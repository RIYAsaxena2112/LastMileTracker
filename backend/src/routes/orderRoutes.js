/**
 * Order Routes
 *
 * POST /api/orders → createOrder
 *
 * Open to customer and admin only — agents never create orders,
 * they only update status on orders assigned to them (built in Task 2.2).
 *
 * More routes will be added here as we build:
 *   GET  /api/orders/:id           → view single order + timeline
 *   GET  /api/orders               → list orders (filtered by role)
 *   PATCH /api/orders/:id/assign   → admin/auto-assign agent
 *   PATCH /api/orders/:id/status   → agent updates status
 */

const express = require("express");
const router = express.Router();

const { protect, authorise } = require("../middleware/auth");
const { createOrder } = require("../controllers/orderController");
const { autoAssign, manualAssign } = require("../controllers/assignmentController");
const { updateStatus, overrideStatus, getOrderTimeline } = require("../controllers/statusController");
const { reschedule } = require("../controllers/rescheduleController");
const { getAllOrdersAdmin } = require("../controllers/adminOrderController");

router.post("/", protect, authorise("customer", "admin"), createOrder);

// Agent: orders assigned to them (active + recent)
router.get("/agent/mine", protect, authorise("agent"), async (req, res) => {
  try {
    const Order = require("../models/Order");
    const orders = await Order.find({ agent: req.user._id })
      .populate("pickup.zone", "name").populate("drop.zone", "name")
      .populate("customer", "name phone")
      .sort({ updatedAt: -1 }); // most recently updated first
    res.status(200).json({ success: true, orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Agent: their assigned orders — must come before /:id routes
router.get("/agent/assigned", protect, authorise("agent"), async (req, res) => {
  try {
    const Order = require("../models/Order");
    // Show active orders first (not Delivered/Failed terminal states)
    // so the agent sees their live work at the top
    const orders = await Order.find({ agent: req.user._id })
      .populate("pickup.zone", "name")
      .populate("drop.zone", "name")
      .populate("customer", "name phone")
      .sort({ updatedAt: -1 });
    res.status(200).json({ success: true, orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Agent: their assigned orders — must come before /:id routes
router.get("/agent/my", protect, authorise("agent"), async (req, res) => {
  try {
    const Order = require("../models/Order");
    const orders = await Order.find({
      agent: req.user._id,
      status: { $nin: ["Delivered", "Failed"] }, // active orders first
    })
      .populate("pickup.zone", "name").populate("drop.zone", "name")
      .populate("customer", "name phone")
      .sort({ updatedAt: -1 });

    // Also fetch recently completed for history tab
    const completed = await Order.find({
      agent: req.user._id,
      status: { $in: ["Delivered", "Failed", "Rescheduled"] },
    })
      .populate("pickup.zone", "name").populate("drop.zone", "name")
      .populate("customer", "name phone")
      .sort({ updatedAt: -1 })
      .limit(10);

    res.status(200).json({ success: true, orders, completed });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Customer: their own orders — must come before /:id routes
router.get("/my", protect, authorise("customer"), async (req, res) => {
  try {
    const Order = require("../models/Order");
    const orders = await Order.find({ customer: req.user._id })
      .populate("pickup.zone", "name").populate("drop.zone", "name")
      .populate("agent", "name phone")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, orders });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Admin order list/filter — MUST be registered before "/:id/..." routes
// below. Express matches routes top-to-bottom; if this came after
// "/:id/status" etc., a request to "/admin/all" would never reach here
// because Express would first try (and fail) to match "/:id" patterns
// against unrelated paths, but more importantly "admin" itself could be
// misrouted as an :id on a less specific pattern. Order matters in
// Express routing — specific literal paths before parameterised ones.
router.get("/admin/all", protect, authorise("admin"), getAllOrdersAdmin);

// Get single order — ownership checked inside
router.get("/:id", protect, async (req, res) => {
  try {
    const Order = require("../models/Order");
    const order = await Order.findById(req.params.id)
      .populate("pickup.zone", "name").populate("drop.zone", "name")
      .populate("agent", "name phone").populate("customer", "name email phone");
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (req.user.role === "customer" && !order.customer._id.equals(req.user._id))
      return res.status(403).json({ success: false, message: "Access denied." });
    res.status(200).json({ success: true, order });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Assignment routes — admin only.
router.patch("/:id/auto-assign", protect, authorise("admin"), autoAssign);
router.patch("/:id/assign", protect, authorise("admin"), manualAssign);

// Status lifecycle routes.
// updateStatus: agent (lifecycle-bound) AND customer (for Failed → Rescheduled in Task 2.3)
router.patch("/:id/status", protect, authorise("agent", "customer"), updateStatus);
// overrideStatus: admin only — bypasses the state machine
router.patch("/:id/override-status", protect, authorise("admin"), overrideStatus);
// timeline: any authenticated role, ownership checked inside the controller
router.get("/:id/timeline", protect, getOrderTimeline);

// Reschedule — customer only, requires order to be "Failed"
router.patch("/:id/reschedule", protect, authorise("customer"), reschedule);

module.exports = router;