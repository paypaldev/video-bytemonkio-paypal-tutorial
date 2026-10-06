/**
 * Configuration and credential loading.
 *
 * Credentials come from .env only. There is deliberately no fallback, no
 * bundled "demo" client ID, and no committed default — a missing credential
 * fails loudly with the exact dashboard page you need to visit, rather than
 * silently calling the wrong account.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Node 22 loads .env natively — no dotenv dependency needed.
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export class MissingConfigError extends Error {
  constructor(key: string, where: string) {
    super(
      `Missing ${key} in .env\n\n` +
        `  Where to get it: ${where}\n` +
        `  Then: cp .env.example .env  and fill it in.\n` +
        `  Run  npm run doctor  to check your whole setup at once.\n`,
    );
    this.name = "MissingConfigError";
  }
}

function required(key: string, where: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new MissingConfigError(key, where);
  return value;
}

function optional(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

const DASHBOARD_APPS = "https://developer.paypal.com/dashboard/applications/sandbox";
const DASHBOARD_WEBHOOKS = "https://developer.paypal.com/dashboard/applications/sandbox (open your app → Webhooks)";

export const env = optional("PAYPAL_ENV", "sandbox").toLowerCase();

/** api-m is PayPal's current REST host. Sandbox and live differ only here. */
export const API_BASE =
  env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

/** Where the buyer approves. Used for building/reading approve links. */
export const WEB_BASE = env === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";

export const PORT = Number(optional("PORT", "8888"));
export const CURRENCY = optional("CURRENCY", "USD");
export const BUYER_COUNTRY = optional("BUYER_COUNTRY", "US");
export const PUBLIC_BASE_URL = optional("PUBLIC_BASE_URL");

/** Server-only secret. Never send this to the browser. */
export function clientSecret(): string {
  return required("PAYPAL_CLIENT_SECRET", DASHBOARD_APPS);
}

/** Browser-safe. This one legitimately ships to the frontend. */
export function clientId(): string {
  return required("PAYPAL_CLIENT_ID", DASHBOARD_APPS);
}

/**
 * Required for webhook signature verification. Without it you cannot verify
 * anything — you can only *hope* the POST came from PayPal.
 */
export function webhookId(): string {
  return required("PAYPAL_WEBHOOK_ID", DASHBOARD_WEBHOOKS);
}

export function hasWebhookId(): boolean {
  return Boolean(process.env.PAYPAL_WEBHOOK_ID?.trim());
}

export function isLive(): boolean {
  return env === "live";
}

/**
 * Directory for local run state. Git-ignored; safe to delete at any time.
 * Overridable so the tests can use a temp directory instead of trampling the
 * state from a demo run you have half-recorded.
 */
export const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(ROOT, ".data");
