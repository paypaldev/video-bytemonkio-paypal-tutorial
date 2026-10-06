/**
 * Turning PayPal's error responses into a decision.
 *
 * The script's claim, and the thing this file has to earn: three failures that
 * look similar require three different responses.
 *
 *   SHOW_CUSTOMER  the buyer's instrument failed. Nothing you retry will fix
 *                  it. Tell them, and let them choose another way to pay.
 *   FIX_REQUEST    you sent something wrong. A retry sends the same wrong
 *                  thing. This is a bug report, not a transient failure.
 *   RETRY          nobody did anything wrong; the network or the platform
 *                  blinked. Retry with backoff and the same PayPal-Request-Id.
 *
 * The classification is derived from the HTTP status plus PayPal's structured
 * error body — `name`, and `details[].issue`. That structure is exactly what
 * makes automated recovery possible instead of manual triage.
 * Reference: https://developer.paypal.com/api/rest/responses/
 */

export type Handling = "SHOW_CUSTOMER" | "FIX_REQUEST" | "RETRY";

export interface PayPalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  value?: string;
}

export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  links?: Array<{ href: string; rel: string; method?: string }>;
  error?: string;
  error_description?: string;
}

/**
 * Issues that mean "the money did not move, and it is not your code's fault".
 * These are the ones a human buyer needs to hear about.
 */
const BUYER_FACING_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "PAYER_CANNOT_PAY",
  "TRANSACTION_REFUSED",
  "PAYMENT_DENIED",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
  "TRANSACTION_LIMIT_EXCEEDED",
  "INSUFFICIENT_FUNDS",
]);

/** Errors whose only cure is an authenticated caller fixing their own request. */
const FIX_REQUEST_NAMES = new Set([
  "INVALID_REQUEST",
  "VALIDATION_ERROR",
  "UNPROCESSABLE_ENTITY",
  "NOT_AUTHORIZED",
  "AUTHENTICATION_FAILURE",
  "RESOURCE_NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "MEDIA_TYPE_NOT_ACCEPTABLE",
  "UNSUPPORTED_MEDIA_TYPE",
]);

export class PayPalApiError extends Error {
  readonly status: number;
  readonly body: PayPalErrorBody;
  readonly debugId: string | undefined;
  readonly issues: string[];
  readonly handling: Handling;
  readonly requestId: string | undefined;
  /** Seconds from the HTTP `Retry-After` header, when the server sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: PayPalErrorBody, requestId?: string, retryAfterSeconds?: number) {
    const issues = (body.details ?? []).map((d) => d.issue).filter((i): i is string => Boolean(i));
    const name = body.name ?? body.error ?? `HTTP_${status}`;
    super(`${name}${issues.length ? ` (${issues.join(", ")})` : ""}: ${body.message ?? body.error_description ?? ""}`);

    this.name = "PayPalApiError";
    this.status = status;
    this.body = body;
    this.debugId = body.debug_id;
    this.issues = issues;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.handling = classify(status, name, issues);
  }

  /**
   * What the buyer is allowed to see. Never leak debug_id or field paths into
   * a customer-facing string — that is internal detail, and on a decline it is
   * also not actionable for them.
   */
  customerMessage(): string {
    if (this.handling !== "SHOW_CUSTOMER") {
      return "We couldn't complete your payment. Please try again in a moment.";
    }
    if (this.issues.includes("INSTRUMENT_DECLINED")) {
      return "That payment method was declined. Please choose a different one.";
    }
    if (this.issues.includes("INSUFFICIENT_FUNDS")) {
      return "There weren't enough funds available. Please choose a different payment method.";
    }
    return "Your payment couldn't be completed. Please try a different payment method.";
  }

  /** One line an on-call engineer can act on. debug_id is what PayPal support asks for. */
  operatorMessage(): string {
    const parts = [`status=${this.status}`, `name=${this.body.name ?? this.body.error ?? "?"}`];
    if (this.issues.length) parts.push(`issues=${this.issues.join("|")}`);
    if (this.debugId) parts.push(`debug_id=${this.debugId}`);
    if (this.requestId) parts.push(`PayPal-Request-Id=${this.requestId}`);
    return parts.join(" ");
  }
}

export function classify(status: number, name: string, issues: string[]): Handling {
  // A declined instrument can arrive as 422 UNPROCESSABLE_ENTITY. The status
  // code alone would send you down the "fix your request" path, which is
  // wrong: there is nothing to fix. The issue code is what disambiguates.
  if (issues.some((i) => BUYER_FACING_ISSUES.has(i))) return "SHOW_CUSTOMER";

  // 429 is retryable, but only with backoff, and honouring Retry-After when
  // the server sends one — see callWithRetry in client.ts.
  if (status === 429) return "RETRY";
  if (status >= 500) return "RETRY";

  if (FIX_REQUEST_NAMES.has(name)) return "FIX_REQUEST";
  if (status >= 400 && status < 500) return "FIX_REQUEST";

  return "RETRY";
}

/** Human-readable version of the branch, for narration. */
export function handlingLabel(h: Handling): string {
  switch (h) {
    case "SHOW_CUSTOMER":
      return "show the customer";
    case "FIX_REQUEST":
      return "fix the code";
    case "RETRY":
      return "retry";
  }
}

/** Network-level failure: the request never got an HTTP response at all. */
export class PayPalTransportError extends Error {
  readonly handling: Handling = "RETRY";
  readonly requestId: string | undefined;

  constructor(cause: unknown, requestId?: string) {
    super(`Transport failure before any response was read: ${(cause as Error)?.message ?? cause}`);
    this.name = "PayPalTransportError";
    this.requestId = requestId;
    this.cause = cause;
  }

  operatorMessage(): string {
    return `transport-failure PayPal-Request-Id=${this.requestId ?? "(none)"} — outcome UNKNOWN, safe to retry with the same id`;
  }

  customerMessage(): string {
    return "We're confirming your payment. This will only take a moment.";
  }
}

export type PaymentFailure = PayPalApiError | PayPalTransportError;

export function isPaymentFailure(e: unknown): e is PaymentFailure {
  return e instanceof PayPalApiError || e instanceof PayPalTransportError;
}
