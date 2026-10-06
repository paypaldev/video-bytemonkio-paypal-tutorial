/**
 * The demo server: a checkout backend and a webhook listener.
 *
 * Two things about the route layout are deliberate and worth pointing at on
 * camera:
 *
 *   1. The webhook route is mounted with express.raw() and is registered
 *      BEFORE express.json(). Verification needs the exact bytes PayPal sent.
 *      Once a JSON body parser has touched the request, the original bytes are
 *      gone and the signature can never be checked again.
 *
 *   2. The browser never talks to PayPal's REST API. It asks this server to
 *      create and capture the order. The client secret stays here, the amount
 *      is decided here, and a hostile client cannot ask to be charged $0.
 */

import express from "express";
import path from "node:path";
import {
  PORT,
  ROOT,
  CURRENCY,
  BUYER_COUNTRY,
  clientId,
  hasWebhookId,
  isLive,
  PUBLIC_BASE_URL,
  env as payPalEnv,
} from "./config.js";
import { requestIdFor } from "./paypal/client.js";
import { captureOrder, createOrder, firstCapture, getOrder } from "./paypal/orders.js";
import { verifyAndParse, type VerificationMethod } from "./paypal/webhooks.js";
import { handleEvent, orderView } from "./domain/handle-event.js";
import { recordRejection, allEvents, allRejections, finishEvent } from "./store/events.js";
import { createLocalOrder, markPaid, fulfil, allLocalOrders } from "./domain/order-state.js";
import { beginAttempt, recordFailure, recordSuccess, getAttempt } from "./store/ledger.js";
import { isPaymentFailure, PayPalApiError } from "./paypal/errors.js";
import { allSubscriptions } from "./domain/subscription-state.js";
import { c, blank, fact, ok, warn, note } from "./log.js";

const app = express();

/**
 * A tiny in-memory catalogue. The price of an item is decided by the server,
 * never accepted from the browser — the oldest checkout vulnerability there is.
 */
const CATALOG: Record<string, { name: string; price: string }> = {
  "coffee-subscription-box": { name: "Coffee Subscription Box", price: "24.00" },
  "mechanical-keyboard": { name: "Mechanical Keyboard", price: "129.00" },
  "sticker-pack": { name: "Sticker Pack", price: "9.00" },
};

// ---------------------------------------------------------------------------
// Webhook listener — registered first, with the raw body parser.
// ---------------------------------------------------------------------------

const VERIFY_METHOD: VerificationMethod =
  process.env.WEBHOOK_VERIFY_METHOD === "postback" ? "postback" : "self";

app.post(
  "/webhooks/paypal",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const raw = req.body as Buffer;

    // Verify the bytes. Do not parse them yet. Do not log them as an "event"
    // yet. Until the signature checks out, this is an anonymous POST.
    const { result, event } = await verifyAndParse(raw, req.headers, VERIFY_METHOD);

    if (!result.verified || !event) {
      // Peek at the id purely so the rejection is greppable. Nothing from this
      // body is trusted or acted on.
      let peekId = "(unparseable)";
      let peekType = "(unknown)";
      try {
        const peek = JSON.parse(raw.toString("utf8"));
        peekId = peek?.id ?? peekId;
        peekType = peek?.event_type ?? peekType;
      } catch {
        /* deliberately ignored — untrusted input */
      }
      // Logged to a separate table, keyed on time rather than on the claimed
      // id. An attacker must not be able to overwrite the record of a genuine
      // event, or reserve an id so the real delivery is later mistaken for a
      // duplicate.
      recordRejection(peekId, peekType, { method: result.method, ...(result.reason ? { reason: result.reason } : {}) });

      console.log(
        `${c.red("✘ REJECTED")} ${peekType} ${c.grey(peekId)} — ${result.reason ?? "signature invalid"} ${c.grey(`(${result.method}, ${result.durationMs}ms)`)}`,
      );

      // 400, not 200: this did not come from PayPal, so there is nothing for
      // PayPal to stop retrying.
      res.status(400).json({ error: "webhook signature verification failed" });
      return;
    }

    let outcome;
    try {
      outcome = handleEvent(event);
    } catch (err) {
      // Handling a verified event should not be able to take the listener
      // down. Mark the claim as unfinished and answer non-2xx on purpose:
      // PayPal's redelivery is the retry mechanism, and claimEvent will let
      // the next delivery pick the work back up rather than call it a replay.
      finishEvent(event.id, { outcome: "ERROR", action: `handler threw: ${(err as Error).message}` });
      console.error(`${c.red("✘ HANDLER ERROR")} ${event.event_type} ${c.grey(event.id)}`, err);
      res.status(500).json({ error: "handler failed; please redeliver" });
      return;
    }

    // Keep the verification evidence alongside the event. "We processed it"
    // is only meaningful next to "and here is how we knew it was genuine".
    finishEvent(event.id, {
      verification: {
        method: result.method,
        verified: result.verified,
        durationMs: result.durationMs,
      },
    });

    const badge =
      outcome.outcome === "REPLAY"
        ? c.yellow("↻ REPLAY  ")
        : outcome.outcome === "PROCESSED"
          ? c.green("✔ PROCESSED")
          : c.grey("· IGNORED ");

    console.log(
      `${badge} ${c.bold(event.event_type)} ${c.grey(event.id)} ` +
        `${c.grey(`delivery #${outcome.deliveries}, verified in ${result.durationMs}ms via ${result.method}`)}`,
    );
    console.log(`            ${outcome.action}`);

    // Always 2xx once verified — including for replays and events we ignore.
    // A non-2xx tells PayPal to redeliver, and redelivering an event we
    // correctly chose to ignore just creates noise for three days.
    res.status(200).json({ received: true, ...outcome });
  },
);

