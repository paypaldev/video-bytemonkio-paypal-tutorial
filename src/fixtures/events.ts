/**
 * Event fixtures.
 *
 * These are the shapes PayPal actually sends, used for the offline demo and
 * for the tests. They are NOT signed, so they can never travel through the
 * verification path — anything built from these goes straight to handleEvent()
 * and the code makes that boundary obvious.
 */

import type { WebhookEvent } from "../paypal/webhooks.js";

export function captureCompleted(opts: {
  eventId?: string;
  orderId: string;
  captureId: string;
  amount?: string;
  currency?: string;
}): WebhookEvent {
  return {
    id: opts.eventId ?? `WH-TEST-${opts.captureId}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    resource_version: "2.0",
    summary: `Payment completed for ${opts.amount ?? "24.00"} ${opts.currency ?? "USD"}`,
    resource: {
      id: opts.captureId,
      status: "COMPLETED",
      amount: { currency_code: opts.currency ?? "USD", value: opts.amount ?? "24.00" },
      final_capture: true,
      create_time: new Date().toISOString(),
      // The order id lives here, not at the top level: the resource is the
      // capture, and the order is its parent.
      supplementary_data: { related_ids: { order_id: opts.orderId } },
    },
  };
}

export function orderApproved(opts: { eventId?: string; orderId: string }): WebhookEvent {
  return {
    id: opts.eventId ?? `WH-TEST-APPROVED-${opts.orderId}`,
    event_type: "CHECKOUT.ORDER.APPROVED",
    create_time: new Date().toISOString(),
    resource_type: "checkout-order",
    resource: { id: opts.orderId, status: "APPROVED" },
  };
}

export function subscriptionEvent(opts: {
  eventId?: string;
  eventType: string;
  subscriptionId: string;
  planId?: string;
  nextBillingTime?: string;
}): WebhookEvent {
  return {
    id: opts.eventId ?? `WH-TEST-${opts.eventType}-${Date.now()}`,
    event_type: opts.eventType,
    create_time: new Date().toISOString(),
    resource_type: "subscription",
    resource: {
      id: opts.subscriptionId,
      plan_id: opts.planId ?? "P-TESTPLAN0000000000000000",
      status: opts.eventType.endsWith("ACTIVATED") ? "ACTIVE" : "ACTIVE",
      ...(opts.nextBillingTime ? { billing_info: { next_billing_time: opts.nextBillingTime } } : {}),
    },
  };
}

/** A successful recurring charge. Note it is a PAYMENT event, not a BILLING one. */
export function subscriptionSaleCompleted(opts: {
  eventId?: string;
  subscriptionId: string;
  amount?: string;
}): WebhookEvent {
  return {
    id: opts.eventId ?? `WH-TEST-SALE-${Date.now()}`,
    event_type: "PAYMENT.SALE.COMPLETED",
    create_time: new Date().toISOString(),
    resource_type: "sale",
    resource: {
      id: `SALE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      state: "completed",
      amount: { total: opts.amount ?? "12.00", currency: "USD" },
      // This is the field that links a sale back to its subscription.
      billing_agreement_id: opts.subscriptionId,
    },
  };
}
