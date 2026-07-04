/**
 * Reschedule Controller
 *
 * Handles the "Failed delivery → customer reschedules → reassigned" flow
 * required by the spec: "On failed delivery, customer receives notification
 * and can reschedule for a new date; agent is reassigned for the
 * rescheduled attempt."
 *
 * This is TWO state transitions chained behind ONE customer-facing action:
 *   1. Failed → Rescheduled   (this controller, customer-triggered)
 *   2. Rescheduled → Assigned (reuses Task 2.1's autoAssignAgent)
 *
 * Design decision: if step 2 fails (no agent available), we do NOT fail
 * the whole request. The reschedule itself succeeded — assignment is a
 * separate concern admin can resolve manually. See the inline try/catch
 * around the assignment step.
 */

const mongoose = require("mongoose");
const Order = require("../models/Order");
const TrackingLog = require("../models/TrackingLog");
const { isValidTransition } = require("../utils/statusTransitions");
const { autoAssignAgent } = require("../utils/assignmentEngine");
const { sendStatusEmail } = require("../utils/emailService");

// ─── PATCH /api/orders/:id/reschedule ───────────────────────
/**
 * reschedule
 *
 * Customer-triggered. Requires the order to currently be "Failed".
 * Body: { scheduledDate: "2026-07-05" } (ISO date string)
 */
const reschedule = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { scheduledDate } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // ── Ownership check: only the order's own customer can reschedule it ──
    if (!order.customer.equals(req.user._id)) {
      return res.status(403).json({
        success: false,
        message: "You can only reschedule your own orders.",
      });
    }

    // ── Validate scheduledDate is present and a real future date ──
    if (!scheduledDate) {
      return res.status(400).json({
        success: false,
        message: "scheduledDate is required.",
      });
    }

    const parsedDate = new Date(scheduledDate);

    // Date constructor returns "Invalid Date" for garbage input — isNaN
    // on its time value is the standard way to detect that in JS
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "scheduledDate must be a valid date.",
      });
    }

    // Compare against "now" — reschedule must be for a future date.
    // We zero out the time on "now" so "today" is still acceptable
    // (customer rescheduling for later today), only past CALENDAR
    // dates are rejected.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (parsedDate < today) {
      return res.status(400).json({
        success: false,
        message: "scheduledDate cannot be in the past.",
      });
    }

    // ── Validate the state transition: must currently be "Failed" ──
    // Reuses the SAME state machine from Task 2.2 — reschedule isn't a
    // special unchecked path, it's just another governed transition.
    const valid = isValidTransition(order.status, "Rescheduled", req.user.role);

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: `Cannot reschedule an order with status "${order.status}". ` +
                 `Only orders marked "Failed" can be rescheduled.`,
      });
    }

    // ── Transition 1: Failed → Rescheduled (atomic with its log entry) ──
    await session.withTransaction(async () => {
      order.status = "Rescheduled";
      order.scheduledDate = parsedDate;
      await order.save({ session });

      await TrackingLog.create(
        [
          {
            order: order._id,
            status: "Rescheduled",
            actor: req.user._id,
            actorRole: "customer",
            note: `Customer rescheduled delivery for ${parsedDate.toDateString()}.`,
          },
        ],
        { session }
      );
    });

    // ── Transition 2: Rescheduled → Assigned (separate, best-effort) ──
    // Deliberately OUTSIDE the transaction above and wrapped in its own
    // try/catch. If no agent is available right now, the reschedule has
    // still succeeded — we don't want a temporary agent shortage to roll
    // back the customer's recorded date preference.
    let assignmentMessage = "";

    try {
      // actorId = req.user._id (the customer triggered this whole flow),
      // but actorRole is "system" since the ASSIGNMENT itself is automatic,
      // not a manual customer action — keeps the audit trail accurate.
      await autoAssignAgent(order._id, req.user._id, "system");
      assignmentMessage = "A new agent has been assigned for the rescheduled delivery.";
    } catch (assignError) {
      // Expected failure mode: no agent currently available in the zone.
      // Order remains at "Rescheduled" with no agent — admin can assign
      // manually later via PATCH /orders/:id/assign.
      assignmentMessage = "No agent is currently available — admin will assign one manually.";
    }

    // Re-fetch to get the latest state after both transitions
    const updatedOrder = await Order.findById(order._id).populate([
      "agent", "customer", "pickup.zone", "drop.zone",
    ]);

    // Fire-and-forget — recipient resolved from updatedOrder.customer,
    // never from req.body, same security boundary as everywhere else.
    sendStatusEmail({
      customerEmail: updatedOrder.customer.email,
      customerName: updatedOrder.customer.name,
      orderNumber: updatedOrder.orderNumber,
      status: "Rescheduled",
      note: `New delivery date: ${parsedDate.toDateString()}.`,
    });

    res.status(200).json({
      success: true,
      message: `Delivery rescheduled for ${parsedDate.toDateString()}. ${assignmentMessage}`,
      order: updatedOrder,
    });

  } catch (error) {
    console.error("Reschedule error:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    await session.endSession();
  }
};

module.exports = { reschedule };


