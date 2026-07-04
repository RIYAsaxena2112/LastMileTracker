/**
 * Status Controller
 *
 * Three operations:
 *   1. updateStatus    — agent moves order through the lifecycle, bound by
 *                        the state machine in statusTransitions.js
 *   2. overrideStatus  — admin escape hatch, bypasses the state machine
 *   3. getOrderTimeline — anyone with access to the order can view its
 *                        full immutable history
 *
 * Both updateStatus and overrideStatus write to Order AND TrackingLog
 * atomically (same transaction pattern used in orderController and
 * assignmentEngine) — we never want a status change that isn't logged.
 */

const mongoose = require("mongoose");
const Order = require("../models/Order");
const TrackingLog = require("../models/TrackingLog");
const { isValidTransition } = require("../utils/statusTransitions");
const { releaseAgent } = require("../utils/assignmentEngine");
const { sendStatusEmail } = require("../utils/emailService");

// Statuses that mean "this agent's job on this order is done" —
// releasing them back into the available pool.
const TERMINAL_STATUSES_FOR_AGENT = ["Delivered", "Failed"];

// ─── PATCH /api/orders/:id/status ───────────────────────────
/**
 * updateStatus
 *
 * The main status-update endpoint. Used by agents to move an order
 * through Picked Up → In Transit → Out for Delivery → Delivered/Failed.
 *
 * Body: { status: "In Transit", note: "optional note" }
 * For "Failed": { status: "Failed", note: "failureReason text" } — note
 * doubles as the failure reason here, since both are free-text agent input.
 */
const updateStatus = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { status: newStatus, note } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // ── Ownership check: agent can only update THEIR OWN assigned orders ──
    // This is authorization beyond role — role says "you're an agent",
    // this says "you're specifically THIS order's agent". Without this
    // check, any agent could update any order in the system.
    if (req.user.role === "agent") {
      if (!order.agent || !order.agent.equals(req.user._id)) {
        return res.status(403).json({
          success: false,
          message: "You can only update status on orders assigned to you.",
        });
      }
    }

    // ── Validate the transition against the state machine ──
    const valid = isValidTransition(order.status, newStatus, req.user.role);

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: `Cannot move from "${order.status}" to "${newStatus}" as ${req.user.role}. ` +
                 `Check the allowed transitions for this status.`,
      });
    }

    // "Failed" requires a reason — agent must explain why
    if (newStatus === "Failed" && !note) {
      return res.status(400).json({
        success: false,
        message: "A failure reason (note) is required when marking an order as Failed.",
      });
    }

    // ── Apply the update + log + release agent (if terminal) atomically ──
    await session.withTransaction(async () => {
      order.status = newStatus;
      if (newStatus === "Failed") {
        order.failureReason = note;
      }
      await order.save({ session });

      await TrackingLog.create(
        [
          {
            order: order._id,
            status: newStatus,
            actor: req.user._id,
            actorRole: req.user.role,
            note: note || "",
          },
        ],
        { session }
      );

      // If this status ends the agent's involvement, free them up.
      // This is the ONLY place isAvailable flips back to true — see the
      // design note in assignmentEngine.js about why this isn't manual.
      if (TERMINAL_STATUSES_FOR_AGENT.includes(newStatus) && order.agent) {
        await releaseAgent(order.agent, session);
      }
    });

    await order.populate(["agent", "customer", "pickup.zone", "drop.zone"]);

    // ── Fire the notification email ──
    // Deliberately NOT awaited inline with the response — we call it
    // without blocking, so a slow SMTP server never delays the API
    // response the agent/customer is waiting on. Errors inside
    // sendStatusEmail are caught internally and logged; they can never
    // throw back here and break this already-successful request.
    //
    // customerEmail comes from order.customer.email — populated from the
    // DB just above, NEVER from req.body. This is the security boundary
    // described in emailService.js: recipients are always resolved
    // server-side from the order's actual owner.
    sendStatusEmail({
      customerEmail: order.customer.email,
      customerName: order.customer.name,
      orderNumber: order.orderNumber,
      status: newStatus,
      note: newStatus === "Failed" ? order.failureReason : "",
    });

    res.status(200).json({
      success: true,
      message: `Order status updated to "${newStatus}".`,
      order,
    });

  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
};

// ─── PATCH /api/orders/:id/override-status ──────────────────
/**
 * overrideStatus
 *
 * Admin-only. Bypasses the state machine entirely — admin can set ANY
 * status regardless of the current one. This is the spec's requirement:
 * "Admin... can override any order status."
 *
 * We still log it through the SAME TrackingLog mechanism, but the note
 * is prefixed so it's visibly distinguishable from a normal lifecycle
 * transition in the timeline — admins overriding status is an exception
 * event, not routine, and the audit trail should make that obvious.
 */
const overrideStatus = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { status: newStatus, note } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const validStatuses = [
      "Pending", "Assigned", "Picked Up", "In Transit",
      "Out for Delivery", "Delivered", "Failed", "Rescheduled",
    ];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ success: false, message: "Invalid status value." });
    }

    const previousStatus = order.status;

    await session.withTransaction(async () => {
      order.status = newStatus;
      await order.save({ session });

      await TrackingLog.create(
        [
          {
            order: order._id,
            status: newStatus,
            actor: req.user._id,
            actorRole: "admin",
            note: `[ADMIN OVERRIDE] ${previousStatus} → ${newStatus}.` +
                  (note ? ` ${note}` : ""),
          },
        ],
        { session }
      );

      // If admin overrides INTO a terminal status, release the agent —
      // same rule applies regardless of how the order got there.
      if (TERMINAL_STATUSES_FOR_AGENT.includes(newStatus) && order.agent) {
        await releaseAgent(order.agent, session);
      }
    });

    await order.populate(["agent", "customer", "pickup.zone", "drop.zone"]);

    // Same fire-and-forget pattern as updateStatus — see comments there.
    sendStatusEmail({
      customerEmail: order.customer.email,
      customerName: order.customer.name,
      orderNumber: order.orderNumber,
      status: newStatus,
      note: `Status was manually updated by an administrator.${note ? ` ${note}` : ""}`,
    });

    res.status(200).json({
      success: true,
      message: `Admin override: status changed from "${previousStatus}" to "${newStatus}".`,
      order,
    });

  } catch (error) {
    console.error("Override status error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
};

// ─── GET /api/orders/:id/timeline ───────────────────────────
/**
 * getOrderTimeline
 *
 * Returns the full, chronologically-sorted tracking history for an order.
 * This IS the "customer can view live order status and full tracking
 * timeline" requirement from the spec.
 *
 * Access control: customer can only view their OWN order's timeline;
 * agent can only view orders assigned to them; admin can view any.
 */
const getOrderTimeline = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Ownership checks — same pattern as updateStatus
    if (req.user.role === "customer" && !order.customer.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    if (req.user.role === "agent" && (!order.agent || !order.agent.equals(req.user._id))) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    // admin: no restriction

    // Sort ascending — oldest event first, so the timeline reads top-to-
    // bottom in the order things actually happened
    const timeline = await TrackingLog.find({ order: order._id })
      .populate("actor", "name role")
      .sort({ timestamp: 1 });

    res.status(200).json({
      success: true,
      orderNumber: order.orderNumber,
      currentStatus: order.status,
      timeline,
    });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { updateStatus, overrideStatus, getOrderTimeline };