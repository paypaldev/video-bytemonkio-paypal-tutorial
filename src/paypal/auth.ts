/**
 * OAuth 2.0 client credentials.
 *
 * Your client ID and secret are not the thing you send to the API. You trade
 * them, once, for a short-lived bearer token, and send that. This is the first
 * place the "systems that don't fully trust each other" framing shows up: the
 * long-lived secret stays on your server and never travels with a payment
 * request.
 *
 * Reference: https://developer.paypal.com/api/rest/authentication/
 */

import { API_BASE, clientId, clientSecret } from "../config.js";
import { PayPalApiError, type PayPalErrorBody } from "./errors.js";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  app_id?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  scopeCount: number;
}

let cached: CachedToken | null = null;

/**
 * Tokens are valid for hours. Fetching one per API call would be both slow and
 * rude; caching it is what a real integration does. We refresh 60s early so a
 * token can never expire mid-flight.
 */
export async function getAccessToken(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  const text = await res.text();
  if (!res.ok) {
    let body: PayPalErrorBody;
    try {
      body = JSON.parse(text) as PayPalErrorBody;
    } catch {
      body = { message: text };
    }
    // The single most common first-run failure: credentials pasted from the
    // Live tab into a sandbox .env, or a trailing newline in the secret.
    if (res.status === 401) {
      body.message =
        (body.message ?? body.error_description ?? "Invalid credentials") +
        " — check that PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET came from the SANDBOX tab of your app, with no stray whitespace.";
    }
    throw new PayPalApiError(res.status, body);
  }

  const data = JSON.parse(text) as TokenResponse;
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    scopeCount: data.scope ? data.scope.split(" ").length : 0,
  };
  return cached.token;
}

/** Details worth printing once at the start of a demo, without the token itself. */
export async function describeToken(): Promise<{
  expiresInMinutes: number;
  scopeCount: number;
  tokenPreview: string;
}> {
  const token = await getAccessToken();
  const info = cached!;
  return {
    expiresInMinutes: Math.round((info.expiresAt - Date.now()) / 60000),
    scopeCount: info.scopeCount,
    // Enough to prove a token exists; never enough to use one.
    tokenPreview: `${token.slice(0, 6)}…${token.slice(-4)}`,
  };
}

/** Called by the 401 path in callWithRetry, and by the tests. */
export function clearTokenCache(): void {
  cached = null;
}
