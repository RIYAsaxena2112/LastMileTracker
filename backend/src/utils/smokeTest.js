/**
 * End-to-End Smoke Test
 *
 * Tests the full user journey against a running server + real Atlas DB.
 * Run with: node src/utils/smokeTest.js
 *
 * Prerequisites:
 *   1. .env file configured with a real MONGODB_URI
 *   2. Server running: npm run dev (in another terminal)
 *   3. DB seeded: npm run seed
 *
 * What this tests:
 *   - Auth (admin login, agent creation, customer registration)
 *   - Zone detection
 *   - Charge preview + order creation (verifies math matches)
 *   - Auto-assignment (isAvailable flip)
 *   - Full status lifecycle (6 TrackingLog entries)
 *   - Agent release after Delivered
 *   - Failed delivery → reschedule flow
 *   - State machine guard (invalid transition → 400)
 */

const dotenv = require("dotenv");
dotenv.config();

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;

// ─── HTTP helper ─────────────────────────────────────────────
async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

// ─── Assertion helper ─────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ─── Main test runner ─────────────────────────────────────────
async function runSmokeTest() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LastMile Delivery — End-to-End Smoke Test");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── 1. Health check ─────────────────────────────────────────
  console.log("[ 1 ] Server health");
  const health = await req("GET", "/health");
  assert("Server is reachable", health.status === 200, `Got ${health.status}`);

  // ── 2. Admin login ──────────────────────────────────────────
  console.log("\n[ 2 ] Admin login");
  const adminLogin = await req("POST", "/auth/login", {
    email: "admin@lastmile.test",
    password: "admin1234",
  });
  assert("Admin login succeeds", adminLogin.status === 200,
    adminLogin.data.message);
  assert("Response contains token", !!adminLogin.data.token);
  assert("Role is admin", adminLogin.data.user?.role === "admin");
  const adminToken = adminLogin.data.token;

  // ── 3. Create agent ─────────────────────────────────────────
  console.log("\n[ 3 ] Create agent account");
  // Get zones first to pick one for the agent
  const zonesRes = await req("GET", "/zones", null, adminToken);
  assert("Zones exist (seed ran)", zonesRes.data.zones?.length > 0,
    "Run: npm run seed");

  const zoneA = zonesRes.data.zones.find((z) => z.name === "Zone A");
  assert("Zone A found", !!zoneA);

  // Use timestamp in email to avoid collision on repeated test runs
  const agentEmail = `agent.smoke.${Date.now()}@test.com`;
  const createAgent = await req("POST", "/auth/staff", {
    name: "Smoke Test Agent",
    email: agentEmail,
    password: "agent1234",
    role: "agent",
    currentZone: zoneA?._id,
  }, adminToken);
  assert("Agent account created", createAgent.status === 201,
    createAgent.data.message);
  const agentId = createAgent.data.user?._id;

  // Agent login
  const agentLogin = await req("POST", "/auth/login", {
    email: agentEmail,
    password: "agent1234",
  });
  assert("Agent login succeeds", agentLogin.status === 200);
  const agentToken = agentLogin.data.token;

  // ── 4. Customer registration + login ────────────────────────
  console.log("\n[ 4 ] Customer registration + login");
  const customerEmail = `customer.smoke.${Date.now()}@test.com`;
  const register = await req("POST", "/auth/register", {
    name: "Smoke Customer",
    email: customerEmail,
    password: "cust1234",
  });
  assert("Customer registration succeeds", register.status === 201,
    register.data.message);
  assert("Customer role is customer", register.data.user?.role === "customer");
  const customerToken = register.data.token;
  const customerId = register.data.user?._id;

  // ── 5. Charge preview ────────────────────────────────────────
  console.log("\n[ 5 ] Charge preview (zone detection + rate engine)");
  const previewPayload = {
    pickupPincode: "560001",
    dropPincode: "110001",
    l: 40, b: 30, h: 20,
    actualWeight: 2,
    orderType: "B2C",
    paymentType: "COD",
  };
  const preview = await req("POST", "/rate-cards/preview", previewPayload, customerToken);
  assert("Preview succeeds", preview.status === 200, preview.data.message);
  assert("Pickup zone detected as Zone A",
    preview.data.pickupZone?.name === "Zone A",
    `Got: ${preview.data.pickupZone?.name}`);
  assert("Drop zone detected as Zone B",
    preview.data.dropZone?.name === "Zone B",
    `Got: ${preview.data.dropZone?.name}`);
  assert("Volumetric weight = 4.8 kg",
    preview.data.volumetricWeight === 4.8,
    `Got: ${preview.data.volumetricWeight}`);
  assert("Billable weight = 4.8 (volumetric wins over actual 2kg)",
    preview.data.billableWeight === 4.8,
    `Got: ${preview.data.billableWeight}`);
  assert("COD surcharge present",
    preview.data.chargeBreakdown?.codSurcharge > 0);
  const previewedCharge = preview.data.totalCharge;
  console.log(`     → Preview charge: ₹${previewedCharge}`);

  // ── 6. Create order ──────────────────────────────────────────
  console.log("\n[ 6 ] Order creation");
  const createOrder = await req("POST", "/orders", {
    pickupAddress: "123 MG Road",
    pickupPincode: "560001",
    pickupCity: "Bangalore",
    dropAddress: "45 Connaught Place",
    dropPincode: "110001",
    dropCity: "New Delhi",
    ...previewPayload,
  }, customerToken);
  assert("Order created", createOrder.status === 201, createOrder.data.message);
  assert("Status is Pending", createOrder.data.order?.status === "Pending");
  assert("Charge matches preview",
    createOrder.data.order?.charge === previewedCharge,
    `Order: ₹${createOrder.data.order?.charge} vs Preview: ₹${previewedCharge}`);
  assert("Order number generated",
    createOrder.data.order?.orderNumber?.startsWith("ORD-"));
  assert("Customer is correct",
    createOrder.data.order?.customer?._id === customerId ||
    createOrder.data.order?.customer === customerId);

  const orderId = createOrder.data.order?._id;
  const orderNumber = createOrder.data.order?.orderNumber;
  console.log(`     → Order: ${orderNumber}`);

  // ── 7. Auto-assign agent ─────────────────────────────────────
  console.log("\n[ 7 ] Auto-assignment");
  const assign = await req("PATCH", `/orders/${orderId}/auto-assign`, null, adminToken);
  assert("Auto-assign succeeds", assign.status === 200, assign.data.message);
  assert("Order status is Assigned", assign.data.order?.status === "Assigned");
  assert("Agent is attached", !!assign.data.order?.agent);

  // Verify agent isAvailable flipped to false
  const agentMe = await req("GET", "/auth/me", null, agentToken);
  assert("Agent isAvailable = false after assignment",
    agentMe.data.user?.isAvailable === false,
    `Got: ${agentMe.data.user?.isAvailable}`);

  // ── 8. Full status lifecycle ─────────────────────────────────
  console.log("\n[ 8 ] Status lifecycle (agent drives)");
  const steps = [
    { to: "Picked Up",        note: "" },
    { to: "In Transit",       note: "" },
    { to: "Out for Delivery", note: "" },
    { to: "Delivered",        note: "" },
  ];

  for (const step of steps) {
    const upd = await req("PATCH", `/orders/${orderId}/status`,
      { status: step.to, note: step.note }, agentToken);
    assert(`Transition to "${step.to}"`, upd.status === 200,
      upd.data.message);
  }

  // ── 9. TrackingLog count ─────────────────────────────────────
  console.log("\n[ 9 ] TrackingLog integrity");
  const timeline = await req("GET", `/orders/${orderId}/timeline`, null, customerToken);
  assert("Timeline accessible by customer", timeline.status === 200);
  assert("Timeline has 6 entries (Pending + Assigned + 4 agent steps)",
    timeline.data.timeline?.length === 6,
    `Got: ${timeline.data.timeline?.length}`);
  assert("First entry is Pending",
    timeline.data.timeline?.[0]?.status === "Pending");
  assert("Last entry is Delivered",
    timeline.data.timeline?.[5]?.status === "Delivered");

  // ── 10. Agent released after Delivered ───────────────────────
  console.log("\n[ 10 ] Agent availability after delivery");
  const agentAfter = await req("GET", "/auth/me", null, agentToken);
  assert("Agent isAvailable = true after Delivered",
    agentAfter.data.user?.isAvailable === true,
    `Got: ${agentAfter.data.user?.isAvailable}`);

  // ── 11. Failed delivery + reschedule ─────────────────────────
  console.log("\n[ 11 ] Failed delivery → reschedule flow");
  // Create a second order for the failure path
  const order2 = await req("POST", "/orders", {
    pickupAddress: "456 Brigade Road",
    pickupPincode: "560001",
    pickupCity: "Bangalore",
    dropAddress: "78 Lajpat Nagar",
    dropPincode: "110001",
    dropCity: "New Delhi",
    l: 20, b: 20, h: 10,
    actualWeight: 1,
    orderType: "B2C",
    paymentType: "Prepaid",
  }, customerToken);
  assert("Second order created", order2.status === 201);
  const order2Id = order2.data.order?._id;

  // Assign and push to Out for Delivery
  await req("PATCH", `/orders/${order2Id}/auto-assign`, null, adminToken);
  await req("PATCH", `/orders/${order2Id}/status`,
    { status: "Picked Up" }, agentToken);
  await req("PATCH", `/orders/${order2Id}/status`,
    { status: "In Transit" }, agentToken);
  await req("PATCH", `/orders/${order2Id}/status`,
    { status: "Out for Delivery" }, agentToken);

  // Agent marks Failed — must include a note
  const failNoNote = await req("PATCH", `/orders/${order2Id}/status`,
    { status: "Failed" }, agentToken);
  assert("Failed without note rejected (400)",
    failNoNote.status === 400,
    `Got: ${failNoNote.status}`);

  const failWithNote = await req("PATCH", `/orders/${order2Id}/status`,
    { status: "Failed", note: "Customer not at home during smoke test" }, agentToken);
  assert("Failed with note accepted", failWithNote.status === 200,
    failWithNote.data.message);

  // Agent should be free again after failure
  const agentAfterFail = await req("GET", "/auth/me", null, agentToken);
  assert("Agent released after Failed",
    agentAfterFail.data.user?.isAvailable === true);

  // Customer reschedules
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];
  const reschedule = await req("PATCH", `/orders/${order2Id}/reschedule`,
    { scheduledDate: tomorrow }, customerToken);
  assert("Reschedule succeeds", reschedule.status === 200, reschedule.data.message);
  assert("Order status is Rescheduled or Assigned",
    ["Rescheduled", "Assigned"].includes(reschedule.data.order?.status),
    `Got: ${reschedule.data.order?.status}`);
  assert("scheduledDate is set",
    !!reschedule.data.order?.scheduledDate);

  // ── 12. State machine guard ──────────────────────────────────
  console.log("\n[ 12 ] State machine guard");
  // Try Pending → Delivered (skips entire lifecycle)
  const order3 = await req("POST", "/orders", {
    pickupAddress: "Test", pickupPincode: "560001", pickupCity: "Bangalore",
    dropAddress: "Test", dropPincode: "110001", dropCity: "Delhi",
    l: 10, b: 10, h: 10, actualWeight: 1,
    orderType: "B2C", paymentType: "Prepaid",
  }, customerToken);
  const order3Id = order3.data.order?._id;

  // Agent can't update status (not their order — no agent assigned yet)
  const guardTest = await req("PATCH", `/orders/${order3Id}/status`,
    { status: "Delivered" }, agentToken);
  assert("Agent can't skip to Delivered from Pending (403 or 400)",
    [400, 403].includes(guardTest.status),
    `Got: ${guardTest.status} — ${guardTest.data.message}`);

  // Admin override — should always work
  const override = await req("PATCH", `/orders/${order3Id}/override-status`,
    { status: "Delivered", note: "Smoke test override" }, adminToken);
  assert("Admin override succeeds", override.status === 200,
    override.data.message);

  // Verify override appears in timeline with [ADMIN OVERRIDE] marker
  const overrideTl = await req("GET", `/orders/${order3Id}/timeline`, null, adminToken);
  const lastEntry = overrideTl.data.timeline?.slice(-1)[0];
  assert("Override logged with [ADMIN OVERRIDE] marker",
    lastEntry?.note?.includes("[ADMIN OVERRIDE]"),
    `Note: "${lastEntry?.note}"`);

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  ✓ All checks passed — safe to deploy.");
  } else {
    console.log("  ✗ Some checks failed — fix before deploying.");
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(failed > 0 ? 1 : 0);
}

runSmokeTest().catch((e) => {
  console.error("\nFatal error during smoke test:", e.message);
  console.error("Is the server running? (npm run dev)");
  process.exit(1);
});