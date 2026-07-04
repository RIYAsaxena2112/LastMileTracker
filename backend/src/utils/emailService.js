/**
 * Email Service
 *
 * SECURITY MODEL — read this before adding new call sites:
 * ──────────────────────────────────────────────────────────
 * 1. This module is NEVER called directly from a route handler with
 *    request-body data for "to" or "subject". It is only ever called
 *    internally, AFTER we've already loaded the order's actual customer
 *    from the database. There is no API endpoint that lets a client
 *    specify an arbitrary recipient — that would make this server an
 *    open relay.
 *
 * 2. Credentials (EMAIL_USER, EMAIL_PASS) live only in process.env,
 *    loaded from .env, which is git-ignored. Never hardcode them.
 *
 * 3. Any user-supplied text (e.g. an agent's failure-reason note) that
 *    gets embedded in the email body is escaped via escapeHtml() before
 *    insertion — prevents HTML/markup injection from rendering oddly
 *    or maliciously in the recipient's email client.
 *
 * 4. Sending is fire-and-forget from the caller's perspective — see
 *    sendStatusEmail's usage in statusController. We don't await email
 *    delivery inside the request/response cycle, so a slow SMTP server
 *    never makes the API feel broken. Errors are caught and logged,
 *    never thrown back to crash the triggering request.
 */

const nodemailer = require("nodemailer");

// ─── Transporter setup ───────────────────────────────────────
/**
 * Created once at module load, reused for every email — same idea as
 * the MongoDB connection pool. Creating a new transporter per email
 * would be wasteful (re-authenticating with the SMTP server every time).
 */
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false, // true for port 465, false for 587 (STARTTLS)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── HTML escaping ────────────────────────────────────────────
/**
 * escapeHtml
 *
 * Converts special HTML characters to their entity equivalents.
 * Applied to ANY user-supplied string before it's inserted into an
 * email's HTML body — e.g. an agent's failure note, a customer's name.
 *
 * Without this, a note like:
 *   "Customer not home <script>alert(1)</script>"
 * would be inserted raw into the HTML email body.
 */
const escapeHtml = (str) => {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

// ─── Status → human-readable message mapping ─────────────────
/**
 * Each status gets a tailored subject line and message, so the email
 * reads naturally rather than a generic "status changed to X".
 */
const STATUS_MESSAGES = {
  Pending: {
    subject: "Order Received",
    body: "We've received your order and are preparing it for pickup.",
  },
  Assigned: {
    subject: "Agent Assigned",
    body: "A delivery agent has been assigned to your order.",
  },
  "Picked Up": {
    subject: "Package Picked Up",
    body: "Your package has been picked up and is on its way.",
  },
  "In Transit": {
    subject: "Package In Transit",
    body: "Your package is currently in transit.",
  },
  "Out for Delivery": {
    subject: "Out for Delivery",
    body: "Your package is out for delivery and should arrive soon.",
  },
  Delivered: {
    subject: "Package Delivered",
    body: "Your package has been delivered successfully.",
  },
  Failed: {
    subject: "Delivery Attempt Failed",
    body: "We were unable to deliver your package. You can reschedule from your order page.",
  },
  Rescheduled: {
    subject: "Delivery Rescheduled",
    body: "Your delivery has been rescheduled.",
  },
};

// ─── Core send function ───────────────────────────────────────
/**
 * sendStatusEmail
 *
 * Sends a status-update notification email for an order.
 *
 * IMPORTANT: `customerEmail` and `customerName` must come from a DB
 * lookup the CALLER already performed (e.g. order.customer.email after
 * populate) — never from req.body. This function has no way to enforce
 * that itself, which is exactly why the security model note at the top
 * of this file matters: it's a contract callers must honour.
 *
 * @param {Object} params
 * @param {string} params.customerEmail
 * @param {string} params.customerName
 * @param {string} params.orderNumber
 * @param {string} params.status        - one of the keys in STATUS_MESSAGES
 * @param {string} [params.note]        - optional extra detail (e.g. failure reason)
 */
const sendStatusEmail = async ({ customerEmail, customerName, orderNumber, status, note }) => {
  const statusInfo = STATUS_MESSAGES[status] || {
    subject: "Order Update",
    body: `Your order status has been updated to ${status}.`,
  };

  // Escape user-supplied fields before embedding in HTML
  const safeName = escapeHtml(customerName);
  const safeNote = escapeHtml(note);
  const safeOrderNumber = escapeHtml(orderNumber);

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">${escapeHtml(statusInfo.subject)}</h2>
      <p>Hi ${safeName},</p>
      <p>${escapeHtml(statusInfo.body)}</p>
      ${safeNote ? `<p style="color: #555;"><strong>Note:</strong> ${safeNote}</p>` : ""}
      <p style="margin-top: 24px; color: #888; font-size: 13px;">
        Order #${safeOrderNumber}
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: customerEmail, // resolved server-side from the order's customer, never client input
      subject: `${statusInfo.subject} — Order #${orderNumber}`,
      html,
    });
  } catch (error) {
    // Never let an email failure break the calling request — log and move on.
    // The order status update has already succeeded by the time this runs;
    // a flaky SMTP server shouldn't make the whole API call look like it failed.
    console.error(`Failed to send status email for order ${orderNumber}:`, error.message);
  }
};

module.exports = { sendStatusEmail, escapeHtml };