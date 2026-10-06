/**
 * The subscription state machine — the application's half of it.
 *
 * This is the thesis line of the whole video, expressed as code:
 *
 *     PayPal moves the money. The application decides access.
 *
 * PayPal owns the billing state: it knows the plan, runs the billing cycles,
 * retries a failed charge according to the plan's payment_failure_threshold,
 * and eventually suspends the subscription. Those are PayPal's transitions and
 * they arrive as webhooks.
 *
 * What PayPal cannot know is what a failed renewal should MEAN to your
 * customer. Does a missed payment lock them out tonight, or do they get three
 * days to update a card? Does a suspended subscription keep read-only access?
 * Those are business decisions, and they belong here — which is why this file
 * has no PayPal API calls in it at all.
 *
 * The two states are tracked separately on purpose:
 *   billingStatus  mirrored from PayPal, never invented locally
 *   accessLevel    decided here, from the billing status plus our own policy
 */

import { JsonStore } from "../store/json-store.js";

/** PayPal's subscription status values. We mirror, we do not invent. */
export type BillingStatus =
  | "APPROVAL_PENDING"
  | "APPROVED"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

/** What the customer can actually do in our product. Ours to decide. */
export type AccessLevel =
  /** Not paid yet, nothing granted. */
  | "NONE"
  /** Full access, everything working. */
  | "FULL"
  /** A renewal failed. We keep them in while PayPal retries. */
  | "GRACE"
  /** Grace ran out or PayPal gave up. Locked, but data retained. */
  | "SUSPENDED"
  /** Over. */
  | "ENDED";

export interface AccessPolicy {
  /**
   * How many failed renewals we absorb before locking the account.
   *
   * Keep this at or below the plan's payment_failure_threshold, otherwise
   * PayPal suspends the subscription while your app still thinks the customer
   * is in a grace period — the two state machines drift apart and the customer
   * gets a confusing experience.
   */
  graceFailures: number;
  /** Wall-clock cap on grace, independent of retry count. */
  graceDays: number;
}

export const DEFAULT_POLICY: AccessPolicy = {
  graceFailures: 2,
  graceDays: 7,
};

export interface SubscriptionRecord {
  subscriptionId: string;
  planId?: string;
  billingStatus: BillingStatus;
  accessLevel: AccessLevel;
  /** Consecutive failed renewals. Reset to zero by any success. */
  consecutiveFailures: number;
  graceStartedAt?: string;
  lastPaymentAt?: string;
  lastFailureAt?: string;
  nextBillingTime?: string;
  appliedEventIds: string[];
  history: Array<{ at: string; event: string; billing: BillingStatus; access: AccessLevel; why: string }>;
  createdAt: string;
  updatedAt: string;
}

const store = new JsonStore<SubscriptionRecord>("subscriptions");

function now(): string {
  return new Date().toISOString();
}

export function upsertSubscription(
  subscriptionId: string,
  planId?: string,
  billingStatus: BillingStatus = "APPROVAL_PENDING",
): SubscriptionRecord {
  const existing = store.get(subscriptionId);
  if (existing) return existing;

  const record: SubscriptionRecord = {
    subscriptionId,
    ...(planId ? { planId } : {}),
    billingStatus,
    accessLevel: "NONE",
    consecutiveFailures: 0,
    appliedEventIds: [],
    history: [],
    createdAt: now(),
    updatedAt: now(),
  };
  store.set(subscriptionId, record);
  return record;
}

export function getSubscription(id: string): SubscriptionRecord | undefined {
  return store.get(id);
}

export function allSubscriptions(): SubscriptionRecord[] {
  return store.values();
}

export interface TransitionResult {
  record: SubscriptionRecord;
  changed: boolean;
  /** The sentence to say out loud: what PayPal did, then what we decided. */
  paypalDid: string;
  appDecided: string;
}

/**
 * Apply one subscription webhook.
 *
 * Idempotent on eventId, like every other event path in this repo: a replayed
 * BILLING.SUBSCRIPTION.PAYMENT.FAILED must not burn a second grace attempt.
 */
