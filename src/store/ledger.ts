/**
 * The idempotency ledger — the application's own memory of what it attempted.
 *
 * PayPal-Request-Id makes the *remote* side safe: send the same id twice and
 * PayPal returns the first result instead of charging twice. That is half the
 * problem. The other half is local: after a crash, your process needs to know
 * that it already started a capture, and with which id, or it will invent a
 * fresh id and cheerfully create a second charge.
 *
 * So the rule this repo follows is: write the intent BEFORE the call, record
 * the outcome AFTER it, and never generate a request id twice for the same
 * business action. The id is derived from the business action (order id +
 * operation), not from randomness — see requestIdFor() in paypal/client.ts.
 */

import { JsonStore } from "./json-store.js";

export type AttemptState = "STARTED" | "SUCCEEDED" | "FAILED";

export interface LedgerEntry {
  /** The PayPal-Request-Id we sent. Stable across every retry of this action. */
  requestId: string;
  /** e.g. "capture", "create-order", "refund". */
  operation: string;
  /** Business key this action belongs to — usually the order id. */
  subject: string;
  state: AttemptState;
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  /** The result of the FIRST successful attempt. Replays return this. */
  result?: unknown;
  /** Terminal failure detail, if it failed for good. */
  failure?: { status?: number; name?: string; issues?: string[]; debugId?: string };
}

const store = new JsonStore<LedgerEntry>("ledger");

/** Deterministic key: same business action ⇒ same key ⇒ same request id. */
export function ledgerKey(operation: string, subject: string): string {
  return `${operation}:${subject}`;
}

/**
 * Claim an action before performing it.
 *
 * Returns `{ fresh: true }` if this process is the first to attempt it, or
 * `{ fresh: false, entry }` if we have attempted it before — in which case the
 * caller must reuse `entry.requestId` rather than minting a new one.
 */
export function beginAttempt(
  operation: string,
  subject: string,
  requestId: string,
): { fresh: boolean; entry: LedgerEntry } {
  const key = ledgerKey(operation, subject);
  const existing = store.get(key);
  const now = new Date().toISOString();

  if (existing) {
    const updated: LedgerEntry = { ...existing, attempts: existing.attempts + 1, lastAttemptAt: now };
    store.set(key, updated);
    return { fresh: false, entry: updated };
  }

  const entry: LedgerEntry = {
    requestId,
    operation,
    subject,
    state: "STARTED",
    attempts: 1,
    firstAttemptAt: now,
    lastAttemptAt: now,
  };
  store.set(key, entry);
  return { fresh: true, entry };
}

function baseEntry(operation: string, subject: string): LedgerEntry {
  const now = new Date().toISOString();
  return {
    requestId: "(unknown)",
    operation,
    subject,
    state: "STARTED",
    attempts: 1,
    firstAttemptAt: now,
    lastAttemptAt: now,
  };
}

export function recordSuccess(operation: string, subject: string, result: unknown): LedgerEntry {
  const key = ledgerKey(operation, subject);
  const entry = store.get(key) ?? baseEntry(operation, subject);

  entry.state = "SUCCEEDED";
  entry.lastAttemptAt = new Date().toISOString();
  // Keep the FIRST recorded result. A replay must not overwrite history —
  // that history is the evidence that the second call changed nothing.
  if (entry.result === undefined) entry.result = result;

  store.set(key, entry);
  return entry;
}

export function recordFailure(
  operation: string,
  subject: string,
  failure: LedgerEntry["failure"],
): void {
  const key = ledgerKey(operation, subject);
  const entry = store.get(key) ?? baseEntry(operation, subject);

  entry.state = "FAILED";
  entry.lastAttemptAt = new Date().toISOString();
  entry.failure = failure;

  store.set(key, entry);
}

export function getAttempt(operation: string, subject: string): LedgerEntry | undefined {
  return store.get(ledgerKey(operation, subject));
}

export function allAttempts(): LedgerEntry[] {
  return store.values();
}

export function clearLedger(): void {
  store.clear();
}
