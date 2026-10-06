/**
 * The subscription state machine.
 *
 * What is being asserted is the separation: PayPal's billing status and this
 * application's access decision move independently, and the app's policy is
 * what turns one into the other.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  applySubscriptionEvent,
  clearSubscriptions,
  getSubscription,
  hasAccess,
  upsertSubscription,
  type AccessPolicy,
} from "../src/domain/subscription-state.js";

const POLICY: AccessPolicy = { graceFailures: 2, graceDays: 7 };
const ID = "I-TEST0001";

beforeEach(() => {
  clearSubscriptions();
  upsertSubscription(ID, "P-TESTPLAN");
});

let n = 0;
const evt = () => `evt-${++n}`;

describe("the happy path", () => {
  test("activation grants access", () => {
    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);

    assert.equal(res.record.billingStatus, "ACTIVE");
    assert.equal(res.record.accessLevel, "FULL");
    assert.equal(hasAccess(ID), true);
  });

  test("nothing is granted before the money moves", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.CREATED", evt(), POLICY);

    assert.equal(getSubscription(ID)?.accessLevel, "NONE");
    assert.equal(hasAccess(ID), false);
  });
});

describe("a failed renewal", () => {
  beforeEach(() => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);
  });

  test("the first failure starts a grace period rather than locking the customer out", () => {
    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);

    assert.equal(res.record.accessLevel, "GRACE");
    assert.equal(res.record.consecutiveFailures, 1);
    // PayPal has NOT suspended anything yet — it is still retrying.
    assert.equal(res.record.billingStatus, "ACTIVE");
    assert.equal(hasAccess(ID), true, "a customer in grace still has access");
  });

  test("access survives up to the policy's allowance and no further", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);
    assert.equal(getSubscription(ID)?.accessLevel, "GRACE", "two failures is within the allowance of two");

    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);
    assert.equal(getSubscription(ID)?.accessLevel, "SUSPENDED", "the third exceeds it");
    assert.equal(hasAccess(ID), false);
  });

  test("a later success clears the failure count and restores access", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);
    const res = applySubscriptionEvent(ID, "PAYMENT.SALE.COMPLETED", evt(), POLICY);

    assert.equal(res.record.accessLevel, "FULL");
    assert.equal(res.record.consecutiveFailures, 0);
    assert.equal(res.record.graceStartedAt, undefined);
    assert.match(res.appDecided, /restore full access/);
  });

  test("PayPal suspending is mirrored, not second-guessed", () => {
    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.SUSPENDED", evt(), POLICY);

    assert.equal(res.record.billingStatus, "SUSPENDED");
    assert.equal(res.record.accessLevel, "SUSPENDED");
  });
});

describe("replayed events", () => {
  test("a redelivered failure does not burn a second grace attempt", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);

    const eventId = "WH-FAILED-ONCE";
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", eventId, POLICY);
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", eventId, POLICY);
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", eventId, POLICY);

    const record = getSubscription(ID)!;
    assert.equal(record.consecutiveFailures, 1, "three deliveries of one failure is still one failure");
    assert.equal(record.accessLevel, "GRACE");
  });

  test("a replay reports that it changed nothing", () => {
    const eventId = "WH-ACTIVATED-ONCE";
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", eventId, POLICY);
    const replay = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", eventId, POLICY);

    assert.equal(replay.changed, false);
    assert.match(replay.appDecided, /already applied/);
  });
});

describe("policy is ours, billing is theirs", () => {
  test("a stricter policy locks the customer out sooner, with no change to PayPal's side", () => {
    const strict: AccessPolicy = { graceFailures: 0, graceDays: 0 };
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), strict);

    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), strict);

    assert.equal(res.record.accessLevel, "SUSPENDED", "no grace at all under this policy");
    assert.equal(res.record.billingStatus, "ACTIVE", "PayPal is still retrying regardless of our choice");
  });

  test("cancellation ends renewal, not the period already paid for", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);
    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.CANCELLED", evt(), POLICY);

    assert.equal(res.record.billingStatus, "CANCELLED");
    assert.equal(res.record.accessLevel, "FULL");
    assert.match(res.appDecided, /until the end of the paid period/);
  });

  test("expiry ends access", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);
    const res = applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.EXPIRED", evt(), POLICY);

    assert.equal(res.record.accessLevel, "ENDED");
    assert.equal(hasAccess(ID), false);
  });

  test("every transition is recorded with the reason for it", () => {
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.ACTIVATED", evt(), POLICY);
    applySubscriptionEvent(ID, "BILLING.SUBSCRIPTION.PAYMENT.FAILED", evt(), POLICY);

    const history = getSubscription(ID)!.history;
    assert.equal(history.length, 2);
    assert.ok(history.every((h) => h.why.length > 0), "an unexplained state change is not auditable");
  });
});
