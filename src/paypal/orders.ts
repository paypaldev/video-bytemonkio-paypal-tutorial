/**
 * Orders API v2 — the current generation for a new checkout.
 *
 * The three-line version of the whole video:
 *
 *   create()     you describe what you want to be paid, nobody has paid yet
 *   approve      the buyer says yes, at PayPal, outside your control
 *   capture()    the money actually moves
 *
 * and settlement — the money arriving in the merchant account — happens later
 * still, on PayPal's schedule, not on your request's. This module keeps those
 * stages separate on purpose. `intent` is what selects between capturing
 * immediately and authorizing now / capturing later.
 *
 * Reference: https://developer.paypal.com/docs/api/orders/v2/
 */

import { CURRENCY } from "../config.js";
import { call, callWithRetry, type CallResult, type RetryOptions } from "./client.js";

export type OrderIntent = "CAPTURE" | "AUTHORIZE";

/** Order status values we actually branch on. */
export type OrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface Money {
  currency_code: string;
  value: string;
}

export interface Capture {
  id: string;
  status: string;
  amount?: Money;
  final_capture?: boolean;
  create_time?: string;
  update_time?: string;
  seller_receivable_breakdown?: {
    gross_amount?: Money;
    paypal_fee?: Money;
    net_amount?: Money;
  };
  links?: Link[];
}

export interface Authorization {
  id: string;
  status: string;
  amount?: Money;
  /** When the authorization — the bank's promise — stops being good. */
  expiration_time?: string;
  create_time?: string;
  links?: Link[];
}

export interface PurchaseUnit {
  reference_id?: string;
  invoice_id?: string;
  custom_id?: string;
  amount: Money & {
    breakdown?: Record<string, Money>;
  };
  payments?: {
    captures?: Capture[];
    authorizations?: Authorization[];
    refunds?: Array<{ id: string; status: string; amount?: Money }>;
  };
}

export interface Order {
  id: string;
  status: OrderStatus;
  intent?: OrderIntent;
  create_time?: string;
  update_time?: string;
  purchase_units?: PurchaseUnit[];
  payer?: {
    email_address?: string;
    payer_id?: string;
    name?: { given_name?: string; surname?: string };
  };
  payment_source?: Record<string, unknown>;
  links?: Link[];
}

export interface CreateOrderInput {
  amount: string;
  currency?: string;
  intent?: OrderIntent;
  description?: string;
  /** Your own order reference. Comes back on the capture and on the webhook. */
  customId?: string;
  invoiceId?: string;
  /** Shown to the buyer on the PayPal review page. Requires payPalWalletOnly. */
  brandName?: string;
  /**
   * Where PayPal sends the buyer's browser after they approve or cancel.
   *
   * Without these, approval succeeds but the buyer is left on PayPal's page
   * with a spinning button, because there is nowhere for them to go next. Your
   * server is perfectly happy and the customer thinks the site is broken.
   *
   * The redirect is performed by the browser, not by PayPal's servers, so a
   * localhost URL is fine in development.
   */
  returnUrl?: string;
  cancelUrl?: string;
  /**
   * Pin this order to the PayPal wallet, via
   * `payment_source.paypal.experience_context`.
   *
   * Default OFF, and that default matters. Naming a payment source at creation
   * makes it the order's *preferred* source, and approving it with a different
   * one fails with PREFERRED_PAYMENT_SOURCE_MISMATCH. An order created with
   * `payment_source.paypal` therefore cannot be paid with the Venmo button —
   * which is exactly the trap for a checkout page that offers both.
   *
   * The CLI scenarios turn it on because they are PayPal-wallet flows and they
   * want the branded review page and its `payer-action` link. The checkout
   * page leaves it off so the buyer, not the server, chooses how to pay.
   */
  payPalWalletOnly?: boolean;
  requestId?: string;
  mockApplicationCode?: string;
}

/**
 * Create an order.
 *
 * Where an experience context is sent, note that it is `experience_context`
 * rather than the older `application_context` — the latter is deprecated on
 * Orders v2, and is exactly the kind of detail an old third-party tutorial
 * gets wrong.
 */
