/**
 * TrackingLog Model
 *
 * Append-only event log. Every status change creates a NEW document here.
 * We NEVER update or delete tracking logs.
 *
 * Why a separate collection instead of an array on Order?
 * ────────────────────────────────────────────────────────
 * 1. MongoDB documents have a 16MB size limit. An order with many status
 *    changes would bloat if we embedded logs in the Order document.
 *
 * 2. A separate collection makes it STRUCTURALLY IMPOSSIBLE to update
 *    a past log by accident — there's no findByIdAndUpdate path here.
 *    Immutability is enforced by design, not discipline.
 *
 * 3. We can query "all recent status changes across all orders" without
 *    loading full order documents (useful for admin dashboards).
 *
 * How the customer timeline works:
 *   TrackingLog.find({ order: orderId }).sort({ timestamp: 1 })
 *   → returns every status change in chronological order
 *
 * Why store actorRole separately?
 *   If an agent is later promoted to admin, querying actor.role would
 *   show "admin" even for events when they acted as an agent.
 *   Snapshotting the role at log-creation time keeps history accurate.
 */

const mongoose = require("mongoose");

const trackingLogSchema = new mongoose.Schema({
  // Which order this event belongs to.
  // We index this — the most common query is "all logs for order X".
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    required: [true, "Order reference is required"],
    index: true,
  },

  // The status at the time of this log entry (not necessarily current status)
  status: {
    type: String,
    required: [true, "Status is required"],
    enum: [
      "Pending",
      "Assigned",
      "Picked Up",
      "In Transit",
      "Out for Delivery",
      "Delivered",
      "Failed",
      "Rescheduled",
    ],
  },

  // Who triggered this status change
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: [true, "Actor is required"],
  },

  // Snapshot of the actor's role at the time of this change
  // Kept separate from actor.role so history stays accurate
  actorRole: {
    type: String,
    enum: ["customer", "agent", "admin", "system"],
    required: true,
  },

  // Optional note — agent can write "Customer not at home" for a Failed status.
  // Also used for reschedule notes: "Rescheduled to 15 Jun 2024"
  note: {
    type: String,
    trim: true,
    default: "",
  },

  // When this event happened.
  // Indexed + sorted ascending to build the customer-facing timeline.
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

// ─── Prevent updates — make this truly append-only ──────────
// Mongoose middleware that blocks any .update() / .findByIdAndUpdate()
// call on TrackingLog. Attempting to update will throw an error.
// This is a safety net — the app code shouldn't be calling update here
// anyway, but this makes the intent explicit.
trackingLogSchema.pre(["updateOne", "findOneAndUpdate"], function () {
  throw new Error(
    "TrackingLog is append-only. Create a new log entry instead of updating."
  );
});

module.exports = mongoose.model("TrackingLog", trackingLogSchema);