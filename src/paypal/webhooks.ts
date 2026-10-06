/**
 * Webhook verification.
 *
 * An unverified webhook is not a payment event. It is a claim, made by anyone
 * on the internet who found your URL, that a payment happened. The difference
 * matters enough that this module refuses to hand back a parsed event at all
 * unless verification passed — see verifyAndParse() at the bottom.
 *
 * PayPal documents two methods and this repo implements both, because they
 * fail differently and a reviewer should see the trade-off:
 *
 *   self       verify the RSA signature locally against PayPal's certificate.
 *              No extra API call, no extra latency, no extra dependency on
 *              PayPal being up at the moment the event lands. PayPal calls
 *              this the preferred method.
 *   postback   POST the transmission back to PayPal and let them tell you.
 *              Simpler to reason about, one more network hop, and one more
 *              thing that can be down when you need it.
 *
 * Reference: https://developer.paypal.com/api/rest/webhooks/rest/
 */

import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { API_BASE, DATA_DIR, webhookId, hasWebhookId as hasWebhookIdConfigured } from "../config.js";
import { call } from "./client.js";
import { PayPalApiError } from "./errors.js";

export type VerificationMethod = "self" | "postback";

export interface TransmissionHeaders {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  event_version?: string;
  create_time?: string;
  resource_type?: string;
  resource_version?: string;
  summary?: string;
  resource?: Record<string, any>;
  links?: Array<{ href: string; rel: string; method?: string }>;
}

export interface VerificationResult {
  verified: boolean;
  method: VerificationMethod;
  reason?: string;
  /** ms spent verifying — the self/postback latency difference on camera. */
  durationMs: number;
}

export function readTransmissionHeaders(headers: Record<string, unknown>): TransmissionHeaders {
  const h = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : undefined;
  };
  return {
    transmissionId: h("paypal-transmission-id"),
    transmissionTime: h("paypal-transmission-time"),
    transmissionSig: h("paypal-transmission-sig"),
    certUrl: h("paypal-cert-url"),
    authAlgo: h("paypal-auth-algo"),
  };
}

/**
 * Only fetch certificates from PayPal's own domains.
 *
 * Without this check, an attacker sets paypal-cert-url to a certificate they
 * control, signs their forged event with the matching private key, and your
 * verification passes with flying colours. The header is attacker-controlled
 * input; treat it that way.
 */
function assertTrustedCertUrl(certUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(certUrl);
  } catch {
    throw new Error(`paypal-cert-url is not a valid URL: ${certUrl}`);
  }
  const trusted =
    parsed.protocol === "https:" &&
    (parsed.hostname === "api.paypal.com" ||
      parsed.hostname === "api.sandbox.paypal.com" ||
      parsed.hostname === "api-m.paypal.com" ||
      parsed.hostname === "api-m.sandbox.paypal.com" ||
      parsed.hostname.endsWith(".paypal.com"));
  if (!trusted) {
    throw new Error(`Refusing to fetch a signing certificate from an untrusted host: ${parsed.hostname}`);
  }
}

const CERT_DIR = path.join(DATA_DIR, "certs");

/** Certificates are stable; caching keeps verification off the network. */
async function fetchCertificate(certUrl: string): Promise<string> {
  assertTrustedCertUrl(certUrl);
  const key = certUrl.replace(/\W+/g, "-");
  const file = path.join(CERT_DIR, `${key}.pem`);

  const cached = await fs.readFile(file, "utf8").catch(() => null);
  if (cached) return cached;

  const res = await fetch(certUrl);
  if (!res.ok) throw new Error(`Could not download signing certificate: HTTP ${res.status}`);
  const pem = await res.text();

  await fs.mkdir(CERT_DIR, { recursive: true });
  await fs.writeFile(file, pem);
  return pem;
}

/**
 * Verify locally.
 *
 * The signed message is exactly:
 *   transmissionId | transmissionTime | webhookId | crc32(rawBody)
 *
 * `rawBody` must be the bytes PayPal sent. Parsing the JSON and re-serialising
 * it produces a different byte sequence — different key order, different
 * whitespace, different unicode escaping — and a different CRC, and
 * verification fails for a perfectly genuine event. That is the single most
 * common webhook bug, and it is why the express route uses express.raw().
 */
export function buildSignedMessage(
  transmissionId: string,
  transmissionTime: string,
  webhookIdValue: string,
  rawBody: Buffer,
): string {
  // CRC32 of the RAW bytes, in decimal form. Node 22 ships this in zlib.
  return `${transmissionId}|${transmissionTime}|${webhookIdValue}|${zlib.crc32(rawBody)}`;
}

/** Exposed so the cert-URL rule can be tested directly. */
export function isTrustedCertUrl(certUrl: string): boolean {
  try {
    assertTrustedCertUrl(certUrl);
    return true;
  } catch {
    return false;
  }
}

export async function verifySelf(
  rawBody: Buffer,
  headers: TransmissionHeaders,
  overrideWebhookId?: string,
): Promise<VerificationResult> {
  const started = performance.now();
  const done = (verified: boolean, reason?: string): VerificationResult => ({
    verified,
    method: "self",
    ...(reason ? { reason } : {}),
    durationMs: Math.round(performance.now() - started),
  });

  const { transmissionId, transmissionTime, transmissionSig, certUrl } = headers;
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) {
    return done(false, "missing one or more paypal-transmission-* headers");
  }

  try {
    const id = overrideWebhookId ?? webhookId();
    const message = buildSignedMessage(transmissionId, transmissionTime, id, rawBody);

    const pem = await fetchCertificate(certUrl);
    const verifier = crypto.createVerify("sha256WithRSAEncryption");
    verifier.update(message);
    const ok = verifier.verify(pem, Buffer.from(transmissionSig, "base64"));

    return done(ok, ok ? undefined : "signature did not match — wrong webhook id, or a forged event");
  } catch (err) {
    return done(false, (err as Error).message);
  }
}

