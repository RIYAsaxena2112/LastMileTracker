# LastMile Delivery Tracker

A full-stack last-mile delivery management platform with role-based auth, an admin-configurable rate calculation engine, zone-based auto-assignment, immutable order tracking, and email notifications on every status change.

**Live demo:** [your-app.vercel.app](https://your-app.vercel.app)  
**Backend API:** [your-api.onrender.com](https://your-api.onrender.com)

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Architecture Overview](#architecture-overview)
3. [Local Setup](#local-setup)
4. [Environment Variables](#environment-variables)
5. [Database Schema](#database-schema)
6. [Rate Calculation Logic](#rate-calculation-logic)
7. [API Documentation](#api-documentation)
8. [Project Structure](#project-structure)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express.js |
| Database | MongoDB (Mongoose ODM) |
| Frontend | React 18 (Vite) |
| Auth | JWT (jsonwebtoken + bcryptjs) |
| Email | Nodemailer (Gmail / Brevo SMTP) |
| Deployment | Backend → Render, Frontend → Vercel, DB → MongoDB Atlas |

No queues, no external services beyond SMTP. Dependencies kept minimal per project requirements.

---

## Architecture Overview

```
┌──────────────┐     REST/JSON     ┌──────────────────────────────┐
│   React SPA  │ ◄───────────────► │        Express API           │
│  (Vercel)    │                   │        (Render)              │
└──────────────┘                   └──────────┬───────────────────┘
                                              │
                              ┌───────────────┴──────────────┐
                              │                              │
                    ┌─────────▼────────┐         ┌──────────▼──────────┐
                    │  MongoDB Atlas   │         │   Nodemailer SMTP   │
                    │  (5 collections) │         │   (status emails)   │
                    └──────────────────┘         └─────────────────────┘
```

Three user roles, three separate React UIs served from the same SPA — the router redirects each role to the correct shell on login:

- **Customer** — place orders, track deliveries, reschedule failed attempts
- **Agent** — view assigned orders, push status through the lifecycle
- **Admin** — configure zones/rate cards, manage orders, assign agents, override status

---

## Local Setup

### Prerequisites

- Node.js 18+
- A MongoDB Atlas account (free M0 tier is sufficient)
- A Gmail account with App Password enabled, or a Brevo free account

### 1. Clone and install

```bash
git clone <your-repo-url>
cd lastmile-delivery

# Install backend dependencies
cd backend && npm install

# Install frontend dependencies
cd ../frontend && npm install
```

### 2. Configure environment

```bash
cd backend
cp .env.example .env
# Edit .env with your real values — see Environment Variables section
```

### 3. Seed the database

```bash
cd backend
npm run seed
```

This creates:
- Admin account: `admin@lastmile.test` / `admin1234`
- Zone A (pincodes 560001, 560002 — Bangalore)
- Zone B (pincodes 110001, 110002 — New Delhi)
- Four B2C rate cards (intra-A, intra-B, A→B, B→A)

### 4. Run the servers

```bash
# Terminal 1 — backend (port 5000)
cd backend && npm run dev

# Terminal 2 — frontend (port 5173)
cd frontend && npm run dev
```

### 5. Smoke test (optional but recommended)

With the server running:

```bash
cd backend && npm run test:smoke
```

Runs 12 end-to-end checks covering auth, zone detection, rate engine, order lifecycle, and the failed delivery flow. All checks must pass before deploying.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

```bash
# MongoDB Atlas connection string
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/lastmile?retryWrites=true&w=majority

# JWT — generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=your_long_random_secret_here
JWT_EXPIRES_IN=7d

# Server
PORT=5000
NODE_ENV=development

# Email (Gmail with App Password, or Brevo SMTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_gmail@gmail.com
EMAIL_PASS=your_16_char_app_password
EMAIL_FROM="LastMile Delivery <your_gmail@gmail.com>"

# Frontend URL (for CORS)
CLIENT_URL=http://localhost:5173
```

**Gmail App Password setup:** Google Account → Security → 2-Step Verification → App Passwords → generate one for "Mail". Use that 16-character code as `EMAIL_PASS`, never your real Gmail password.

**Frontend `.env` (optional):**
```bash
# frontend/.env
VITE_API_URL=http://localhost:5000/api
```

If omitted, the Vite dev proxy handles it automatically.

---

## Database Schema

Five MongoDB collections. Every collection uses Mongoose's `timestamps: true` (automatic `createdAt` / `updatedAt`).

### Users

One collection for all roles. The `role` field drives middleware access control.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Auto-generated |
| `name` | String | Required |
| `email` | String | Unique index |
| `password` | String | bcrypt hash, `select: false` |
| `role` | Enum | `customer` \| `agent` \| `admin` |
| `phone` | String | Optional |
| `currentZone` | ObjectId → Zone | Agents only — used for auto-assignment |
| `isAvailable` | Boolean | Agents only — `true` when no active order |
| `lastAssignedAt` | Date | Agents only — for round-robin tie-breaking |

Compound index: `{ role, isAvailable, currentZone }` — used by the auto-assignment engine.

### Zones

Admin-created geographic regions. A zone is a named container; pincodes belong to it via the Areas collection.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `name` | String | Unique, e.g. "Zone A" |
| `description` | String | Optional admin note |

### Areas

Pincode → Zone mappings. Zone detection works by looking up a pincode here.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `pincode` | String | Unique index — always stored as string (leading zeros) |
| `city` | String | Human-readable city name |
| `zone` | ObjectId → Zone | Indexed for fast zone lookup |

**Zone detection query:** `Area.findOne({ pincode }).populate("zone")`

### RateCards

Admin-configured pricing. One document per `(fromZone, toZone, orderType)` combination. A compound unique index prevents duplicates.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `fromZone` | ObjectId → Zone | Pickup zone |
| `toZone` | ObjectId → Zone | Drop zone — same as `fromZone` for intra-zone |
| `orderType` | Enum | `B2B` \| `B2C` |
| `ratePerKg` | Number | Charge per kg of billable weight |
| `minimumCharge` | Number | Floor charge regardless of weight |
| `codSurcharge` | Number | Flat add-on for COD orders |

Compound unique index: `{ fromZone, toZone, orderType }`

### Orders

The central entity. Zones and charge are **snapshotted at creation** — subsequent admin changes to rate cards or zone mappings do not affect existing orders.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `orderNumber` | String | `ORD-XXXXXXXX`, unique, auto-generated |
| `customer` | ObjectId → User | Who the delivery is for |
| `agent` | ObjectId → User | Assigned agent, `null` until assigned |
| `createdBy` | ObjectId → User | Who pressed "create" (customer or admin) |
| `pickup` | Object | `{ address, pincode, city, zone }` |
| `drop` | Object | `{ address, pincode, city, zone }` |
| `dimensions` | Object | `{ l, b, h }` in cm |
| `actualWeight` | Number | kg, as declared |
| `volumetricWeight` | Number | `L×B×H / 5000`, snapshotted |
| `billableWeight` | Number | `max(actual, volumetric)`, snapshotted |
| `orderType` | Enum | `B2B` \| `B2C` |
| `paymentType` | Enum | `Prepaid` \| `COD` |
| `charge` | Number | Total charge, snapshotted |
| `chargeBreakdown` | Object | `{ baseCharge, codSurcharge }` |
| `status` | Enum | See lifecycle below |
| `scheduledDate` | Date | Set on reschedule |
| `failureReason` | String | Set when agent marks Failed |

**Order status lifecycle:**
```
Pending → Assigned → Picked Up → In Transit → Out for Delivery → Delivered
                                                              ↘ Failed → Rescheduled → Assigned
```

### TrackingLogs

Append-only event log. Never updated, never deleted. Each status change writes a new document.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `order` | ObjectId → Order | Indexed |
| `status` | String | Status at the time of this event |
| `actor` | ObjectId → User | Who triggered this change |
| `actorRole` | String | Snapshotted role — survives role changes |
| `note` | String | Free text, required for Failed status |
| `timestamp` | Date | Indexed for sorted timeline queries |

**Why separate collection and not an embedded array on Order?** MongoDB documents are capped at 16MB. An append-only collection also makes accidental updates structurally impossible — there is no `findByIdAndUpdate` path on a log.

---

## Rate Calculation Logic

The rate engine runs identically in two places: the **charge preview** endpoint (no DB write) and **order creation** (snapshots the result). This guarantees the quoted price and the charged price can never drift apart.

### Step 1 — Volumetric weight

```
volumetricWeight (kg) = (L × B × H) / 5000
```

`L`, `B`, `H` in centimetres. The divisor 5000 is the domestic courier industry standard (DHL, FedEx, and India Post all use this figure for domestic surface shipments).

### Step 2 — Billable weight

```
billableWeight = max(actualWeight, volumetricWeight)
```

Couriers bill on whichever is higher — this protects margin whether the package is dense (heavy/small) or bulky (light/large).

### Step 3 — Rate card lookup

```
RateCard.findOne({ fromZone, toZone, orderType })
```

- `fromZone` and `toZone` are resolved from the pickup and drop pincodes via the Areas collection.
- If `fromZone === toZone`, this naturally returns the intra-zone rate — no special-casing needed.
- `orderType` is `B2B` or `B2C` as supplied by the customer.

### Step 4 — Base charge

```
baseCharge = max(billableWeight × ratePerKg, minimumCharge)
```

The `minimumCharge` floor prevents commercially unviable charges on very light packages.

### Step 5 — COD surcharge

```
codSurcharge = paymentType === "COD" ? rateCard.codSurcharge : 0
```

### Step 6 — Total

```
totalCharge = baseCharge + codSurcharge
```

### Worked example

| Input | Value |
|---|---|
| Dimensions | 40 × 30 × 20 cm |
| Actual weight | 2 kg |
| Volumetric weight | (40 × 30 × 20) / 5000 = **4.8 kg** |
| Billable weight | max(2, 4.8) = **4.8 kg** |
| Route | Zone A → Zone B, B2C |
| Rate card | ₹15/kg, min ₹50, COD surcharge ₹20 |
| Base charge | max(4.8 × 15, 50) = max(72, 50) = **₹72** |
| Payment type | COD |
| COD surcharge | **₹20** |
| **Total** | **₹92** |

All intermediate values are rounded to 2 decimal places at each step to avoid floating-point accumulation errors.

---

## API Documentation

All endpoints are prefixed with `/api`. Protected endpoints require:

```
Authorization: Bearer <jwt_token>
```

Responses always follow:
```json
{ "success": true|false, "message": "...", ...data }
```

---

### Auth

#### `POST /auth/register`
Public. Creates a customer account.

**Body:**
```json
{
  "name": "Priya Sharma",
  "email": "priya@example.com",
  "password": "securepass",
  "phone": "+91 98765 43210"
}
```

**Response `201`:**
```json
{ "success": true, "token": "eyJ...", "user": { "_id": "...", "role": "customer" } }
```

---

#### `POST /auth/login`
Public. All roles use this endpoint.

**Body:** `{ "email": "...", "password": "..." }`

**Response `200`:** Same shape as register.

---

#### `GET /auth/me`
Protected (any role). Returns the current user from the JWT.

---

#### `POST /auth/staff`
Protected (admin). Creates an agent or admin account.

**Body:**
```json
{
  "name": "Rahul Kumar",
  "email": "rahul@lastmile.in",
  "password": "agentpass",
  "role": "agent",
  "currentZone": "<zoneObjectId>",
  "phone": "+91 99999 00000"
}
```

---

### Zones (admin only unless noted)

#### `POST /zones`
Create a zone. Body: `{ "name": "Zone A", "description": "South Bangalore" }`

#### `GET /zones`
List all zones. Also accessible to agents (for assignment dropdowns).

#### `PATCH /zones/:id`
Update zone name or description.

#### `DELETE /zones/:id`
Delete a zone. Fails with `400` if any areas or rate cards still reference it.

#### `POST /zones/areas`
Map a pincode to a zone.

**Body:** `{ "pincode": "560001", "city": "Bangalore", "zoneId": "<objectId>" }`

#### `GET /zones/areas?zone=<id>`
List all areas. Optional `zone` filter.

#### `PATCH /zones/areas/:id`
Remap a pincode to a different zone.

#### `DELETE /zones/areas/:id`
Remove a pincode mapping.

#### `GET /zones/detect?pincode=560001`
Protected (any role). Returns the zone for a given pincode. Used by the frontend to show zone info as the customer types.

---

### Rate Cards (admin only)

#### `POST /rate-cards`
Create a rate card.

**Body:**
```json
{
  "fromZone": "<objectId>",
  "toZone": "<objectId>",
  "orderType": "B2C",
  "ratePerKg": 15,
  "minimumCharge": 50,
  "codSurcharge": 20
}
```

Returns `400` if a card for this `(fromZone, toZone, orderType)` already exists.

#### `GET /rate-cards?orderType=B2C&fromZone=<id>`
List rate cards with optional filters.

#### `PATCH /rate-cards/:id`
Update pricing. Does not affect existing orders (charge is snapshotted at order creation).

#### `DELETE /rate-cards/:id`
Delete a rate card.

#### `POST /rate-cards/preview`
Protected (customer, admin). Calculates charge without creating an order.

**Body:**
```json
{
  "pickupPincode": "560001",
  "dropPincode": "110001",
  "l": 40, "b": 30, "h": 20,
  "actualWeight": 2,
  "orderType": "B2C",
  "paymentType": "COD"
}
```

**Response `200`:**
```json
{
  "pickupZone": { "name": "Zone A" },
  "dropZone": { "name": "Zone B" },
  "volumetricWeight": 4.8,
  "billableWeight": 4.8,
  "chargeBreakdown": { "baseCharge": 72, "codSurcharge": 20 },
  "totalCharge": 92
}
```

---

### Orders

#### `POST /orders`
Protected (customer, admin). Creates an order — the "confirm" step after preview.

**Body:**
```json
{
  "pickupAddress": "123 MG Road",
  "pickupPincode": "560001",
  "pickupCity": "Bangalore",
  "dropAddress": "45 Connaught Place",
  "dropPincode": "110001",
  "dropCity": "New Delhi",
  "l": 40, "b": 30, "h": 20,
  "actualWeight": 2,
  "orderType": "B2C",
  "paymentType": "COD",
  "customerId": "<objectId>"
}
```

`customerId` is only used when `role === "admin"` (creating on behalf of a customer). Customers cannot set their own `customerId`. The backend recomputes charge from inputs — any `charge` field in the body is ignored.

#### `GET /orders/my`
Protected (customer). Returns all orders for the logged-in customer.

#### `GET /orders/agent/my`
Protected (agent). Returns active and recently completed orders for the logged-in agent.

#### `GET /orders/admin/all`
Protected (admin). Paginated order list with filters.

Query params:
- `status` — must match a valid status string exactly
- `zone` — must be a valid ObjectId
- `agent` — must be a valid ObjectId
- `page` (default 1), `limit` (default 20, max 50)

**Response:**
```json
{
  "orders": [...],
  "totalCount": 142,
  "page": 1,
  "totalPages": 8
}
```

#### `GET /orders/:id`
Protected (any role). Ownership-checked — customers only see their own, agents only see their assigned orders, admin sees any.

#### `GET /orders/:id/timeline`
Protected (any role, ownership-checked). Returns the full chronological tracking history.

**Response:**
```json
{
  "orderNumber": "ORD-A1B2C3D4",
  "currentStatus": "In Transit",
  "timeline": [
    { "status": "Pending", "actor": { "name": "Priya" }, "timestamp": "...", "note": "Order created." },
    { "status": "Assigned", "timestamp": "...", "note": "Auto-assigned to agent Rahul." },
    ...
  ]
}
```

---

### Order actions

#### `PATCH /orders/:id/auto-assign`
Protected (admin). Finds the longest-idle available agent in the pickup zone and assigns them.

Returns `409` if no agent is available in that zone.

#### `PATCH /orders/:id/assign`
Protected (admin). Manual agent assignment.

**Body:** `{ "agentId": "<objectId>" }`

#### `PATCH /orders/:id/status`
Protected (agent, customer). Moves an order to the next status, validated against the state machine.

**Body:** `{ "status": "In Transit", "note": "optional" }`

Valid transitions:

| From | To | Who |
|---|---|---|
| Assigned | Picked Up | agent |
| Picked Up | In Transit | agent |
| In Transit | Out for Delivery | agent |
| Out for Delivery | Delivered | agent |
| Out for Delivery | Failed | agent (note required) |
| Failed | Rescheduled | customer |

Returns `400` for invalid transitions with a descriptive message.

#### `PATCH /orders/:id/override-status`
Protected (admin). Bypasses the state machine — can set any status from any current status.

**Body:** `{ "status": "Delivered", "note": "Admin override reason" }`

Logged in TrackingLog with `[ADMIN OVERRIDE]` prefix in the note.

#### `PATCH /orders/:id/reschedule`
Protected (customer). Reschedules a failed delivery. Order must currently be `Failed`.

**Body:** `{ "scheduledDate": "2026-07-15" }` — must be today or a future date.

Automatically triggers auto-assignment after rescheduling. If no agent is available, the order stays at `Rescheduled` and admin assigns manually — the reschedule itself is not rolled back.

---

## Project Structure

```
lastmile-delivery/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   └── db.js                  # MongoDB connection
│   │   ├── models/
│   │   │   ├── User.js                # All roles in one collection
│   │   │   ├── Zone.js                # Zone + Area models
│   │   │   ├── RateCard.js            # Pricing config
│   │   │   ├── Order.js               # Central entity
│   │   │   └── TrackingLog.js         # Append-only history
│   │   ├── middleware/
│   │   │   └── auth.js                # protect + authorise()
│   │   ├── controllers/
│   │   │   ├── authController.js
│   │   │   ├── zoneController.js
│   │   │   ├── rateCardController.js
│   │   │   ├── orderController.js
│   │   │   ├── assignmentController.js
│   │   │   ├── statusController.js
│   │   │   ├── rescheduleController.js
│   │   │   └── adminOrderController.js
│   │   ├── routes/
│   │   │   ├── authRoutes.js
│   │   │   ├── zoneRoutes.js
│   │   │   ├── rateCardRoutes.js
│   │   │   └── orderRoutes.js
│   │   ├── utils/
│   │   │   ├── zoneDetection.js       # detectZone(), detectBothZones()
│   │   │   ├── rateEngine.js          # calculateCharge() — pure function
│   │   │   ├── assignmentEngine.js    # autoAssignAgent(), releaseAgent()
│   │   │   ├── statusTransitions.js   # State machine as data
│   │   │   ├── emailService.js        # Nodemailer, fire-and-forget
│   │   │   ├── seed.js                # Dev data seeding
│   │   │   └── smokeTest.js           # 12-step E2E test script
│   │   └── server.js
│   ├── .env.example
│   ├── .gitignore
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── context/
    │   │   └── AuthContext.jsx         # JWT storage + session restore
    │   ├── hooks/
    │   │   └── useAgentOrders.js       # Optimistic updates for agents
    │   ├── utils/
    │   │   └── api.js                  # All API calls, one file
    │   ├── pages/
    │   │   ├── AuthPage.jsx
    │   │   ├── MyOrdersPage.jsx
    │   │   ├── PlaceOrderPage.jsx
    │   │   ├── OrderDetailPage.jsx     # Tracking timeline
    │   │   ├── admin/
    │   │   │   ├── AdminShell.jsx      # Sidebar layout
    │   │   │   ├── AdminDashboard.jsx
    │   │   │   ├── AdminOrders.jsx     # Filter + assign + override
    │   │   │   ├── AdminZones.jsx
    │   │   │   ├── AdminRateCards.jsx
    │   │   │   └── AdminAgents.jsx
    │   │   └── agent/
    │   │       ├── AgentShell.jsx      # Active + history tabs
    │   │       └── AssignmentCard.jsx  # Per-order action card
    │   ├── components/
    │   │   └── Topbar.jsx
    │   ├── App.jsx                     # Role-based routing
    │   ├── main.jsx
    │   └── index.css                   # Design system tokens
    ├── index.html
    └── vite.config.js
```
