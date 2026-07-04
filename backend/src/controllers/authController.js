/**
 * Auth Controller
 *
 * Handles user registration, login, and profile retrieval.
 *
 * Controllers are intentionally thin — they validate input,
 * call models, and send responses. Business logic lives in models
 * (password hashing, token generation) not here.
 */

const jwt = require("jsonwebtoken");
const User = require("../models/User");

// ─── Helper: sign a JWT ──────────────────────────────────────
/**
 * Centralised token generation.
 * Both register and login call this — keeps signing logic in one place.
 *
 * We put userId AND role in the payload.
 * - userId: so middleware can fetch the full user from DB
 * - role: so authorise() middleware can check role WITHOUT a DB lookup
 *
 * Note: never put sensitive data (password, payment info) in the payload.
 * The payload is Base64-encoded, not encrypted — anyone can decode it.
 */
const signToken = (userId, role) => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
};

// ─── Helper: send token response ────────────────────────────
/**
 * Standardises how we respond after auth success.
 * Always sends: { success, token, user }
 */
const sendTokenResponse = (user, statusCode, res) => {
  const token = signToken(user._id, user.role);

  res.status(statusCode).json({
    success: true,
    token,
    // user.toJSON() automatically removes password (see User model)
    user,
  });
};

// ─── POST /auth/register ─────────────────────────────────────
/**
 * Public route — anyone can register as a customer.
 * Agents and admins are created by an admin (not via self-registration).
 *
 * Why not allow agent/admin self-registration?
 * Agents need to be vetted and assigned a zone. Admins are internal staff.
 * Letting anyone register as admin would be a critical security flaw.
 */
const register = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    // Basic input validation — keep it simple, Mongoose schema validates types
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, and password are required.",
      });
    }

    // Check if email is already registered
    // We do this before attempting to save to give a clear error message.
    // (Mongoose would also throw a duplicate key error, but that's less clear.)
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    // Create user — role defaults to "customer" (see User model)
    // Password hashing happens automatically in the pre-save hook
    const user = await User.create({ name, email, password, phone });

    sendTokenResponse(user, 201, res);

  } catch (error) {
    // Mongoose validation error (e.g., email format invalid)
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(". ") });
    }

    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Server error during registration." });
  }
};

// ─── POST /auth/login ────────────────────────────────────────
/**
 * All roles use the same login endpoint.
 * Role determines what the frontend shows after login.
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    // Find user and explicitly include password (it's select: false in schema)
    // We need the password hash to compare — but only here, nowhere else.
    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");

    if (!user) {
      // Intentionally vague — don't tell the caller whether email or password is wrong.
      // "Email not found" helps attackers enumerate valid accounts.
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    // comparePassword is defined as an instance method on User model
    const isPasswordCorrect = await user.comparePassword(password);

    if (!isPasswordCorrect) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
    }

    sendTokenResponse(user, 200, res);

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error during login." });
  }
};

// ─── GET /auth/me ────────────────────────────────────────────
/**
 * Protected route — returns the currently logged-in user's profile.
 * Used by the frontend on app load to restore session state.
 *
 * req.user is already populated by the protect middleware — no DB query needed.
 */
const getMe = (req, res) => {
  res.status(200).json({
    success: true,
    user: req.user,
  });
};

// ─── POST /auth/create-staff (admin only) ────────────────────
/**
 * Admin creates agent or admin accounts.
 * Agents need a zone assigned at creation time.
 */
const createStaff = async (req, res) => {
  try {
    const { name, email, password, phone, role, currentZone } = req.body;

    // Only allow creating agent or admin via this route
    if (!["agent", "admin"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "This route is for creating agent or admin accounts only.",
      });
    }

    // Agents must have a zone assigned
    if (role === "agent" && !currentZone) {
      return res.status(400).json({
        success: false,
        message: "A zone must be assigned when creating an agent.",
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists.",
      });
    }

    const user = await User.create({
      name,
      email,
      password,
      phone,
      role,
      currentZone: role === "agent" ? currentZone : null,
      isAvailable: role === "agent" ? true : undefined,
    });

    // Don't send a login token here — admin created this account,
    // the staff member will log in themselves separately.
    res.status(201).json({
      success: true,
      message: `${role} account created successfully.`,
      user,
    });

  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(". ") });
    }

    console.error("Create staff error:", error);
    res.status(500).json({ success: false, message: "Server error." });
  }
};

module.exports = { register, login, getMe, createStaff };