/**
 * The application's own view of an order.
 *
 * PayPal knows whether the money moved. This module knows whether we have
 * acted on it — sent the confirmation email, granted the download, shipped the
 * box. Keeping those two facts separate is the whole reason the rest of this
 * repo works.
 *
 * Two properties are enforced here, and they are the ones the video tests:
 *
 *   exactly-once fulfilment   fulfil() is keyed on the capture id. Call it a
 *                             hundred times and the order is fulfilled once.
 *                             Duplicate webhooks, replays from the dashboard
 *                             and a buyer refreshing the return page all end
 *                             up in this function.
 *
 *   order independence        the buyer's redirect and PayPal's webhook are two
 *                             racing messengers. Either may arrive first. The
 *                             state machine accepts the same facts in either
 *                             order and converges on the same result, so there
 *                             is no "correct" order to depend on.
 */

import { JsonStore } from "../store/json-store.js";

export type AppOrderStatus =
  /** We created the order at PayPal. Nobody has paid. */
  | "AWAITING_APPROVAL"
  /** The buyer approved at PayPal but we have not captured yet. */
  | "APPROVED"
  /** Money moved. We know the capture id. */
  | "PAID"
  /** We have delivered whatever the buyer bought. Terminal, happy. */
  | "FULFILLED"
  /** The payment failed for good. */
  | "FAILED"
  /** Money went back. */
  | "REFUNDED";

export type FactSource = "api" | "webhook" | "redirect";

export interface OrderFactLog {
  at: string;
  source: FactSource;
  fact: string;
}

export interface AppOrder {
  orderId: string;
  status: AppOrderStatus;
  amount?: string;
  currency?: string;
  captureId?: string;
  /** Which messenger told us the money moved, first. */
  paidLearnedFrom?: FactSource;
  paidAt?: string;
  fulfilledAt?: string;
  /**
   * How many times fulfilment was ATTEMPTED versus performed. On camera this
   * is the number that proves duplicates were handled: attempts climbs, and
   * `fulfilledAt` never changes.
   */
  fulfilmentAttempts: number;
  history: OrderFactLog[];
  createdAt: string;
  updatedAt: string;
}

const store = new JsonStore<AppOrder>("orders");

function now(): string {
  return new Date().toISOString();
}

function log(order: AppOrder, source: FactSource, fact: string): void {
  order.history.push({ at: now(), source, fact });
  order.updatedAt = now();
}

export function createLocalOrder(
  orderId: string,
  amount?: string,
  currency?: string,
): AppOrder {
  const existing = store.get(orderId);
  if (existing) return existing;

  const order: AppOrder = {
    orderId,
    status: "AWAITING_APPROVAL",
    ...(amount ? { amount } : {}),
    ...(currency ? { currency } : {}),
    fulfilmentAttempts: 0,
    history: [],
    createdAt: now(),
    updatedAt: now(),
  };
  log(order, "api", "order created at PayPal; no money has moved");
  store.set(orderId, order);
  return order;
}

export function getLocalOrder(orderId: string): AppOrder | undefined {
  return store.get(orderId);
}

export function allLocalOrders(): AppOrder[] {
  return store.values();
}

export interface ApplyResult {
  order: AppOrder;
  /** False when the fact was already known — i.e. this was a duplicate. */
  changed: boolean;
  /** Human-readable explanation for the console. */
  explanation: string;
}

export function markApproved(orderId: string, source: FactSource): ApplyResult {
  const order = store.get(orderId) ?? createLocalOrder(orderId);

  // Never walk backwards. A late-arriving "approved" must not undo "paid".
  if (order.status !== "AWAITING_APPROVAL") {
    return {
      order,
      changed: false,
      explanation: `already past approval (status=${order.status}); ignoring`,
    };
  }

  order.status = "APPROVED";
  log(order, source, "buyer approved the payment");
  store.set(orderId, order);
  return { order, changed: true, explanation: "approved" };
}

/**
 * Record that money moved.
 *
 * Idempotent on captureId. The second caller — whether that is the redirect
 * arriving after the webhook, or the same webhook delivered twice — learns
 * that the fact was already known and changes nothing.
 */
