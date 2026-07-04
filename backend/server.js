/**
 * Server Entry Point
 *
 * Sets up Express, connects to MongoDB, and mounts all routes.
 * This file should stay thin — configuration belongs in config/,
 * routes in routes/, logic in controllers/.
 */

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load environment variables from .env file FIRST
// Must happen before any other code that reads process.env
dotenv.config();

const connectDB = require("./config/db");

const app = express();

// ─── Connect to MongoDB ──────────────────────────────────────
connectDB();

// ─── Global middleware ───────────────────────────────────────

// CORS — allow requests from our React frontend
// In production, replace origin with your actual deployed frontend URL
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:5173",
  credentials: true, // allow cookies if we ever use them
}));

// Parse incoming JSON request bodies (req.body)
// Without this, req.body would be undefined in POST/PATCH routes
app.use(express.json());

// Parse URL-encoded form data (not used much with a JSON API, but good to have)
app.use(express.urlencoded({ extended: true }));

// ─── Routes ─────────────────────────────────────────────────
// All auth routes are prefixed with /api/auth
// e.g., POST /api/auth/login, GET /api/auth/me
app.use("/api/auth", require("./routes/authRoutes"));

app.use("/api/zones", require("./routes/zoneRoutes"));
app.use("/api/rate-cards", require("./routes/rateCardRoutes"));
app.use("/api/orders", require("./routes/orderRoutes"));
// More routes will be added here as we build:
// app.use("/api/rate-cards", require("./routes/rateCardRoutes"));
// app.use("/api/orders", require("./routes/orderRoutes"));

// ─── Health check ────────────────────────────────────────────
// Simple route to verify the server is running (used by Render for health checks)
app.get("/api/health", (req, res) => {
  res.status(200).json({ success: true, message: "Server is running." });
});

// ─── 404 handler ─────────────────────────────────────────────
// Catches any request to a route that doesn't exist
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.originalUrl} not found.` });
});

// ─── Global error handler ────────────────────────────────────
// Express calls this when next(error) is called or an unhandled error occurs
// The 4-parameter signature (err, req, res, next) is what tells Express
// this is an error handler — don't remove the `next` param even if unused
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Something went wrong on the server.",
  });
});

// ─── Start server ────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});