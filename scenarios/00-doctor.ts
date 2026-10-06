/**
 * SCENARIO 0 — Is this thing set up correctly?
 *
 *   npm run doctor
 *
 * Run this first, and run it again whenever something stops working. It checks
 * every part of the setup in the order the setup happens, and each failure
 * names the exact page or file that fixes it.
 *
 * This exists because "the webhook isn't arriving" has about six causes and
 * five of them are configuration. Guessing between them on camera is not fun.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import {
  ROOT,
  API_BASE,
  PORT,
  PUBLIC_BASE_URL,
  env as payPalEnv,
  hasWebhookId,
  isLive,
} from "../src/config.js";
import { describeToken } from "../src/paypal/auth.js";
import { call } from "../src/paypal/client.js";
import { createOrder } from "../src/paypal/orders.js";
import { bad, blank, c, fact, note, ok, step, title, warn } from "../src/log.js";

interface Check {
  name: string;
  state: "pass" | "fail" | "skip";
  detail: string;
  fix?: string;
}

const checks: Check[] = [];

function pass(name: string, detail: string): void {
  checks.push({ name, state: "pass", detail });
  ok(`${name} — ${detail}`);
}

function fail(name: string, detail: string, fix: string): void {
  checks.push({ name, state: "fail", detail, fix });
  bad(`${name} — ${detail}`);
  note(`fix: ${fix}`);
}

function skip(name: string, detail: string): void {
  checks.push({ name, state: "skip", detail });
  warn(`${name} — ${detail}`);
}

title("0 · Setup check", "every step of the setup, in the order you did it");

// ---------------------------------------------------------------------------
step(1, "Local configuration");

// zlib.crc32 (webhook verification) and process.loadEnvFile (config) both
// need Node 22. Without this check they fail with errors that look nothing
// like "your Node is too old".
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) {
  pass("Node version", `v${process.versions.node}`);
} else {
  fail(
    "Node version",
    `v${process.versions.node} — this repo needs 22 or newer`,
    "install Node 22+ (nvm install 22), then re-run npm install",
  );
}

if (existsSync(path.join(ROOT, ".env"))) {
  pass(".env exists", "credentials will be loaded from it");
} else {
  fail(".env is missing", "no credentials to load", "cp .env.example .env, then fill in your sandbox app credentials");
}

if (isLive()) {
  // Stop here, before step 3 creates an order. Against live credentials that
  // would be a real order on a real merchant account. A warning is not enough
  // when the next check has a side effect.
  bad("environment — PAYPAL_ENV=live");
  note("This repo is sandbox only. Every scenario refuses to run against live,");
  note("and the checks below create real orders, so the doctor stops here too.");
  note("fix: set PAYPAL_ENV=sandbox in .env, or drop the inline override if you set one");
  blank();
  process.exit(1);
}
pass("environment", `${payPalEnv} → ${API_BASE}`);

// ---------------------------------------------------------------------------
step(2, "Credentials");

let authenticated = false;
try {
  const token = await describeToken();
  pass("OAuth client credentials", `token ${token.tokenPreview}, valid ${token.expiresInMinutes} more minutes`);
  fact("scopes granted", token.scopeCount);
  authenticated = true;
} catch (err) {
  fail(
    "OAuth client credentials",
    (err as Error).message.split("\n")[0] ?? "could not get an access token",
    "check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET came from the SANDBOX tab at https://developer.paypal.com/dashboard/applications/sandbox",
  );
}

// ---------------------------------------------------------------------------
step(3, "Orders API");

if (!authenticated) {
  skip("Orders API", "skipped — no access token");
} else {
  try {
    const { data: order } = await createOrder({
      amount: "1.00",
      description: "doctor check — never captured",
      customId: "doctor",
    });
    pass("Orders API", `created and abandoned order ${order.id} (nothing was charged)`);
  } catch (err) {
    fail("Orders API", (err as Error).message, "confirm the app has Orders enabled in the dashboard");
  }
}

// ---------------------------------------------------------------------------
step(4, "Sandbox negative testing");

// Negative testing has to be switched on for the sandbox business account.
// `npm run errors` degrades gracefully without it, but discovering that
// mid-take is not fun — so ask the API directly.
if (!authenticated) {
  skip("negative testing", "skipped — no access token");
} else {
  try {
    await call({
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] },
      mockApplicationCode: "INTERNAL_SERVER_ERROR",
      quiet: true,
    });
    fail(
      "negative testing",
      "the PayPal-Mock-Response header was ignored — the order was created normally",
      "enable Negative Testing for your sandbox business account at https://developer.paypal.com/tools/sandbox/negative-testing/, then re-run",
    );
  } catch {
    // Any error here means the mock header was honoured, which is the point.
    pass("negative testing", "the mock header is being honoured — `npm run errors` will work");
  }
}

// ---------------------------------------------------------------------------
step(5, "Webhook subscription");

if (!authenticated) {
  skip("Webhook subscription", "skipped — no access token");
} else if (!hasWebhookId()) {
  fail(
    "PAYPAL_WEBHOOK_ID",
    "not set — every incoming webhook will be rejected, correctly",
    "copy one of the ids below into .env, or create a webhook first (see below)",
  );

  // The id is awkward to find in the dashboard, and we are already
  // authenticated, so just list what this app has registered.
  try {
    const { data } = await call<{
      webhooks?: Array<{ id: string; url: string }>;
    }>({ method: "GET", path: "/v1/notifications/webhooks", quiet: true });

    if (data.webhooks?.length) {
      blank();
      note("webhooks already registered for these credentials:");
      for (const w of data.webhooks) {
        console.log(`     ${c.bold(w.id)}  ${c.grey("→")}  ${c.grey(w.url)}`);
      }
      blank();
      note("put the id whose URL matches your tunnel into .env as PAYPAL_WEBHOOK_ID");
    } else {
      blank();
      note("no webhooks are registered for these credentials yet");
      note("Dashboard → Apps & Credentials → your sandbox app → scroll to Webhooks");
      note("→ Add Webhook → paste <your tunnel URL>/webhooks/paypal → select All Events");
      note("the id then appears in the Webhook ID column of that same table");
      blank();
    }
  } catch {
    note("could not list existing webhooks — check the credentials above first");
  }
} else {
  try {
    const { data } = await call<{
      webhooks?: Array<{ id: string; url: string; event_types?: Array<{ name: string }> }>;
    }>({ method: "GET", path: "/v1/notifications/webhooks", quiet: true });

    const configured = process.env.PAYPAL_WEBHOOK_ID?.trim();
    const match = data.webhooks?.find((w) => w.id === configured);

    if (!match) {
      fail(
        "PAYPAL_WEBHOOK_ID",
        `id ${configured} is not among the ${data.webhooks?.length ?? 0} webhooks registered for this app`,
        "copy the webhook id shown in the dashboard for THIS app; verification uses it to build the signed message",
      );
      for (const w of data.webhooks ?? []) note(`registered: ${w.id}  →  ${w.url}`);
    } else {
      pass("PAYPAL_WEBHOOK_ID", `matches a registered webhook`);
      fact("delivering to", match.url);
      fact("event types", String(match.event_types?.length ?? 0));

      const wanted = [
        "PAYMENT.CAPTURE.COMPLETED",
        "CHECKOUT.ORDER.APPROVED",
        "BILLING.SUBSCRIPTION.ACTIVATED",
        "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      ];
      const subscribed = new Set((match.event_types ?? []).map((e) => e.name));
      const all = subscribed.has("*");
      const missing = wanted.filter((w) => !all && !subscribed.has(w));

      if (all) {
        pass("event types", "subscribed to all events (*)");
      } else if (missing.length === 0) {
        pass("event types", "every event these demos need is subscribed");
      } else {
        fail(
          "event types",
          `not subscribed to: ${missing.join(", ")}`,
          "edit the webhook in the dashboard and add those events, or select all events",
        );
      }

      if (PUBLIC_BASE_URL && !match.url.startsWith(PUBLIC_BASE_URL)) {
        warn(`the registered URL (${match.url}) does not match PUBLIC_BASE_URL (${PUBLIC_BASE_URL})`);
        note("a restarted tunnel usually means a new URL — update the webhook in the dashboard");
      }
    }
  } catch (err) {
    fail("Webhook subscription", (err as Error).message, "confirm the app has webhooks configured");
  }
}

// ---------------------------------------------------------------------------
step(6, "Local server and tunnel");

const health = await fetch(`http://localhost:${PORT}/api/health`)
  .then((r) => r.json() as Promise<Record<string, unknown>>)
  .catch(() => null);

if (health) {
  pass("local server", `listening on http://localhost:${PORT}, verifying via ${String(health.verificationMethod)}`);
} else {
  skip("local server", `nothing on http://localhost:${PORT} — run \`npm run server\``);
  note("only needed for the webhook and checkout demos; everything else runs without it");
}

if (!PUBLIC_BASE_URL) {
  skip("tunnel", "PUBLIC_BASE_URL is unset — set it once your tunnel is running");
} else if (!health) {
  // A tunnel forwards to localhost:PORT. With nothing listening there it
  // cannot respond however healthy it is, so testing it now would blame the
  // tunnel for the server being down.
  skip("tunnel", "cannot be tested while the local server is down — it forwards to a closed port");
  note(`configured: ${PUBLIC_BASE_URL}`);
} else {
  const reachable = await fetch(`${PUBLIC_BASE_URL}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (reachable) {
    pass("tunnel", `${PUBLIC_BASE_URL} reaches this machine`);
    fact("webhook URL to register", `${PUBLIC_BASE_URL}/webhooks/paypal`);
  } else {
    fail(
      "tunnel",
      `${PUBLIC_BASE_URL} did not respond, though the local server is up`,
      "the tunnel is down or its URL changed. Restart it, update PUBLIC_BASE_URL, and update the webhook URL in the dashboard",
    );
  }
}

// ---------------------------------------------------------------------------
blank();
const failed = checks.filter((c) => c.state === "fail");
const skipped = checks.filter((c) => c.state === "skip");

console.log(
  `  ${c.bold("Result:")} ${c.green(`${checks.filter((c) => c.state === "pass").length} passed`)}` +
    (failed.length ? `, ${c.red(`${failed.length} failed`)}` : "") +
    (skipped.length ? `, ${c.grey(`${skipped.length} skipped`)}` : ""),
);

if (failed.length) {
  blank();
  for (const f of failed) console.log(`     ${c.red("✘")} ${f.name}: ${c.grey(f.fix ?? "")}`);
  process.exitCode = 1;
} else {
  blank();
  console.log(`  ${c.green("Ready.")} ${c.grey("Start with:  npm run checkout")}`);
}
blank();