export function applySubscriptionEvent(
  subscriptionId: string,
  eventType: string,
  eventId: string,
  policy: AccessPolicy = DEFAULT_POLICY,
  resource?: { plan_id?: string; status?: string; billing_info?: { next_billing_time?: string } },
): TransitionResult {
  const record = store.get(subscriptionId) ?? upsertSubscription(subscriptionId, resource?.plan_id);

  if (record.appliedEventIds.includes(eventId)) {
    return {
      record,
      changed: false,
      paypalDid: `redelivered ${eventType}`,
      appDecided: "nothing — this event was already applied",
    };
  }
  record.appliedEventIds.push(eventId);

  const before = { billing: record.billingStatus, access: record.accessLevel };
  let paypalDid = eventType;
  let appDecided = "no change";

  switch (eventType) {
    case "BILLING.SUBSCRIPTION.CREATED":
      record.billingStatus = "APPROVAL_PENDING";
      record.accessLevel = "NONE";
      paypalDid = "created the subscription; the buyer has not approved yet";
      appDecided = "grant nothing until money has actually moved";
      break;

    case "BILLING.SUBSCRIPTION.ACTIVATED":
      record.billingStatus = "ACTIVE";
      record.accessLevel = "FULL";
      record.consecutiveFailures = 0;
      delete record.graceStartedAt;
      paypalDid = "activated the subscription and will now run the billing cycles";
      appDecided = "grant full access";
      break;

    // A successful charge on a subscription arrives as PAYMENT.SALE.COMPLETED.
    // Note it is NOT a BILLING.SUBSCRIPTION.* event — a detail worth knowing
    // before you go looking for an event that does not exist.
    case "PAYMENT.SALE.COMPLETED":
      record.lastPaymentAt = now();
      record.billingStatus = "ACTIVE";
      if (record.consecutiveFailures > 0 || record.accessLevel === "GRACE") {
        record.consecutiveFailures = 0;
        delete record.graceStartedAt;
        record.accessLevel = "FULL";
        paypalDid = "retried the charge and it succeeded";
        appDecided = "clear the grace period and restore full access";
      } else {
        record.accessLevel = "FULL";
        paypalDid = "charged the customer for this billing cycle";
        appDecided = "keep access on";
      }
      break;

    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      record.consecutiveFailures += 1;
      record.lastFailureAt = now();
      paypalDid = `could not collect this cycle's payment (failure ${record.consecutiveFailures}); it will retry per the plan's payment_failure_threshold`;

      if (record.consecutiveFailures <= policy.graceFailures) {
        if (!record.graceStartedAt) record.graceStartedAt = now();
        record.accessLevel = "GRACE";
        appDecided = `keep access on for up to ${policy.graceDays} days while PayPal retries (failure ${record.consecutiveFailures} of ${policy.graceFailures} allowed)`;
      } else {
        record.accessLevel = "SUSPENDED";
        appDecided = `grace exhausted after ${record.consecutiveFailures} failures — revoke access, keep the data`;
      }
      break;
    }

    case "BILLING.SUBSCRIPTION.SUSPENDED":
      record.billingStatus = "SUSPENDED";
      record.accessLevel = "SUSPENDED";
      paypalDid = "suspended the subscription and stopped attempting to bill";
      appDecided = "revoke access; keep the account so they can come back";
      break;

    case "BILLING.SUBSCRIPTION.CANCELLED":
      record.billingStatus = "CANCELLED";
      // Deliberate policy choice, and one worth saying out loud on camera:
      // a cancellation ends renewal, not the cycle they already paid for.
      record.accessLevel = record.accessLevel === "FULL" ? "FULL" : "ENDED";
      paypalDid = "cancelled the subscription; there will be no further charges";
      appDecided =
        record.accessLevel === "FULL"
          ? "keep access until the end of the paid period, then end it"
          : "end access";
      break;

    case "BILLING.SUBSCRIPTION.EXPIRED":
      record.billingStatus = "EXPIRED";
      record.accessLevel = "ENDED";
      paypalDid = "reached the end of the plan's billing cycles";
      appDecided = "end access";
      break;

    case "BILLING.SUBSCRIPTION.UPDATED":
      paypalDid = "recorded a change to the subscription";
      appDecided = "no access change; re-read the subscription if the plan changed";
      break;

    default:
      paypalDid = `sent ${eventType}`;
      appDecided = "not a state-changing event for us";
  }

  if (resource?.billing_info?.next_billing_time) {
    record.nextBillingTime = resource.billing_info.next_billing_time;
  }
  if (resource?.plan_id && !record.planId) record.planId = resource.plan_id;

  // Grace has a wall clock as well as a counter; whichever runs out first wins.
  if (record.accessLevel === "GRACE" && record.graceStartedAt) {
    const elapsedDays = (Date.now() - Date.parse(record.graceStartedAt)) / 86_400_000;
    if (elapsedDays > policy.graceDays) {
      record.accessLevel = "SUSPENDED";
      appDecided = `grace period of ${policy.graceDays} days elapsed — revoke access`;
    }
  }

  const changed = before.billing !== record.billingStatus || before.access !== record.accessLevel;
  record.updatedAt = now();
  record.history.push({
    at: record.updatedAt,
    event: eventType,
    billing: record.billingStatus,
    access: record.accessLevel,
    why: appDecided,
  });
  store.set(subscriptionId, record);

  return { record, changed, paypalDid, appDecided };
}

/** The single question the rest of the product asks. */
export function hasAccess(subscriptionId: string): boolean {
  const record = store.get(subscriptionId);
  return record ? record.accessLevel === "FULL" || record.accessLevel === "GRACE" : false;
}

export function clearSubscriptions(): void {
  store.clear();
}
