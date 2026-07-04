/**
 * Auth Middleware
 *
 * Two middleware functions work together on every protected route:
 *
 *   protect        → verifies the JWT, attaches req.user
 *   authorise(...) → checks req.user.role against allowed roles
 *
 * Usage on a route:
 *
 *   router.get("/admin/orders",
 *     protect,                        // must be logged in
 *     authorise("admin"),             // must be admin
 *     getAllOrders
 *   );
 *
 *   router.patch("/orders/:id/status",
 *     protect,
 *     authorise("agent", "admin"),    // agent OR admin can update status
 *     updateOrderStatus
 *   );
 *
 * Why two separate functions instead of one?
 * Because protect (authentication) and authorise (authorisation) are
 * different concerns. Some routes need authentication but no role check
 * (e.g., GET /orders/:id — customer, agent, and admin all need access).
 * Keeping them separate lets you compose exactly the access rules you need.
 */

const jwt = require("jsonwebtoken");
const User = require("../models/User");

// ─── protect ────────────────────────────────────────────────
/**
 * Verifies the JWT from the Authorization header.
 * Attaches the full user document to req.user on success.
 *
 * Why fetch the user from DB here instead of just using the JWT payload?
 * The JWT payload only has userId and role. Route handlers often need more —
 * the user's name for emails, currentZone for agents, etc.
 * Fetching from DB also means deactivated users are rejected immediately
 * even if their token hasn't expired yet.
 *
 * The -password in select("-password") tells Mongoose to exclude the
 * password hash from this query result.
 */
const protect = async (req, res, next) => {
  try {
    // 1. Extract token from the Authorization header
    //    The header looks like: "Bearer eyJhbGciOi..."
    //    We split on space and take the second part.
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "No token provided. Please log in.",
      });
    }

    const token = authHeader.split(" ")[1];

    // 2. Verify the token's signature using our secret key
    //    If the token was tampered with OR has expired, jwt.verify throws.
    //    We let it throw and catch it below.
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded is now: { userId: "...", role: "admin", iat: ..., exp: ... }

    // 3. Fetch the actual user from DB using the userId in the token
    //    This also catches cases where the user was deleted after token issue.
    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User belonging to this token no longer exists.",
      });
    }

    // 4. Attach user to the request object so downstream middleware
    //    and route handlers can access it without another DB query.
    req.user = user;

    next(); // hand off to the next middleware or route handler

  } catch (error) {
    // jwt.verify throws specific error types we can handle gracefully
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token. Please log in again.",
      });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token has expired. Please log in again.",
      });
    }

    // Unexpected error
    return res.status(500).json({
      success: false,
      message: "Authentication error.",
    });
  }
};

// ─── authorise ───────────────────────────────────────────────
/**
 * Returns a middleware function that checks if req.user.role
 * is in the list of allowed roles.
 *
 * This is a "middleware factory" — it returns a function, it isn't
 * one itself. That's why you call it: authorise("admin", "agent")
 * not just authorise.
 *
 * Must always run AFTER protect, since it reads req.user.
 *
 * Example:
 *   authorise("admin")            → only admins
 *   authorise("agent", "admin")   → agents and admins
 *   authorise("customer")         → only customers
 */
const authorise = (...allowedRoles) => {
  // The actual middleware function returned and used by Express
  return (req, res, next) => {
    // req.user was set by protect middleware above
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. This route is restricted to: ${allowedRoles.join(", ")}.`,
      });
    }

    next(); // role check passed, proceed to route handler
  };
};

module.exports = { protect, authorise };