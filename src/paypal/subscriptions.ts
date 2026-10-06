/**
 * Catalog Products + Subscriptions (the current recurring-payments API).
 *
 * Three objects, in this order, and the order is not arbitrary:
 *
 *   product        what you sell.  POST /v1/catalogs/products
 *   plan           how it is priced and billed, including the trial and what
 *                  happens when a payment fails.  POST /v1/billing/plans
 *   subscription   one customer on one plan.  POST /v1/billing/subscriptions
 *
 * Note this is NOT the old Billing Agreements API. That one, along with its
 * webhooks, is deprecated — and it is exactly what an outdated tutorial will
 * hand you. Anything under /v1/billing/plans and /v1/billing/subscriptions is
 * the current generation.
 *
 * References:
 *   https://developer.paypal.com/docs/api/catalog-products/v1/
 *   https://developer.paypal.com/docs/api/subscriptions/v1/
 */

import { CURRENCY } from "../config.js";
import { call, type CallResult } from "./client.js";
import type { Link } from "./orders.js";

export interface Product {
  id: string;
  name: string;
  description?: string;
  type: "PHYSICAL" | "DIGITAL" | "SERVICE";
  category?: string;
  create_time?: string;
  links?: Link[];
}

export interface Plan {
  id: string;
  product_id: string;
  name: string;
  status: "CREATED" | "ACTIVE" | "INACTIVE";
  description?: string;
  billing_cycles?: BillingCycle[];
  payment_preferences?: PaymentPreferences;
  taxes?: { percentage: string; inclusive: boolean };
  create_time?: string;
  links?: Link[];
}

export interface BillingCycle {
  frequency: { interval_unit: "DAY" | "WEEK" | "MONTH" | "YEAR"; interval_count: number };
  tenure_type: "TRIAL" | "REGULAR";
  sequence: number;
  /** 0 on a REGULAR cycle means "bill forever". */
  total_cycles: number;
  pricing_scheme?: { fixed_price: { value: string; currency_code: string } };
}

export interface PaymentPreferences {
  auto_bill_outstanding: boolean;
  setup_fee?: { value: string; currency_code: string };
  setup_fee_failure_action?: "CONTINUE" | "CANCEL";
  /**
   * How many consecutive failed payments PayPal tolerates before it suspends
   * the subscription. This number is the contract between PayPal's retry
   * behaviour and your app's grace policy — keep them in sync, or your
   * customer will be locked out while PayPal still thinks it is retrying.
   */
  payment_failure_threshold: number;
}

export interface Subscription {
  id: string;
  plan_id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  status_update_time?: string;
  start_time?: string;
  subscriber?: {
    email_address?: string;
    name?: { given_name?: string; surname?: string };
  };
  billing_info?: {
    next_billing_time?: string;
    failed_payments_count?: number;
    outstanding_balance?: { currency_code: string; value: string };
    last_payment?: { amount: { currency_code: string; value: string }; time: string };
  };
  links?: Link[];
}

// --- product ---------------------------------------------------------------

export async function createProduct(input: {
  name: string;
  description?: string;
  type?: Product["type"];
  category?: string;
  requestId?: string;
}): Promise<CallResult<Product>> {
  return call<Product>({
    method: "POST",
    path: "/v1/catalogs/products",
    body: {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      type: input.type ?? "SERVICE",
      category: input.category ?? "SOFTWARE",
    },
    requestId: input.requestId,
    prefer: "return=representation",
  });
}

// --- plan ------------------------------------------------------------------

export interface CreatePlanInput {
  productId: string;
  name: string;
  description?: string;
  price: string;
  currency?: string;
  interval?: BillingCycle["frequency"]["interval_unit"];
  intervalCount?: number;
  /** Number of free trial cycles at the same interval. 0 for no trial. */
  trialCycles?: number;
  /** 0 = bill forever. */
  totalCycles?: number;
  paymentFailureThreshold?: number;
  setupFee?: string;
  requestId?: string;
}

/**
 * Create a plan with an optional free trial followed by the paid cycle.
 *
 * A plan may have at most two trial cycles and exactly one regular cycle, and
 * `sequence` has to run in order. The failure rules live here too — this is
 * the object that decides what "a failed renewal" does before your app ever
 * hears about it.
 */