export async function createOrder(input: CreateOrderInput): Promise<CallResult<Order>> {
  const body = {
    intent: input.intent ?? "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: input.currency ?? CURRENCY,
          value: input.amount,
        },
        ...(input.description ? { description: input.description } : {}),
        ...(input.customId ? { custom_id: input.customId } : {}),
        ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      },
    ],
    ...(input.payPalWalletOnly
      ? {
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: input.brandName ?? "ByteMonk Demo Store",
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
                ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
              },
            },
          },
        }
      : {}),
  };

  return call<Order>({
    method: "POST",
    path: "/v2/checkout/orders",
    body,
    requestId: input.requestId,
    mockApplicationCode: input.mockApplicationCode,
    prefer: "return=representation",
  });
}

export async function getOrder(orderId: string, quiet = false): Promise<CallResult<Order>> {
  return call<Order>({ method: "GET", path: `/v2/checkout/orders/${orderId}`, quiet });
}

export interface CaptureOptions {
  /**
   * Required for any capture you might ever retry — which is all of them.
   * Deriving it from the order id (see requestIdFor) means a retry after a
   * crash produces the same id as the original attempt.
   */
  requestId: string;
  mockApplicationCode?: string;
  retry?: RetryOptions | false;
}

/** Capture an APPROVED order: the step where money actually moves. */
export async function captureOrder(
  orderId: string,
  opts: CaptureOptions,
): Promise<CallResult<Order>> {
  const callOpts = {
    method: "POST" as const,
    path: `/v2/checkout/orders/${orderId}/capture`,
    // The capture body is optional; `{}` is what PayPal's own sample sends,
    // and it keeps the Content-Type header honest.
    body: {},
    requestId: opts.requestId,
    mockApplicationCode: opts.mockApplicationCode,
    prefer: "return=representation" as const,
  };

  return opts.retry === false
    ? call<Order>(callOpts)
    : callWithRetry<Order>(callOpts, opts.retry ?? {});
}

/**
 * Authorize an order created with intent=AUTHORIZE.
 *
 * This is the step the video calls "the promise". Money is reserved and
 * nothing has been paid. The authorization carries an expiration_time, which
 * is the clearest single piece of evidence that authorization and capture are
 * genuinely different events.
 */
export async function authorizeOrder(
  orderId: string,
  requestId: string,
): Promise<CallResult<Order>> {
  return call<Order>({
    method: "POST",
    path: `/v2/checkout/orders/${orderId}/authorize`,
    body: {},
    requestId,
    prefer: "return=representation",
  });
}

/** Capture a previously-created authorization (Payments API v2). */
export async function captureAuthorization(
  authorizationId: string,
  requestId: string,
  amount?: Money,
): Promise<CallResult<Capture>> {
  return call<Capture>({
    method: "POST",
    path: `/v2/payments/authorizations/${authorizationId}/capture`,
    body: amount ? { amount, final_capture: true } : {},
    requestId,
    prefer: "return=representation",
  });
}

/** Release a hold you are not going to capture. Takes no request body. */
export async function voidAuthorization(
  authorizationId: string,
  requestId: string,
): Promise<CallResult<unknown>> {
  return call({
    method: "POST",
    path: `/v2/payments/authorizations/${authorizationId}/void`,
    requestId,
  });
}

// --- small readers, so scenarios stay about narration rather than optional chaining ---

export function firstCapture(order: Order): Capture | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}

export function firstAuthorization(order: Order): Authorization | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}

export function approveLink(order: Order): string | undefined {
  // PayPal has used both rels here over time; check the current one first.
  return (
    order.links?.find((l) => l.rel === "payer-action")?.href ??
    order.links?.find((l) => l.rel === "approve")?.href
  );
}

export function orderAmount(order: Order): string {
  const amount = order.purchase_units?.[0]?.amount;
  return amount ? `${amount.value} ${amount.currency_code}` : "(unknown)";
}
