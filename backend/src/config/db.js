/**
 * Database Connection
 *
 * Centralises the MongoDB connection so we connect once at startup
 * and reuse the connection across all requests.
 *
 * Why not connect inside each route?
 * MongoDB connections are expensive to open. Mongoose maintains a
 * connection pool internally — we open it once, Mongoose handles
 * reuse and reconnection automatically.
 */

const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection error: ${error.message}`);
    // Exit process — app cannot function without DB
    process.exit(1);
  }
};

module.exports = connectDB;