/**
 * Verify by asking PayPal.
 *
 * Note `webhook_event` is the PARSED body here, which is what the endpoint
 * expects — but it must round-trip byte-identically, so we parse the raw bytes
 * once and send that object straight back without touching it.
 *
 * Does not work for the dashboard's mock/simulator events; those can only be
 * verified with the self method (their webhook id is the literal "WEBHOOK_ID").
 */
export async function verifyPostback(
  rawBody: Buffer,
  headers: TransmissionHeaders,
  overrideWebhookId?: string,
): Promise<VerificationResult> {
  const started = performance.now();
  const done = (verified: boolean, reason?: string): VerificationResult => ({
    verified,
    method: "postback",
    ...(reason ? { reason } : {}),
    durationMs: Math.round(performance.now() - started),
  });

  try {
    const body = {
      transmission_id: headers.transmissionId,
      transmission_time: headers.transmissionTime,
      cert_url: headers.certUrl,
      auth_algo: headers.authAlgo ?? "SHA256withRSA",
      transmission_sig: headers.transmissionSig,
      webhook_id: overrideWebhookId ?? webhookId(),
      webhook_event: JSON.parse(rawBody.toString("utf8")),
    };

    const res = await call<{ verification_status: "SUCCESS" | "FAILURE" }>({
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      body,
      quiet: true,
    });

    const ok = res.data.verification_status === "SUCCESS";
    return done(ok, ok ? undefined : `PayPal replied verification_status=${res.data.verification_status}`);
  } catch (err) {
    return done(false, (err as Error).message);
  }
}

/**
 * Verify first, parse second — and only ever return an event if verification
 * succeeded. There is deliberately no way to get the parsed body out of this
 * function on the failure path, so a caller cannot accidentally act on an
 * unverified event.
 */
export async function verifyAndParse(
  rawBody: Buffer,
  rawHeaders: Record<string, unknown>,
  method: VerificationMethod = "self",
  overrideWebhookId?: string,
): Promise<{ result: VerificationResult; event?: WebhookEvent }> {
  const headers = readTransmissionHeaders(rawHeaders);

  const result =
    method === "postback"
      ? await verifyPostback(rawBody, headers, overrideWebhookId)
      : await verifySelf(rawBody, headers, overrideWebhookId);

  if (!result.verified) return { result };

  try {
    return { result, event: JSON.parse(rawBody.toString("utf8")) as WebhookEvent };
  } catch {
    return { result: { ...result, verified: false, reason: "verified bytes were not valid JSON" } };
  }
}

/**
 * Is this event queryable yet?
 *
 * An event that has just been delivered is not immediately addressable by id —
 * there is a propagation delay before `GET .../webhooks-events/{id}` finds it,
 * and asking to resend before then returns 404 INVALID_RESOURCE_ID. That 404
 * is about the event, not about your credentials.
 */
export async function isEventQueryable(eventId: string): Promise<boolean> {
  try {
    await call({ method: "GET", path: `/v1/notifications/webhooks-events/${eventId}`, quiet: true });
    return true;
  } catch {
    return false;
  }
}

export interface ResendOutcome {
  ok: boolean;
  /** Which body shape worked, for the record. */
  variant?: "no-body" | "webhook_ids";
  status?: number;
  reason?: string;
}

/**
 * Resend an event — the API twin of the dashboard's Resend button.
 *
 * Two body shapes are attempted, because the reference documents `webhook_ids`
 * as optional without saying what omitting it does, and the endpoint is not
 * consistently forgiving. Neither is guaranteed to work for a given event, so
 * this returns an outcome rather than throwing: the dashboard button is always
 * available, and a demo should not die because an optional convenience did.
 */
export async function resendEvent(eventId: string, toWebhookId?: string): Promise<ResendOutcome> {
  const target = toWebhookId ?? (hasWebhookIdConfigured() ? webhookId() : undefined);

  const attempts: Array<{ variant: ResendOutcome["variant"]; body: unknown }> = [
    { variant: "no-body", body: {} },
    ...(target ? [{ variant: "webhook_ids" as const, body: { webhook_ids: [target] } }] : []),
  ];

  let last: ResendOutcome = { ok: false, reason: "no attempt made" };

  for (const attempt of attempts) {
    try {
      const res = await call({
        method: "POST",
        path: `/v1/notifications/webhooks-events/${eventId}/resend`,
        body: attempt.body,
        quiet: true,
      });
      return { ok: true, variant: attempt.variant, status: res.status };
    } catch (err) {
      const status = err instanceof PayPalApiError ? err.status : undefined;
      last = {
        ok: false,
        variant: attempt.variant,
        ...(status ? { status } : {}),
        reason: (err as Error).message,
      };
    }
  }

  return last;
}

export async function listRecentEvents(pageSize = 10): Promise<{ events?: WebhookEvent[] }> {
  const res = await call<{ events?: WebhookEvent[] }>({
    method: "GET",
    path: `/v1/notifications/webhooks-events?page_size=${pageSize}`,
  });
  return res.data;
}

export { API_BASE };
