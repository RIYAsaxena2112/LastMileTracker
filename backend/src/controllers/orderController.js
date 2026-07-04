/**
 * Order Controller — Creation
 *
 * This is where everything from Tasks 1.1–1.4 comes together:
 *   - User model (customer, agent, admin roles)
 *   - Zone detection (pickup/drop pincode → zone)
 *   - Rate engine (volumetric weight, billable weight, rate card, COD)
 *   - TrackingLog (immutable history — first entry written here)
 *
 * Two endpoints live here conceptually, but only ONE is new:
 *   - previewCharge already exists (rateCardController.js) — no DB writes
 *   - createOrder (this file) — the actual confirm step, writes to DB
 */

const mongoose = require("mongoose");
const Order = require("../models/Order");
const TrackingLog = require("../models/TrackingLog");
const User = require("../models/User");
const { calculateCharge } = require("../utils/rateEngine");
const { sendStatusEmail } = require("../utils/emailService");

// ─── POST /api/orders ────────────────────────────────────────
/**
 * createOrder
 *
 * Confirms and persists an order. This is what runs when the customer
 * clicks "Confirm Order" after seeing the preview price.
 *
 * SECURITY NOTE: we never accept a `charge` field from the request body.
 * Even if the frontend sends one (e.g. from the earlier preview call),
 * we ignore it and recalculate from scratch. The client cannot set its
 * own price — see the security note in calculateCharge usage below.
 *
 * Who can call this:
 *   - customer → creates their own order (req.user is the customer)
 *   - admin    → creates an order on behalf of a customer (customerId in body)
 *
 * Both writes (Order + first TrackingLog) happen inside a MongoDB
 * transaction — either both succeed or neither does. This guarantees
 * we never end up with an order that has no tracking history, which
 * would violate the "immutable tracking history" requirement.
 */
const createOrder = async (req, res) => {
  // Start a session for the transaction.
  // A session is required to group multiple writes into one atomic unit.
  const session = await mongoose.startSession();

  try {
    const {
      customerId,       // only used when admin creates on behalf of a customer
      pickupAddress,
      pickupPincode,
      pickupCity,
      dropAddress,
      dropPincode,
      dropCity,
      l,
      b,
      h,
      actualWeight,
      orderType,
      paymentType,
    } = req.body;

    // ── Step 1: Resolve who the customer is ──
    // If the logged-in user IS the customer (role === "customer"), they
    // can only create orders for themselves — req.user._id is the customer.
    // If the logged-in user is an admin, they must specify customerId.
    let customer;

    if (req.user.role === "customer") {
      customer = req.user._id;
    } else if (req.user.role === "admin") {
      if (!customerId) {
        return res.status(400).json({
          success: false,
          message: "Admin must specify customerId when creating an order on behalf of a customer.",
        });
      }

      // Verify the target user actually exists and is a customer
      // (prevents admin from accidentally assigning an order to an agent/admin account)
      const targetUser = await User.findById(customerId);
      if (!targetUser || targetUser.role !== "customer") {
        return res.status(400).json({
          success: false,
          message: "customerId must reference a valid customer account.",
        });
      }
      customer = targetUser._id;
    } else {
      // Agents are never allowed to create orders
      return res.status(403).json({
        success: false,
        message: "Only customers and admins can create orders.",
      });
    }

    // ── Step 2: Validate address fields are present ──
    // calculateCharge validates dimensions/weight/type internally,
    // but address text and city aren't part of that function's job —
    // check them here before we even attempt zone detection.
    if (!pickupAddress || !dropAddress) {
      return res.status(400).json({
        success: false,
        message: "Both pickup and drop addresses are required.",
      });
    }

    // ── Step 3: Run the rate engine ──
    // This is the SAME function used by the preview endpoint.
    // It performs zone detection, volumetric weight calc, rate card lookup,
    // and COD surcharge — all in one call. If anything is invalid
    // (bad pincode, no rate card configured, etc.) it throws an AppError
    // with the right HTTP status, which we catch below.
    const {
      pickupZone,
      dropZone,
      volumetricWeight,
      billableWeight,
      chargeBreakdown,
      totalCharge,
    } = await calculateCharge({
      pickupPincode,
      dropPincode,
      l: Number(l),
      b: Number(b),
      h: Number(h),
      actualWeight: Number(actualWeight),
      orderType,
      paymentType,
    });

    // ── Step 4: Create Order + first TrackingLog atomically ──
    let createdOrder;

    await session.withTransaction(async () => {
      // Mongoose requires passing { session } to every operation
      // that should be part of the transaction.

      // create() with an array + session is the documented way to
      // create a single document inside a transaction
      const [order] = await Order.create(
        [
          {
            customer,
            agent: null, // not assigned yet — Task 2.1 handles assignment
            createdBy: req.user._id,
            pickup: {
              address: pickupAddress,
              pincode: pickupPincode,
              city: pickupCity,
              zone: pickupZone._id,
            },
            drop: {
              address: dropAddress,
              pincode: dropPincode,
              city: dropCity,
              zone: dropZone._id,
            },
            dimensions: { l: Number(l), b: Number(b), h: Number(h) },
            actualWeight: Number(actualWeight),
            volumetricWeight,
            billableWeight,
            orderType,
            paymentType,
            charge: totalCharge,
            chargeBreakdown,
            status: "Pending", // every order starts here
          },
        ],
        { session }
      );

      // Write the FIRST tracking log entry — order creation itself
      // is a trackable event in the timeline.
      await TrackingLog.create(
        [
          {
            order: order._id,
            status: "Pending",
            actor: req.user._id,
            actorRole: req.user.role,
            note: "Order created.",
          },
        ],
        { session }
      );

      createdOrder = order;
    });

    // Populate references for a clean response — frontend gets zone names
    // and customer info without a second round-trip
    await createdOrder.populate([
      { path: "pickup.zone", select: "name" },
      { path: "drop.zone", select: "name" },
      { path: "customer", select: "name email phone" },
    ]);

    // Fire-and-forget confirmation email — same pattern used throughout
    // statusController.js. Recipient resolved from createdOrder.customer
    // (DB-populated above), never from req.body.
    sendStatusEmail({
      customerEmail: createdOrder.customer.email,
      customerName: createdOrder.customer.name,
      orderNumber: createdOrder.orderNumber,
      status: "Pending",
    });

    res.status(201).json({
      success: true,
      message: "Order created successfully.",
      order: createdOrder,
    });

  } catch (error) {
    // AppError (thrown by calculateCharge / zoneDetection) carries
    // the right HTTP status — use it, fall back to 500 otherwise
    const status = error.statusCode || 500;

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ success: false, message: messages.join(". ") });
    }

    console.error("Create order error:", error);
    res.status(status).json({ success: false, message: error.message });

  } finally {
    // Always end the session, whether the transaction succeeded or failed
    await session.endSession();
  }
};

module.exports = { createOrder };