// Everything below this line may safely have a parsed body.
app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

// ---------------------------------------------------------------------------
// Checkout backend
// ---------------------------------------------------------------------------

/** Browser-safe config for the frontend. Note: no secret is ever sent. */
app.get("/api/config", (_req, res) => {
  res.json({
    clientId: clientId(),
    currency: CURRENCY,
    // Sandbox-only. Forces Venmo eligibility for testing; never send in production.
    buyerCountry: isLive() ? undefined : BUYER_COUNTRY,
    environment: payPalEnv,
    catalog: CATALOG,
  });
});

/** Create an order. The browser sends an item id, never a price. */
app.post("/api/orders", async (req, res) => {
  const itemId = String(req.body?.itemId ?? "coffee-subscription-box");
  const item = CATALOG[itemId];
  if (!item) {
    res.status(400).json({ error: `unknown item: ${itemId}` });
    return;
  }

  try {
    const { data: order } = await createOrder({
      amount: item.price,
      description: item.name,
      customId: `bytemonk-${itemId}`,
      brandName: "ByteMonk Demo Store",
    });

    createLocalOrder(order.id, item.price, CURRENCY);
    console.log(`${c.blue("→ order created")} ${order.id} ${c.grey(`${item.price} ${CURRENCY} — status ${order.status}, nobody has paid yet`)}`);

    res.status(201).json({ id: order.id, status: order.status });
  } catch (err) {
    respondToFailure(res, err, "create order");
  }
});

/**
 * Capture an order.
 *
 * The request id is derived from the order id, so a double-clicking buyer, a
 * retried fetch and a restarted server all produce the SAME id — which is what
 * makes PayPal collapse them into one charge.
 */
app.post("/api/orders/:orderId/capture", async (req, res) => {
  const orderId = String(req.params.orderId);
  const requestId = requestIdFor("capture", orderId);

  const { fresh, entry } = beginAttempt("capture", orderId, requestId);
  if (!fresh) {
    console.log(
      `${c.yellow("↻ capture attempt")} ${orderId} ${c.grey(`attempt #${entry.attempts}, reusing PayPal-Request-Id ${entry.requestId}`)}`,
    );
  }

  try {
    const { data: order } = await captureOrder(orderId, { requestId: entry.requestId });
    const capture = firstCapture(order);

    recordSuccess("capture", orderId, { orderId, captureId: capture?.id, status: order.status });

    if (capture?.id) {
      // The redirect path. If the webhook already landed, markPaid reports no
      // change and fulfilment stays at exactly one — which is the whole point.
      const paid = markPaid(orderId, capture.id, "redirect", capture.amount?.value, capture.amount?.currency_code);
      const shipped = fulfil(orderId, "redirect");
      console.log(
        `${c.green("✔ captured")} ${orderId} → ${capture.id} ${c.grey(`| ${paid.explanation} | ${shipped.explanation}`)}`,
      );
    }

    res.json({
      id: order.id,
      status: order.status,
      captureId: capture?.id,
      amount: capture?.amount,
      requestId: entry.requestId,
      attempt: entry.attempts,
    });
  } catch (err) {
    if (err instanceof PayPalApiError) {
      recordFailure("capture", orderId, {
        status: err.status,
        name: err.body.name,
        issues: err.issues,
        debugId: err.debugId,
      });
    }
    respondToFailure(res, err, "capture order");
  }
});

