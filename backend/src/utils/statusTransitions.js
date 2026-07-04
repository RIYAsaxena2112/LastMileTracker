/**
 * Order Status Transitions
 *
 * Defines the state machine graph as plain data: for each status, which
 * statuses can it move to, and which role is allowed to trigger that move.
 *
 * Keeping this as DATA (not scattered if/else logic in the controller)
 * means the entire business rule is visible in one place — easy to read,
 * easy to change, easy to explain in an interview by just pointing at it.
 *
 * Admin is handled separately — they can override to ANY status, bypassing
 * this graph entirely (see statusController.js overrideStatus).
 */

const STATUS_TRANSITIONS = {
  Pending: {
    next: ["Assigned"],
    allowedRoles: ["admin", "system"], // "system" = auto-assignment engine
  },
  Assigned: {
    next: ["Picked Up"],
    allowedRoles: ["agent"],
  },
  "Picked Up": {
    next: ["In Transit"],
    allowedRoles: ["agent"],
  },
  "In Transit": {
    next: ["Out for Delivery"],
    allowedRoles: ["agent"],
  },
  "Out for Delivery": {
    next: ["Delivered", "Failed"], // branch point — success or failure
    allowedRoles: ["agent"],
  },
  Delivered: {
    next: [], // terminal state — no further transitions
    allowedRoles: [],
  },
  Failed: {
    next: ["Rescheduled"],
    allowedRoles: ["customer"], // customer decides to reschedule
  },
  Rescheduled: {
    next: ["Assigned"], // goes back into the assignment flow
    allowedRoles: ["admin", "system"],
  },
};

/**
 * isValidTransition
 *
 * Checks whether moving from `fromStatus` to `toStatus` is allowed,
 * AND whether `role` is permitted to trigger that specific move.
 *
 * @param {string} fromStatus - current status
 * @param {string} toStatus   - desired next status
 * @param {string} role       - role attempting the transition
 * @returns {boolean}
 */
const isValidTransition = (fromStatus, toStatus, role) => {
  const rule = STATUS_TRANSITIONS[fromStatus];

  if (!rule) return false; // unknown status — reject defensively

  const toStatusAllowed = rule.next.includes(toStatus);
  const roleAllowed = rule.allowedRoles.includes(role);

  return toStatusAllowed && roleAllowed;
};

module.exports = { STATUS_TRANSITIONS, isValidTransition };