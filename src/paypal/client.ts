/**
 * The one place this repo talks to PayPal over HTTP.
 *
 * Everything the video argues about lives here in a form you can point at:
 *   - PayPal-Request-Id is a first-class argument, not an afterthought
 *   - errors are parsed into a decision, never swallowed
 *   - retries reuse the same request id, which is the only thing that makes
 *     retrying a payment safe
 *   - every call logs an outcome, including the ones that fail
 *
 * Reference: https://developer.paypal.com/api/rest/requests/
 */

import { randomUUID } from "node:crypto";
import { API_BASE } from "../config.js";
import { getAccessToken, clearTokenCache } from "./auth.js";
import { PayPalApiError, PayPalTransportError, type PayPalErrorBody } from "./errors.js";
import { http, note, verbose, warn } from "../log.js";

export interface CallOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /**
   * PayPal-Request-Id. Supply it for any POST that moves money.
   *
   * Two calls with the same id are the SAME call as far as PayPal is
   * concerned: the second returns the first one's result rather than creating
   * a second charge. PayPal stores the id for a limited window (documented as
   * 72 hours for Subscriptions/Catalog, and up to 45 days for refunds), so it
   * protects you across a retry, a double click, and a crash-and-restart.
   */
  requestId?: string;
  /**
   * PayPal-Mock-Response value for sandbox negative testing, e.g.
   * `{"mock_application_codes":"INSTRUMENT_DECLINED"}`.
   * Sandbox only — see scenarios/04-errors-three-ways.ts.
   */
  mockApplicationCode?: string;
  /** `return=representation` asks PayPal to send the full resource back. */
  prefer?: "return=minimal" | "return=representation";
  extraHeaders?: Record<string, string>;
  /** Print the request line. Off for polling loops. */
  quiet?: boolean;
}

export interface CallResult<T> {
  status: number;
  data: T;
  headers: Headers;
  /** The id we sent, so a caller can log or reuse it. */
  requestId: string | undefined;
  /** PayPal's correlation id — the thing their support team asks for. */
  debugId: string | undefined;
}

/** Generate an id tied to something meaningful, not just randomness. */
export function requestIdFor(purpose: string, key: string): string {
  return `${purpose}-${key}`;
}

export function newRequestId(prefix = "req"): string {
  return `${prefix}-${randomUUID()}`;
}

export async function call<T = unknown>(opts: CallOptions): Promise<CallResult<T>> {
  const method = opts.method ?? "GET";
  const url = `${API_BASE}${opts.path}`;
  const token = await getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...opts.extraHeaders,
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  if (opts.mockApplicationCode) {
    headers["PayPal-Mock-Response"] = JSON.stringify({
      mock_application_codes: opts.mockApplicationCode,
    });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (cause) {
    // No HTTP response at all. This is precisely the timeout case: we do not
    // know whether the money moved. The request id is the only way back.
    if (!opts.quiet) http(method, url);
    throw new PayPalTransportError(cause, opts.requestId);
  }

  const debugId = res.headers.get("paypal-debug-id") ?? res.headers.get("debug_id") ?? undefined;
  const text = await res.text();
  const data = text ? (safeJson(text) as T) : ({} as T);

  if (!opts.quiet) http(method, url, res.status);

  if (!res.ok) {
    const body = (typeof data === "object" && data !== null ? data : { message: text }) as PayPalErrorBody;
    if (debugId && !body.debug_id) body.debug_id = debugId;

    // Retry-After is an HTTP header, not a field in the error body. When the
    // server tells you how long to wait, waiting that long is the whole point.
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined;

    throw new PayPalApiError(res.status, body, opts.requestId, retryAfter);
  }

  verbose(`${method} ${opts.path} response`, data);

  return { status: res.status, data, headers: res.headers, requestId: opts.requestId, debugId };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Called before each retry so a scenario can narrate the wait. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/**
 * Retry a call that is safe to retry.
 *
 * Two rules make this safe rather than reckless:
 *   1. The SAME PayPal-Request-Id goes out on every attempt. Without that,
 *      "retry" and "charge again" are the same operation.
 *   2. Only failures classified RETRY are retried. A declined card retried
 *      four times is four declines and one annoyed customer.
 */
export async function callWithRetry<T = unknown>(
  opts: CallOptions,
  retry: RetryOptions = {},
): Promise<CallResult<T>> {
  const attempts = retry.attempts ?? 4;
  const base = retry.baseDelayMs ?? 400;

  if (!opts.requestId) {
    warn("callWithRetry without a PayPal-Request-Id — a retry could double-charge.");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call<T>(opts);
    } catch (err) {
      lastError = err;

      // A 401 usually means the cached token expired mid-flight. That is not
      // "fix your request" — it is one free retry with a fresh token. Checked
      // BEFORE the classification below, which would otherwise throw first.
      if (err instanceof PayPalApiError && err.status === 401 && attempt < attempts) {
        note("401 — discarding the cached access token and retrying once with a fresh one");
        clearTokenCache();
        continue;
      }

      const handling =
        err instanceof PayPalApiError || err instanceof PayPalTransportError ? err.handling : "FIX_REQUEST";

      if (handling !== "RETRY" || attempt === attempts) throw err;

      // Honour Retry-After when the server sent one. Otherwise exponential
      // backoff with jitter — without jitter, every one of your servers
      // retries in lockstep and you re-create the outage yourself.
      const retryAfter = err instanceof PayPalApiError ? err.retryAfterSeconds : undefined;
      const delay = retryAfter ? retryAfter * 1000 : base * 2 ** (attempt - 1) + Math.random() * 100;

      const reason = err instanceof PayPalApiError ? `HTTP ${err.status}` : "no response";
      retry.onRetry?.(attempt, Math.round(delay), reason);
      // The single narration point for a retry. Callers that want to count
      // attempts use onRetry; they should not also print, or the same event
      // appears twice on screen.
      note(`attempt ${attempt} failed (${reason}); retrying in ${Math.round(delay)}ms with the same request id`);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find a HATEOAS link by rel. PayPal drives approval flows through these. */
export function linkHref(
  links: Array<{ href: string; rel: string; method?: string }> | undefined,
  rel: string,
): string | undefined {
  return links?.find((l) => l.rel === rel)?.href;
}
