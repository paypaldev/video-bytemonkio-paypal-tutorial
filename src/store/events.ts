/**
 * The webhook event log — the deduplication boundary.
 *
 * PayPal retries a delivery up to 25 times over 3 days if your listener does
 * not answer 2xx, and you can also replay any event by hand from the
 * dashboard. So "the same event arrives more than once" is not an edge case to
 * defend against; it is the documented, expected behaviour of the system.
 *
 * The defence is one line of logic: the event id is a primary key. First
 * insert wins, everything after it is a replay.
 *
 * Two details make that safe rather than merely tidy:
 *
 *   claims start PENDING   a row is written before the business logic runs, so
 *                          the id is reserved — but a row still PENDING means
 *                          the previous attempt never finished. A redelivery
 *                          of one of those is reprocessable, not a replay.
 *                          Otherwise a crash mid-handler would make PayPal's
 *                          redelivery — the thing that saves you — get dropped
 *                          as a duplicate, and the order would never ship.
 *
 *   rejections live apart  the id on an unverified body is attacker-supplied.
 *                          It must never be able to create, overwrite, or
 *                          pre-claim a row in this table.
 */

import { JsonStore } from "./json-store.js";

export type EventOutcome = "PENDING" | "PROCESSED" | "IGNORED" | "REPLAY" | "ERROR";

export interface RecordedEvent {
  eventId: string;
  eventType: string;
  /** When PayPal says it happened. */
  createTime?: string;
  /** When we first saw it. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many times it has been delivered to us. */
  deliveries: number;
  outcome: EventOutcome;
  /** What we did, in words, the first time. */
  action?: string;
  /** Related business object, when there is one. */
  orderId?: string;
  subscriptionId?: string;
  verification?: { method: string; verified: boolean; durationMs: number; reason?: string };
}

export interface RejectedDelivery {
  at: string;
  /** Untrusted: taken from a body whose signature did not verify. */
  claimedEventId: string;
  claimedEventType: string;
  reason?: string;
  method: string;
}

const store = new JsonStore<RecordedEvent>("events");
const rejections = new JsonStore<RejectedDelivery>("rejections");

/**
 * Claim an event for processing.
 *
 * Returns `first: true` when this delivery is the one that should do the work:
 * either nobody has claimed the id, or a previous claim never completed.
 */
export function claimEvent(
  eventId: string,
  eventType: string,
  createTime?: string,
): { first: boolean; record: RecordedEvent } {
  const now = new Date().toISOString();
  const existing = store.get(eventId);

  if (existing) {
    existing.deliveries += 1;
    existing.lastSeenAt = now;

    // A row left PENDING or ERROR means the last attempt died before it
    // finished. PayPal redelivering is precisely the recovery mechanism, so
    // let this delivery try again rather than discarding it as a duplicate.
    const unfinished = existing.outcome === "PENDING" || existing.outcome === "ERROR";
    if (unfinished) existing.outcome = "PENDING";

    store.set(eventId, existing);
    return { first: unfinished, record: existing };
  }

  const record: RecordedEvent = {
    eventId,
    eventType,
    ...(createTime ? { createTime } : {}),
    firstSeenAt: now,
    lastSeenAt: now,
    deliveries: 1,
    outcome: "PENDING",
  };
  store.set(eventId, record);
  return { first: true, record };
}

export function finishEvent(eventId: string, patch: Partial<RecordedEvent>): void {
  const existing = store.get(eventId);
  if (!existing) return;
  store.set(eventId, { ...existing, ...patch });
}

/**
 * Log a delivery we refused before it ever became an event.
 *
 * Kept in a separate table keyed on time, not on the claimed event id. If this
 * wrote into the events table, anyone who could reach the endpoint could
 * overwrite the record of a genuine event — or pre-claim an id so the real
 * delivery arrived later and was dropped as a replay.
 */
export function recordRejection(
  claimedEventId: string,
  claimedEventType: string,
  verification: { method: string; reason?: string },
): void {
  const at = new Date().toISOString();
  rejections.set(`${at}-${rejections.entries().length}`, {
    at,
    claimedEventId,
    claimedEventType,
    method: verification.method,
    ...(verification.reason ? { reason: verification.reason } : {}),
  });
}

export function getEvent(eventId: string): RecordedEvent | undefined {
  return store.get(eventId);
}

export function allEvents(): RecordedEvent[] {
  return store.values().sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

export function allRejections(): RejectedDelivery[] {
  return rejections.values().sort((a, b) => a.at.localeCompare(b.at));
}

export function clearEvents(): void {
  store.clear();
  rejections.clear();
}
