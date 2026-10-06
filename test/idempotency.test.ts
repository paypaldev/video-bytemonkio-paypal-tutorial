/**
 * Idempotency: the property that a retry is not a second charge.
 *
 * These tests cover the half of idempotency that lives in THIS repo. The other
 * half — PayPal returning the original result for a repeated
 * PayPal-Request-Id — is demonstrated live in scenarios/02-idempotent-capture.ts,
 * because asserting it against a mock would only prove the mock works.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { requestIdFor } from "../src/paypal/client.js";
import { beginAttempt, recordSuccess, getAttempt, clearLedger } from "../src/store/ledger.js";

beforeEach(() => clearLedger());

describe("request ids", () => {
  test("are derived from the business action, so a retry cannot invent a new one", () => {
    const a = requestIdFor("capture", "5O190127TN364715T");
    const b = requestIdFor("capture", "5O190127TN364715T");

    assert.equal(a, b, "the same capture must always produce the same request id");
  });

  test("differ across operations on the same order", () => {
    const capture = requestIdFor("capture", "ORDER-1");
    const refund = requestIdFor("refund", "ORDER-1");

    assert.notEqual(capture, refund, "a refund must not reuse the capture's id");
  });

  test("differ across orders", () => {
    assert.notEqual(requestIdFor("capture", "ORDER-1"), requestIdFor("capture", "ORDER-2"));
  });
});

describe("the ledger", () => {
  test("a second attempt reuses the first attempt's request id", () => {
    const orderId = "ORDER-A";

    const first = beginAttempt("capture", orderId, requestIdFor("capture", orderId));
    assert.equal(first.fresh, true);
    assert.equal(first.entry.attempts, 1);

    // A crash, a restart, and a retry that has no memory of the first attempt.
    const second = beginAttempt("capture", orderId, "a-brand-new-random-id");

    assert.equal(second.fresh, false, "the ledger must recognise a repeat attempt");
    assert.equal(
      second.entry.requestId,
      first.entry.requestId,
      "the retry must send the ORIGINAL request id, not the new one it generated",
    );
    assert.equal(second.entry.attempts, 2);
  });

  test("records the result of the first success and never overwrites it", () => {
    const orderId = "ORDER-B";
    beginAttempt("capture", orderId, requestIdFor("capture", orderId));

    recordSuccess("capture", orderId, { captureId: "CAP-FIRST" });
    // The replay comes back with the same capture from PayPal; even if it did
    // not, our history of what happened first must not be rewritten.
    recordSuccess("capture", orderId, { captureId: "CAP-SECOND" });

    const entry = getAttempt("capture", orderId);
    assert.equal(entry?.state, "SUCCEEDED");
    assert.deepEqual(entry?.result, { captureId: "CAP-FIRST" });
  });

  test("attempts are counted, so a retry storm is visible rather than silent", () => {
    const orderId = "ORDER-C";
    const id = requestIdFor("capture", orderId);
    for (let i = 0; i < 5; i++) beginAttempt("capture", orderId, id);

    assert.equal(getAttempt("capture", orderId)?.attempts, 5);
  });

  test("separate orders keep separate ledger entries", () => {
    beginAttempt("capture", "ORDER-D", requestIdFor("capture", "ORDER-D"));
    beginAttempt("capture", "ORDER-E", requestIdFor("capture", "ORDER-E"));

    assert.equal(getAttempt("capture", "ORDER-D")?.attempts, 1);
    assert.equal(getAttempt("capture", "ORDER-E")?.attempts, 1);
  });
});
