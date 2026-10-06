/**
 * Webhook handling: process once, in any order, and only after verification.
 *
 * The three properties under test are the three the video claims:
 *   duplicates are collapsed, ordering does not matter, and an unverified
 *   event never reaches the business logic.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { handleEvent } from "../src/domain/handle-event.js";
import { captureCompleted, orderApproved } from "../src/fixtures/events.js";
import {
  clearEvents,
  getEvent,
  claimEvent,
  finishEvent,
  recordRejection,
  allRejections,
} from "../src/store/events.js";
import {
  clearOrders,
  createLocalOrder,
  getLocalOrder,
  markPaid,
  markRefunded,
  fulfil,
} from "../src/domain/order-state.js";
import {
  buildSignedMessage,
  isTrustedCertUrl,
  verifySelf,
  verifyAndParse,
} from "../src/paypal/webhooks.js";

beforeEach(() => {
  clearEvents();
  clearOrders();
});

describe("duplicate delivery", () => {
  test("the same event delivered three times is processed once", () => {
    const orderId = "ORDER-DUP";
    createLocalOrder(orderId, "24.00", "USD");
    const event = captureCompleted({ orderId, captureId: "CAP-1", eventId: "WH-DUP-1" });

    const first = handleEvent(event);
    const second = handleEvent(event);
    const third = handleEvent(event);

    assert.equal(first.outcome, "PROCESSED");
    assert.equal(second.outcome, "REPLAY");
    assert.equal(third.outcome, "REPLAY");

    const order = getLocalOrder(orderId);
    assert.equal(order?.status, "FULFILLED");
    assert.equal(order?.fulfilmentAttempts, 1, "the replays must not even reach fulfilment");
    assert.equal(getEvent("WH-DUP-1")?.deliveries, 3, "but every delivery must still be counted");
  });

  test("a replay explains what happened the first time", () => {
    const orderId = "ORDER-EXPLAIN";
    createLocalOrder(orderId);
    const event = captureCompleted({ orderId, captureId: "CAP-2", eventId: "WH-EXPLAIN" });

    handleEvent(event);
    const replay = handleEvent(event);

    assert.match(replay.action, /replay #2/);
    assert.match(replay.action, /first handled at/);
  });

  test("distinct events are not confused with each other", () => {
    createLocalOrder("ORDER-X");
    createLocalOrder("ORDER-Y");

    const a = handleEvent(captureCompleted({ orderId: "ORDER-X", captureId: "CAP-X", eventId: "WH-X" }));
    const b = handleEvent(captureCompleted({ orderId: "ORDER-Y", captureId: "CAP-Y", eventId: "WH-Y" }));

    assert.equal(a.outcome, "PROCESSED");
    assert.equal(b.outcome, "PROCESSED");
    assert.equal(getLocalOrder("ORDER-X")?.captureId, "CAP-X");
    assert.equal(getLocalOrder("ORDER-Y")?.captureId, "CAP-Y");
  });
});

describe("arrival order", () => {
  test("webhook first, then the buyer's redirect", () => {
    const orderId = "ORDER-WEBHOOK-FIRST";
    createLocalOrder(orderId);

    handleEvent(captureCompleted({ orderId, captureId: "CAP-W", eventId: "WH-W" }));
    // The browser finally comes back and captures idempotently, getting the
    // same capture id from PayPal.
    const paid = markPaid(orderId, "CAP-W", "redirect");
    const shipped = fulfil(orderId, "redirect");

    const order = getLocalOrder(orderId);
    assert.equal(paid.changed, false, "the redirect learned nothing new");
    assert.equal(shipped.changed, false, "and must not fulfil a second time");
    assert.equal(order?.paidLearnedFrom, "webhook");
    assert.equal(order?.status, "FULFILLED");
    assert.equal(order?.fulfilmentAttempts, 2, "both messengers tried");
  });

  test("redirect first, then the webhook — same end state", () => {
    const orderId = "ORDER-REDIRECT-FIRST";
    createLocalOrder(orderId);

    markPaid(orderId, "CAP-R", "redirect");
    fulfil(orderId, "redirect");
    handleEvent(captureCompleted({ orderId, captureId: "CAP-R", eventId: "WH-R" }));

    const order = getLocalOrder(orderId);
    assert.equal(order?.paidLearnedFrom, "redirect");
    assert.equal(order?.status, "FULFILLED");
    assert.equal(order?.fulfilmentAttempts, 2);
  });

  test("the two orderings converge on the same state", () => {
    createLocalOrder("A");
    handleEvent(captureCompleted({ orderId: "A", captureId: "CAP-A", eventId: "WH-A" }));
    markPaid("A", "CAP-A", "redirect");
    fulfil("A", "redirect");

    createLocalOrder("B");
    markPaid("B", "CAP-B", "redirect");
    fulfil("B", "redirect");
    handleEvent(captureCompleted({ orderId: "B", captureId: "CAP-B", eventId: "WH-B" }));

    const a = getLocalOrder("A")!;
    const b = getLocalOrder("B")!;

    assert.equal(a.status, b.status);
    assert.equal(a.fulfilmentAttempts, b.fulfilmentAttempts);
    assert.equal(Boolean(a.fulfilledAt), true);
    assert.equal(Boolean(b.fulfilledAt), true);
  });

  test("a stale approval arriving after payment cannot walk the state backwards", () => {
    const orderId = "ORDER-STALE";
    createLocalOrder(orderId);
    handleEvent(captureCompleted({ orderId, captureId: "CAP-S", eventId: "WH-S1" }));

    const stale = handleEvent(orderApproved({ orderId, eventId: "WH-S2" }));

    assert.equal(stale.outcome, "IGNORED");
    assert.equal(getLocalOrder(orderId)?.status, "FULFILLED");
  });

  test("fulfilment is refused for an order that has not been paid", () => {
    const orderId = "ORDER-UNPAID";
    createLocalOrder(orderId);

    const result = fulfil(orderId, "redirect");

    assert.equal(result.changed, false);
    assert.match(result.explanation, /AWAITING_APPROVAL/);
  });
});

describe("recovery from a crash mid-handler", () => {
  test("a claim that never finished is reprocessable, not a replay", () => {
    // Simulates: the row is claimed, then the process dies before the handler
    // finishes. PayPal redelivers — and that redelivery is the recovery, so it
    // must be allowed to do the work rather than being dropped as a duplicate.
    const first = claimEvent("WH-CRASH", "PAYMENT.CAPTURE.COMPLETED");
    assert.equal(first.first, true);
    assert.equal(first.record.outcome, "PENDING");

    const redelivery = claimEvent("WH-CRASH", "PAYMENT.CAPTURE.COMPLETED");

    assert.equal(redelivery.first, true, "an unfinished claim must not swallow the retry");
    assert.equal(redelivery.record.deliveries, 2);
  });

  test("once a claim has finished, further deliveries are replays", () => {
    claimEvent("WH-DONE", "PAYMENT.CAPTURE.COMPLETED");
    finishEvent("WH-DONE", { outcome: "PROCESSED", action: "fulfilled" });

    const again = claimEvent("WH-DONE", "PAYMENT.CAPTURE.COMPLETED");

    assert.equal(again.first, false);
  });

  test("an event whose handler errored is retried on redelivery", () => {
    claimEvent("WH-ERR", "PAYMENT.CAPTURE.COMPLETED");
    finishEvent("WH-ERR", { outcome: "ERROR", action: "handler threw" });

    assert.equal(claimEvent("WH-ERR", "PAYMENT.CAPTURE.COMPLETED").first, true);
  });

  test("a refund for an order this process has never seen does not throw", () => {
    // Refunds get issued from the PayPal dashboard, and local state gets reset.
    // Throwing here would turn a normal event into a 500 and have PayPal
    // redeliver it for three days.
    assert.doesNotThrow(() => markRefunded("ORDER-NEVER-SEEN", "webhook"));
    assert.equal(getLocalOrder("ORDER-NEVER-SEEN")?.status, "REFUNDED");
  });
});

describe("rejected deliveries are quarantined", () => {
  test("a forged body cannot overwrite the record of a genuine event", () => {
    const orderId = "ORDER-TARGET";
    createLocalOrder(orderId);
    handleEvent(captureCompleted({ orderId, captureId: "CAP-T", eventId: "WH-REAL" }));

    // The attacker replays the id of an event they know we processed.
    recordRejection("WH-REAL", "PAYMENT.CAPTURE.COMPLETED", { method: "self", reason: "signature invalid" });

    const genuine = getEvent("WH-REAL");
    assert.equal(genuine?.outcome, "PROCESSED", "the genuine record must be untouched");
    assert.equal(genuine?.orderId, orderId);
    assert.equal(allRejections().length, 1, "and the rejection is logged separately");
  });

  test("a forged body cannot pre-claim an id so the real event is later dropped", () => {
    recordRejection("WH-FUTURE", "PAYMENT.CAPTURE.COMPLETED", { method: "self", reason: "signature invalid" });

    // PayPal now delivers the real event with that id.
    createLocalOrder("ORDER-LATER");
    const real = handleEvent(
      captureCompleted({ orderId: "ORDER-LATER", captureId: "CAP-L", eventId: "WH-FUTURE" }),
    );

    assert.equal(real.outcome, "PROCESSED", "the genuine event must still be processed");
    assert.equal(getLocalOrder("ORDER-LATER")?.status, "FULFILLED");
  });
});

describe("capture outcomes are not all the same", () => {
  test("a denied capture is a failure, not a refund", () => {
    const orderId = "ORDER-DENIED";
    createLocalOrder(orderId);

    handleEvent({
      id: "WH-DENIED",
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: { id: "CAP-D", supplementary_data: { related_ids: { order_id: orderId } } },
    });

    // The money never moved. Calling that "refunded" would be a lie in the
    // one place a merchant would go looking for it.
    assert.equal(getLocalOrder(orderId)?.status, "FAILED");
  });

  test("a reversal is recorded as money going back", () => {
    const orderId = "ORDER-REVERSED";
    createLocalOrder(orderId);
    handleEvent(captureCompleted({ orderId, captureId: "CAP-RV", eventId: "WH-PAID" }));

    handleEvent({
      id: "WH-REVERSED",
      event_type: "PAYMENT.CAPTURE.REVERSED",
      resource: { id: "CAP-RV", supplementary_data: { related_ids: { order_id: orderId } } },
    });

    assert.equal(getLocalOrder(orderId)?.status, "REFUNDED");
  });
});

describe("verification", () => {
  test("the signed message is built from the RAW bytes, not from re-serialised JSON", () => {
    // PayPal's docs are emphatic about this, and it is the most common webhook
    // bug: parse the body, re-stringify it, and the CRC no longer matches.
    // Whitespace, key order and unicode escaping are all part of the bytes
    // that were signed, and none of them survive a parse/stringify round trip.
    const raw = Buffer.from('{"id": "WH-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "summary": "Payment completed for $24.00 USD"}');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));

    assert.notEqual(raw.toString(), reserialised.toString(), "sanity: the two byte sequences really do differ");

    const fromRaw = buildSignedMessage("t-id", "2026-08-17T00:00:00Z", "WH-ID", raw);
    const fromParsed = buildSignedMessage("t-id", "2026-08-17T00:00:00Z", "WH-ID", reserialised);

    assert.notEqual(fromRaw, fromParsed, "re-serialising must change the message — that is why we keep the raw body");
    assert.match(fromRaw, /^t-id\|2026-08-17T00:00:00Z\|WH-ID\|\d+$/);
  });

  test("identical bytes always produce an identical message", () => {
    const raw = Buffer.from('{"a":1}');
    assert.equal(
      buildSignedMessage("x", "y", "z", raw),
      buildSignedMessage("x", "y", "z", Buffer.from(raw)),
    );
  });

  test("signing certificates are only fetched from PayPal", () => {
    assert.equal(isTrustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-abc"), true);
    assert.equal(isTrustedCertUrl("https://api-m.paypal.com/v1/notifications/certs/CERT-abc"), true);

    // The header is attacker-controlled. Fetching a certificate from wherever
    // it points would let anyone sign their own "payment completed".
    assert.equal(isTrustedCertUrl("https://evil.example.com/cert.pem"), false);
    assert.equal(isTrustedCertUrl("http://api.paypal.com/cert.pem"), false, "http is not acceptable");
    assert.equal(isTrustedCertUrl("https://paypal.com.evil.example/cert.pem"), false);
    assert.equal(isTrustedCertUrl("not-a-url"), false);
  });

  test("a delivery with no signature headers fails verification", async () => {
    const result = await verifySelf(Buffer.from("{}"), {}, "WEBHOOK_ID");

    assert.equal(result.verified, false);
    assert.match(result.reason ?? "", /missing/);
  });

  test("verifyAndParse returns no event when verification fails", async () => {
    const { result, event } = await verifyAndParse(
      Buffer.from('{"id":"WH-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED"}'),
      {},
      "self",
      "WEBHOOK_ID",
    );

    assert.equal(result.verified, false);
    assert.equal(event, undefined, "an unverified body must never come back as a parsed event");
  });
});
