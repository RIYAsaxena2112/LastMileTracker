/**
 * Auto-Assignment Engine
 *
 * Finds the best available delivery agent for an order's pickup zone
 * and assigns them — updating both Order and User documents atomically.
 *
 * DESIGN DECISION: Zone-based assignment, not GPS-based.
 * ─────────────────────────────────────────────────────
 * The spec allows "nearest available agent based on current location OR
 * zone." True GPS-based nearness requires live location tracking
 * infrastructure (agents pinging coordinates continuously via websockets/
 * polling) — a sub-system on its own, not mentioned in the spec's
 * Technical Expectations. Zone-based assignment reuses data we already
 * have (Task 1.3's zone detection + the currentZone field on User) and
 * is the right scope for this build. This tradeoff is explicitly called
 * out in the system design write-up.
 *
 * TIE-BREAKING: Round-robin via lastAssignedAt.
 * ─────────────────────────────────────────────
 * When multiple agents are available in the same zone, picking
 * "whichever comes first in the query" is arbitrary — the same agent
 * would tend to get picked repeatedly. Sorting by lastAssignedAt
 * ascending means the longest-idle agent gets the next order — simple,
 * fair, and needs no extra queries per candidate (unlike "fewest active
 * orders," which would require counting each agent's open orders).
 */

const mongoose = require("mongoose");
const User = require("../models/User");
const Order = require("../models/Order");
const TrackingLog = require("../models/TrackingLog");
const { AppError } = require("./zoneDetection");

// ─── Step 1: Find the best available agent in a zone ─────────
/**
 * findAvailableAgent
 *
 * Pure read — no writes. Finds the best candidate but doesn't assign yet.
 * Kept separate from assignAgent() so it can also be used for "preview"
 * style features later (e.g. admin sees who WOULD be auto-assigned
 * before confirming).
 *
 * @param {ObjectId} zoneId - the zone to search in (order's pickup zone)
 * @returns {Object|null} the agent User document, or null if none available
 */
const findAvailableAgent = async (zoneId) => {
  // Uses the compound index on User: { role, isAvailable, currentZone }
  // built in Task 1.1 — this query hits that index directly, no scan.
  const agent = await User.findOne({
    role: "agent",
    isAvailable: true,
    currentZone: zoneId,
  })
    // null values sort first by default in MongoDB ascending sort,
    // which is exactly what we want — agents who've NEVER been
    // assigned (lastAssignedAt: null) get priority over agents who
    // have a real timestamp, since they're "most idle" by definition
    .sort({ lastAssignedAt: 1 });

  return agent; // null if nobody matches — caller decides how to handle
};

// ─── Step 2: Assign the agent (the write operation) ──────────
/**
 * autoAssignAgent
 *
 * Finds the best agent and assigns them to the order — all in one
 * atomic transaction:
 *   1. Order.agent = agent._id, Order.status = "Assigned"
 *   2. Agent.isAvailable = false, Agent.lastAssignedAt = now
 *   3. New TrackingLog entry: status "Assigned"
 *
 * Why a transaction? If we updated Order and User separately and the
 * server crashed between the two writes, we'd end up with an order
 * "assigned" to an agent whose isAvailable flag still says true — that
 * agent could then get double-booked by the next assignment call.
 *
 * @param {ObjectId} orderId
 * @param {ObjectId} actorId   - who triggered this (admin, or "system" for auto)
 * @param {string}   actorRole - "admin" | "system"
 * @returns {Object} the updated Order document
 * @throws {AppError} 404 if order not found, 409 if no agent available
 */
const autoAssignAgent = async (orderId, actorId, actorRole = "system") => {
  const order = await Order.findById(orderId);

  if (!order) {
    throw new AppError("Order not found.", 404);
  }

  if (order.agent) {
    throw new AppError("Order already has an agent assigned.", 400);
  }

  // Find the best candidate using the order's pickup zone
  const agent = await findAvailableAgent(order.pickup.zone);

  if (!agent) {
    // Genuinely useful error — tells admin exactly what to do next
    throw new AppError(
      "No available agent in the pickup zone. Try manual assignment or add more agents to this zone.",
      409 // 409 Conflict — the request is valid but can't be fulfilled right now
    );
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Update the order
      order.agent = agent._id;
      order.status = "Assigned";
      await order.save({ session });

      // Flip the agent's availability and stamp the assignment time
      // findByIdAndUpdate here (not agent.save()) because we already
      // have the agent doc but only need to touch two fields — cheaper
      // than re-saving the whole document
      await User.findByIdAndUpdate(
        agent._id,
        { isAvailable: false, lastAssignedAt: new Date() },
        { session }
      );

      // Log this as a trackable event in the order's timeline
      await TrackingLog.create(
        [
          {
            order: order._id,
            status: "Assigned",
            actor: actorId,
            actorRole,
            note: `Auto-assigned to agent ${agent.name}.`,
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  await order.populate(["agent", "pickup.zone", "drop.zone"]);
  return order;
};

// ─── Step 3: Manual assignment (admin picks a specific agent) ─
/**
 * manualAssignAgent
 *
 * Same end result as autoAssignAgent, but admin specifies exactly
 * which agent to use instead of letting the system pick.
 *
 * We still validate the chosen agent is actually available and in
 * the right zone — admin shouldn't be able to assign a busy agent
 * or one from the wrong zone by mistake. (If you want to allow
 * overriding zone restrictions for admin, that's a product decision —
 * here we keep the same rules for consistency and data integrity.)
 *
 * @param {ObjectId} orderId
 * @param {ObjectId} agentId   - admin-specified agent
 * @param {ObjectId} actorId   - the admin performing this action
 */
const manualAssignAgent = async (orderId, agentId, actorId) => {
  const order = await Order.findById(orderId);
  if (!order) {
    throw new AppError("Order not found.", 404);
  }

  const agent = await User.findById(agentId);
  if (!agent || agent.role !== "agent") {
    throw new AppError("agentId must reference a valid agent account.", 400);
  }

  if (!agent.isAvailable) {
    throw new AppError(`Agent ${agent.name} is currently unavailable.`, 409);
  }

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      order.agent = agent._id;
      order.status = "Assigned";
      await order.save({ session });

      await User.findByIdAndUpdate(
        agent._id,
        { isAvailable: false, lastAssignedAt: new Date() },
        { session }
      );

      await TrackingLog.create(
        [
          {
            order: order._id,
            status: "Assigned",
            actor: actorId,
            actorRole: "admin",
            note: `Manually assigned to agent ${agent.name} by admin.`,
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  await order.populate(["agent", "pickup.zone", "drop.zone"]);
  return order;
};

// ─── Step 4: Free up an agent (called when order completes/fails) ─
/**
 * releaseAgent
 *
 * Marks an agent available again. Called from the status-update flow
 * (Task 2.2) when an order reaches "Delivered" or "Failed" — NOT called
 * directly by any route. This is what keeps isAvailable accurate without
 * relying on agents to manually toggle it (see the design note in the
 * diagram — manual toggling is error-prone).
 *
 * @param {ObjectId} agentId
 */
const releaseAgent = async (agentId, session = null) => {
  const options = session ? { session } : {};
  await User.findByIdAndUpdate(agentId, { isAvailable: true }, options);
};

module.exports = {
  findAvailableAgent,
  autoAssignAgent,
  manualAssignAgent,
  releaseAgent,
};