export function markPaid(
  orderId: string,
  captureId: string,
  source: FactSource,
  amount?: string,
  currency?: string,
): ApplyResult {
  const order = store.get(orderId) ?? createLocalOrder(orderId, amount, currency);

  if (order.captureId === captureId) {
    return {
      order,
      changed: false,
      explanation: `capture ${captureId} was already recorded (first heard from the ${order.paidLearnedFrom}); nothing to do`,
    };
  }

  if (order.captureId && order.captureId !== captureId) {
    // Two different captures on one order is a real condition (partial
    // captures), but for this demo it is worth shouting about rather than
    // silently overwriting the first one.
    log(order, source, `WARNING second distinct capture ${captureId} seen; keeping ${order.captureId}`);
    store.set(orderId, order);
    return {
      order,
      changed: false,
      explanation: `a different capture id is already recorded — not overwriting`,
    };
  }

  order.captureId = captureId;
  order.status = "PAID";
  order.paidLearnedFrom = source;
  order.paidAt = now();
  if (amount) order.amount = amount;
  if (currency) order.currency = currency;
  log(order, source, `payment captured (${captureId})`);
  store.set(orderId, order);

  return { order, changed: true, explanation: `recorded capture ${captureId} — learned from the ${source}` };
}

/**
 * Do the thing the buyer paid for. Exactly once, forever.
 *
 * In a real system the guard is a UNIQUE constraint or a conditional update,
 * not a field read — but the shape is identical: check-and-set on a key
 * derived from the payment, inside one transaction.
 */
export function fulfil(orderId: string, source: FactSource): ApplyResult {
  // Never throw on an unknown order. A webhook for an order this process has
  // no memory of — a refund issued from the dashboard, anything after a
  // `npm run reset` — is a normal event, and throwing here would turn it into
  // a 500, which tells PayPal to redeliver the same unhandleable event for
  // three days.
  const order = store.get(orderId) ?? createLocalOrder(orderId);

  order.fulfilmentAttempts += 1;

  if (order.status === "FULFILLED") {
    log(order, source, `fulfilment attempt #${order.fulfilmentAttempts} suppressed — already fulfilled`);
    store.set(orderId, order);
    return {
      order,
      changed: false,
      explanation: `attempt #${order.fulfilmentAttempts} suppressed; order was fulfilled at ${order.fulfilledAt}`,
    };
  }

  if (order.status !== "PAID") {
    log(order, source, `fulfilment refused — status is ${order.status}, not PAID`);
    store.set(orderId, order);
    return {
      order,
      changed: false,
      explanation: `refused: status is ${order.status}; we only ship what has been paid for`,
    };
  }

  order.status = "FULFILLED";
  order.fulfilledAt = now();
  log(order, source, `fulfilled on attempt #${order.fulfilmentAttempts}`);
  store.set(orderId, order);

  return { order, changed: true, explanation: `fulfilled (attempt #${order.fulfilmentAttempts})` };
}

export function markRefunded(orderId: string, source: FactSource): ApplyResult {
  const order = store.get(orderId) ?? createLocalOrder(orderId);
  if (order.status === "REFUNDED") {
    return { order, changed: false, explanation: "already refunded" };
  }
  order.status = "REFUNDED";
  log(order, source, "payment refunded");
  store.set(orderId, order);
  return { order, changed: true, explanation: "refunded" };
}

export function markFailed(orderId: string, source: FactSource, why: string): ApplyResult {
  const order = store.get(orderId) ?? createLocalOrder(orderId);
  if (order.status === "PAID" || order.status === "FULFILLED") {
    // A failure notice cannot un-pay a payment we have evidence for.
    return { order, changed: false, explanation: "ignoring failure notice for an order we know was paid" };
  }
  order.status = "FAILED";
  log(order, source, `failed: ${why}`);
  store.set(orderId, order);
  return { order, changed: true, explanation: `failed: ${why}` };
}

export function clearOrders(): void {
  store.clear();
}
