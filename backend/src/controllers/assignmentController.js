/**
 * Assignment Controller
 *
 * Thin layer over assignmentEngine.js — controllers just validate the
 * request and call the engine, same pattern as orderController calling
 * rateEngine.
 */

const { autoAssignAgent, manualAssignAgent } = require("../utils/assignmentEngine");

// ─── PATCH /api/orders/:id/auto-assign ──────────────────────
/**
 * Admin triggers auto-assignment for a specific order.
 * The engine finds the best available agent in the pickup zone.
 */
const autoAssign = async (req, res) => {
  try {
    const order = await autoAssignAgent(req.params.id, req.user._id, "admin");

    res.status(200).json({
      success: true,
      message: `Order auto-assigned to ${order.agent.name}.`,
      order,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
};

// ─── PATCH /api/orders/:id/assign ───────────────────────────
/**
 * Admin manually picks a specific agent for an order.
 * Body: { agentId }
 */
const manualAssign = async (req, res) => {
  try {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, message: "agentId is required." });
    }

    const order = await manualAssignAgent(req.params.id, agentId, req.user._id);

    res.status(200).json({
      success: true,
      message: `Order manually assigned to ${order.agent.name}.`,
      order,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
};

module.exports = { autoAssign, manualAssign };