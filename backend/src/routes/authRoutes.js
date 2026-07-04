/**
 * Auth Routes
 *
 * Maps HTTP method + URL → middleware chain → controller function.
 *
 * Middleware chains read left to right:
 *   protect        = must be authenticated (valid JWT)
 *   authorise(...) = must have one of these roles
 *
 * Public routes (no middleware):
 *   POST /api/auth/register   → anyone can register as customer
 *   POST /api/auth/login      → anyone can log in
 *
 * Protected routes:
 *   GET  /api/auth/me         → any logged-in user
 *   POST /api/auth/staff      → admin only
 */

const express = require("express");
const router = express.Router();

const { register, login, getMe, createStaff } = require("../controllers/authController");
const { protect, authorise } = require("../middleware/auth");

// Public — no auth required
router.post("/register", register);
router.post("/login", login);

// Protected — must be logged in
// protect runs first, attaches req.user, then getMe runs
router.get("/me", protect, getMe);

// Admin only — protect verifies token, authorise checks role
router.post("/staff", protect, authorise("admin"), createStaff);

module.exports = router;

// Admin: list all agents (for assignment dropdowns)
router.get("/agents", protect, authorise("admin"), async (req, res) => {
  try {
    const User = require("../models/User");
    const agents = await User.find({ role: "agent" })
      .populate("currentZone", "name")
      .select("name email phone isAvailable currentZone lastAssignedAt")
      .sort({ name: 1 });
    res.status(200).json({ success: true, agents });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});