/** What this application believes about an order, and how it found out. */
app.get("/api/orders/:orderId/state", (req, res) => {
  const view = orderView(String(req.params.orderId));
  const attempt = getAttempt("capture", String(req.params.orderId));
  res.json({ ...view, captureAttempt: attempt });
});

/**
 * What PayPal believes about an order. Useful side by side with the above.
 *
 * Note this proxies any order id in the merchant account, and the response
 * includes buyer details. Fine for a local demo, admin-only in anything real.
 */
app.get("/api/orders/:orderId/paypal", async (req, res) => {
  try {
    const { data } = await getOrder(String(req.params.orderId), true);
    res.json(data);
  } catch (err) {
    respondToFailure(res, err, "read order");
  }
});

// ---------------------------------------------------------------------------
// Inspection endpoints — these are what makes the demo watchable
// ---------------------------------------------------------------------------

app.get("/api/events", (_req, res) => res.json(allEvents()));
app.get("/api/rejections", (_req, res) => res.json(allRejections()));
app.get("/api/orders", (_req, res) => res.json(allLocalOrders()));
app.get("/api/subscriptions", (_req, res) => res.json(allSubscriptions()));
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    environment: payPalEnv,
    webhookIdConfigured: hasWebhookId(),
    verificationMethod: VERIFY_METHOD,
    publicBaseUrl: PUBLIC_BASE_URL || null,
  }),
);

/**
 * Translate a failure into an HTTP response.
 *
 * Three branches, three different responses — the same classification the
 * scenarios narrate, applied for real in the request path.
 */
function respondToFailure(res: express.Response, err: unknown, what: string): void {
  if (!isPaymentFailure(err)) {
    console.error(c.red(`✘ ${what} failed unexpectedly`), err);
    res.status(500).json({ error: "internal error" });
    return;
  }

  console.log(`${c.red(`✘ ${what}`)} ${c.grey(err.operatorMessage())} ${c.magenta(`→ ${err.handling}`)}`);

  switch (err.handling) {
    case "SHOW_CUSTOMER":
      // 200-with-a-decline would be a lie, but this is not the client's fault
      // either. 402 says "payment problem", and the body says what to show.
      res.status(402).json({ handling: err.handling, message: err.customerMessage() });
      return;
    case "FIX_REQUEST":
      res.status(400).json({
        handling: err.handling,
        message: "We couldn't process that request.",
        // debug_id goes to the operator, not to the buyer's screen.
        debugId: err instanceof PayPalApiError ? err.debugId : undefined,
      });
      return;
    case "RETRY":
      res.status(503).json({ handling: err.handling, message: err.customerMessage(), retryable: true });
      return;
  }
}

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  blank();
  console.log(c.bold(c.cyan("  PayPal demo server")));
  fact("environment", payPalEnv + (isLive() ? "  ⚠ LIVE" : ""));
  fact("checkout", `http://localhost:${PORT}/`);
  fact("webhook path", `/webhooks/paypal`);
  fact("verification", `${VERIFY_METHOD}${VERIFY_METHOD === "self" ? " (local signature check)" : " (postback to PayPal)"}`);

  if (hasWebhookId()) {
    ok("PAYPAL_WEBHOOK_ID is set — signatures can be verified");
  } else {
    warn("PAYPAL_WEBHOOK_ID is not set. Every webhook will be REJECTED.");
    note("Subscribe your tunnel URL in the dashboard, then put the webhook id in .env");
  }

  if (PUBLIC_BASE_URL) {
    fact("public URL", `${PUBLIC_BASE_URL}/webhooks/paypal`);
  } else {
    note("PUBLIC_BASE_URL is unset — start a tunnel and set it to see the exact URL to paste into the dashboard");
  }
  blank();
});