export async function createPlan(input: CreatePlanInput): Promise<CallResult<Plan>> {
  const interval = input.interval ?? "MONTH";
  const intervalCount = input.intervalCount ?? 1;
  const currency = input.currency ?? CURRENCY;
  const trialCycles = input.trialCycles ?? 0;

  const cycles: BillingCycle[] = [];
  let sequence = 1;

  if (trialCycles > 0) {
    cycles.push({
      frequency: { interval_unit: interval, interval_count: intervalCount },
      tenure_type: "TRIAL",
      sequence: sequence++,
      total_cycles: trialCycles,
      // No pricing_scheme at all ⇒ a free trial.
    });
  }

  cycles.push({
    frequency: { interval_unit: interval, interval_count: intervalCount },
    tenure_type: "REGULAR",
    sequence: sequence,
    total_cycles: input.totalCycles ?? 0,
    pricing_scheme: { fixed_price: { value: input.price, currency_code: currency } },
  });

  const paymentPreferences: PaymentPreferences = {
    auto_bill_outstanding: true,
    setup_fee_failure_action: "CONTINUE",
    payment_failure_threshold: input.paymentFailureThreshold ?? 3,
    ...(input.setupFee ? { setup_fee: { value: input.setupFee, currency_code: currency } } : {}),
  };

  return call<Plan>({
    method: "POST",
    path: "/v1/billing/plans",
    body: {
      product_id: input.productId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      status: "ACTIVE",
      billing_cycles: cycles,
      payment_preferences: paymentPreferences,
    },
    requestId: input.requestId,
    prefer: "return=representation",
  });
}

export async function getPlan(planId: string): Promise<CallResult<Plan>> {
  return call<Plan>({ method: "GET", path: `/v1/billing/plans/${planId}` });
}

export async function listPlans(productId?: string): Promise<CallResult<{ plans?: Plan[] }>> {
  const query = productId ? `?product_id=${productId}&page_size=20` : "?page_size=20";
  return call<{ plans?: Plan[] }>({ method: "GET", path: `/v1/billing/plans${query}` });
}

export async function deactivatePlan(planId: string): Promise<CallResult<unknown>> {
  return call({ method: "POST", path: `/v1/billing/plans/${planId}/deactivate`, body: {} });
}

// --- subscription ----------------------------------------------------------

export async function createSubscription(input: {
  planId: string;
  subscriberEmail?: string;
  givenName?: string;
  surname?: string;
  customId?: string;
  /**
   * Where the buyer's browser goes after approving. Same trap as orders: with
   * no return_url the subscription is created and approved correctly, and the
   * buyer is left on PayPal watching a spinner.
   *
   * Note this is `application_context`, not the `experience_context` that
   * Orders v2 uses. The two APIs genuinely differ here.
   */
  returnUrl?: string;
  cancelUrl?: string;
  brandName?: string;
  requestId?: string;
}): Promise<CallResult<Subscription>> {
  return call<Subscription>({
    method: "POST",
    path: "/v1/billing/subscriptions",
    body: {
      plan_id: input.planId,
      ...(input.customId ? { custom_id: input.customId } : {}),
      application_context: {
        brand_name: input.brandName ?? "ByteMonk Demo Store",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
        ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
      },
      ...(input.subscriberEmail || input.givenName
        ? {
            subscriber: {
              ...(input.subscriberEmail ? { email_address: input.subscriberEmail } : {}),
              ...(input.givenName
                ? { name: { given_name: input.givenName, surname: input.surname ?? "Buyer" } }
                : {}),
            },
          }
        : {}),
    },
    requestId: input.requestId,
    prefer: "return=representation",
  });
}

export async function getSubscription(
  subscriptionId: string,
  quiet = false,
): Promise<CallResult<Subscription>> {
  return call<Subscription>({
    method: "GET",
    // `fields=last_failed_payment` is what tells you WHY a renewal failed.
    path: `/v1/billing/subscriptions/${subscriptionId}?fields=last_failed_payment,plan`,
    quiet,
  });
}

export async function suspendSubscription(id: string, reason: string): Promise<void> {
  await call({ method: "POST", path: `/v1/billing/subscriptions/${id}/suspend`, body: { reason } });
}

export async function activateSubscription(id: string, reason: string): Promise<void> {
  await call({ method: "POST", path: `/v1/billing/subscriptions/${id}/activate`, body: { reason } });
}

export async function cancelSubscription(id: string, reason: string): Promise<void> {
  await call({ method: "POST", path: `/v1/billing/subscriptions/${id}/cancel`, body: { reason } });
}

/** Where to send the buyer to approve. PayPal returns it as a HATEOAS link. */
export function subscriptionApproveLink(sub: Subscription): string | undefined {
  return (
    sub.links?.find((l) => l.rel === "approve")?.href ??
    sub.links?.find((l) => l.rel === "payer-action")?.href
  );
}
