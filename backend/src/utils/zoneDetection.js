/**
 * Zone Detection Utility
 *
 * A single reusable function: given a pincode, return the Zone document.
 *
 * Why a separate utility file and not inside the controller?
 * Both order creation AND the charge-preview endpoint need zone detection.
 * If we put it in the controller, we'd duplicate it. Utilities are for
 * logic that's needed in more than one place.
 *
 * Usage:
 *   const { detectZone } = require("../utils/zoneDetection");
 *   const zone = await detectZone("560001");
 *   // zone = { _id: ObjectId("..."), name: "Zone A", ... }
 *   // throws AppError if pincode not found
 */

const { Area } = require("../models/Zone");

/**
 * Custom error class for application-level errors.
 *
 * Why not just throw new Error()?
 * Plain Error objects don't carry an HTTP status code.
 * When the global error handler catches this, it can read
 * err.statusCode and send the right HTTP status (400, 404, etc.)
 * instead of always sending 500.
 */
class AppError extends Error {
  constructor(message, statusCode) {
    super(message); // sets this.message
    this.statusCode = statusCode;
    this.isOperational = true; // marks it as a known, expected error
  }
}

/**
 * detectZone
 *
 * Looks up a pincode in the Areas collection and returns the populated Zone.
 *
 * @param {string} pincode  - The pincode to look up (e.g., "560001")
 * @param {string} label    - "Pickup" or "Drop" — used in error messages
 * @returns {Object}        - The full Zone document (populated from Area.zone)
 * @throws {AppError}       - 400 if pincode is missing, 404 if not configured
 */
const detectZone = async (pincode, label = "Address") => {
  // Guard: pincode must be present and non-empty
  if (!pincode || !pincode.toString().trim()) {
    throw new AppError(`${label} pincode is required.`, 400);
  }

  // Normalise: trim whitespace, ensure string type
  // A customer might type "560001 " with a trailing space — handle it
  const normalisedPincode = pincode.toString().trim();

  // Single indexed query — the pincode field has a unique index on Area
  // .populate("zone") fetches the full Zone document in the same round-trip
  // via MongoDB $lookup under the hood
  const area = await Area.findOne({ pincode: normalisedPincode }).populate("zone");

  // Pincode exists in our DB but zone ref is broken (data integrity issue)
  // Unlikely but defensive — better than a null reference error later
  if (area && !area.zone) {
    throw new AppError(
      `${label} pincode ${normalisedPincode} is not assigned to any zone. Contact support.`,
      500
    );
  }

  // Pincode not in our Areas collection at all
  // This is the expected "not found" case — admin hasn't added it yet
  if (!area) {
    throw new AppError(
      `${label} pincode ${normalisedPincode} is not in any configured service zone. ` +
      `Please contact support or try a different pincode.`,
      404
    );
  }

  // Return just the zone document — callers don't need the Area wrapper
  return area.zone;
};

/**
 * detectBothZones
 *
 * Detects zones for both pickup and drop pincodes in parallel.
 * Uses Promise.all so both DB queries run simultaneously — faster
 * than awaiting them one after the other.
 *
 * @param {string} pickupPincode
 * @param {string} dropPincode
 * @returns {{ pickupZone, dropZone, isIntraZone }}
 */
const detectBothZones = async (pickupPincode, dropPincode) => {
  // Run both lookups at the same time instead of sequentially
  // Sequential:  ~50ms + ~50ms = ~100ms total
  // Parallel:    max(~50ms, ~50ms) = ~50ms total
  const [pickupZone, dropZone] = await Promise.all([
    detectZone(pickupPincode, "Pickup"),
    detectZone(dropPincode, "Drop"),
  ]);

  // Mongoose ObjectIds need .equals() for value comparison
  // pickupZone._id === dropZone._id would always be false (different objects)
  const isIntraZone = pickupZone._id.equals(dropZone._id);

  return { pickupZone, dropZone, isIntraZone };
};

module.exports = { detectZone, detectBothZones, AppError };