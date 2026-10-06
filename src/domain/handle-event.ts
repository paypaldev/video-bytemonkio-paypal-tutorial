/**
 * What to do with a webhook event, once — and only once — it has been verified.
 *
 * The shape of every handler in here is the same three steps, and the order is
 * the point:
 *
 *   1. claim the event id      (first delivery wins; everything else is a replay)
 *   2. apply the business fact (idempotent on its own key too — belt and braces)
 *   3. record the outcome      (so a replay can explain itself, not just vanish)
 *
 * Step 3 is what makes duplicate handling debuggable instead of invisible. A
 * silently dropped duplicate and a silently dropped genuine event look
 * identical in production at 3am.
 */

import { claimEvent, finishEvent, type EventOutcome } from "../store/events.js";
import type { WebhookEvent } from "../paypal/webhooks.js";
import { fulfil, markPaid, markRefunded, markFailed, markApproved, getLocalOrder } from "./order-state.js";
import { applySubscriptionEvent } from "./subscription-state.js";

export interface HandleResult {
  outcome: EventOutcome;
  /** One line for the console and for the response body. */
  action: string;
  eventId: string;
  eventType: string;
  deliveries: number;
  orderId?: string;
  subscriptionId?: string;
}

/**
 * Dig the order id out of a capture event.
 *
 * A capture resource carries the order id under supplementary_data, not at the
 * top level — the resource is the CAPTURE, and the order is its parent. Worth
 * knowing before you go looking for `resource.order_id`.
 */
function orderIdFromResource(resource: Record<string, any> | undefined): string | undefined {
  if (!resource) return undefined;
  return (
    resource.supplementary_data?.related_ids?.order_id ??
    resource.id_of_order ??
    (resource.intent && resource.id ? resource.id : undefined)
  );
}

export function handleEvent(event: WebhookEvent): HandleResult {
  const { first, record } = claimEvent(event.id, event.event_type, event.create_time);

  const base = {
    eventId: event.id,
    eventType: event.event_type,
    deliveries: record.deliveries,
  };

  if (!first) {
    // The replay path. We do nothing, and we say exactly what we did the first
    // time, because "nothing happened" is only reassuring with evidence.
    //
    // Note this branch is only reached when the earlier delivery FINISHED. A
    // claim that never completed is handed back as first=true so PayPal's
    // redelivery can finish the job — see claimEvent.
    finishEvent(event.id, { outcome: "REPLAY" });
    return {
      ...base,
      outcome: "REPLAY",
      action: `replay #${record.deliveries} — first handled at ${record.firstSeenAt}: ${record.action ?? "processed"}`,
      ...(record.orderId ? { orderId: record.orderId } : {}),
      ...(record.subscriptionId ? { subscriptionId: record.subscriptionId } : {}),
    };
  }

  const resource = event.resource ?? {};

  switch (event.event_type) {
    // --- one-time payments -------------------------------------------------

    case "CHECKOUT.ORDER.APPROVED": {
      const orderId = resource.id as string | undefined;
      if (!orderId) return finishWith(base, "IGNORED", "no order id on the event");
      const res = markApproved(orderId, "webhook");
      // A late "approved" for an order we already captured is a no-op, and
      // saying so plainly is more useful than reporting it as processed.
      return finishWith(
        base,
        res.changed ? "PROCESSED" : "IGNORED",
        `order ${orderId}: ${res.explanation}`,
        { orderId },
      );
    }

    case "PAYMENT.CAPTURE.COMPLETED": {
      const captureId = resource.id as string | undefined;
      const orderId = orderIdFromResource(resource);
      if (!captureId || !orderId) {
        return finishWith(base, "IGNORED", "capture event without a capture id or parent order id");
      }

      const amount = resource.amount?.value as string | undefined;
      const currency = resource.amount?.currency_code as string | undefined;

      // This is the out-of-order case. If the buyer's browser has not come
      // back yet, this webhook is the FIRST thing to tell us the money moved,
      // and the order is created here rather than by the redirect.
      const paid = markPaid(orderId, captureId, "webhook", amount, currency);
      const shipped = fulfil(orderId, "webhook");

      return finishWith(
        base,
        "PROCESSED",
        `${paid.explanation}; fulfilment: ${shipped.explanation}`,
        { orderId },
      );
    }

    // A denied capture is not a refund. The money never moved at all, so the
    // order failed — it did not come back.
    case "PAYMENT.CAPTURE.DENIED": {
      const orderId = orderIdFromResource(resource);
      if (!orderId) return finishWith(base, "IGNORED", "no parent order id");
      const res = markFailed(orderId, "webhook", "capture denied by PayPal");
      return finishWith(base, "PROCESSED", `order ${orderId}: ${res.explanation}`, { orderId });
    }

    case "PAYMENT.CAPTURE.REVERSED":
    case "PAYMENT.CAPTURE.REFUNDED": {
      const orderId = orderIdFromResource(resource);
      if (!orderId) return finishWith(base, "IGNORED", "no parent order id");
      const res = markRefunded(orderId, "webhook");
      return finishWith(base, "PROCESSED", `order ${orderId}: ${res.explanation}`, { orderId });
    }

    // --- subscriptions -----------------------------------------------------

    case "BILLING.SUBSCRIPTION.CREATED":
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.UPDATED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": {
      const subscriptionId = (resource.id ?? resource.subscription_id) as string | undefined;
      if (!subscriptionId) return finishWith(base, "IGNORED", "no subscription id on the event");

      const res = applySubscriptionEvent(
        subscriptionId,
        event.event_type,
        event.id,
        undefined,
        resource,
      );
      return finishWith(
        base,
        "PROCESSED",
        `PayPal ${res.paypalDid} → app decides: ${res.appDecided}`,
        { subscriptionId },
      );
    }

    // A successful subscription charge arrives under the Payments namespace,
    // not the Billing one. `billing_agreement_id` is what links the sale back
    // to the subscription.
    case "PAYMENT.SALE.COMPLETED": {
      const subscriptionId = resource.billing_agreement_id as string | undefined;
      if (!subscriptionId) {
        return finishWith(base, "IGNORED", "a one-off sale, not a subscription charge");
      }
      const res = applySubscriptionEvent(subscriptionId, event.event_type, event.id, undefined, resource);
      return finishWith(
        base,
        "PROCESSED",
        `PayPal ${res.paypalDid} → app decides: ${res.appDecided}`,
        { subscriptionId },
      );
    }

    default:
      return finishWith(base, "IGNORED", `no handler for ${event.event_type} — acknowledged and dropped`);
  }
}

function finishWith(
  base: { eventId: string; eventType: string; deliveries: number },
  outcome: EventOutcome,
  action: string,
  ids: { orderId?: string; subscriptionId?: string } = {},
): HandleResult {
  finishEvent(base.eventId, { outcome, action, ...ids });
  return { ...base, outcome, action, ...ids };
}

/** Used by the return-page poller so the frontend can catch up to the webhook. */
export function orderView(orderId: string) {
  const order = getLocalOrder(orderId);
  if (!order) return { known: false as const };
  return {
    known: true as const,
    status: order.status,
    captureId: order.captureId,
    paidLearnedFrom: order.paidLearnedFrom,
    fulfilmentAttempts: order.fulfilmentAttempts,
    fulfilledAt: order.fulfilledAt,
    history: order.history,
  };
}
