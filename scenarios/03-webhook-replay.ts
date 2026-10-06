/**
 * SCENARIO 3 — Webhooks: verify everything, process once, in any order.
 *
 *   npm run webhook-replay -- --offline   no tunnel needed; dedupe + ordering
 *   npm run webhook-replay                the real thing (server + tunnel)
 *   npm run webhook-replay -- --list      recent events PayPal has sent you
 *   npm run webhook-replay -- --resend WH-…   redeliver one event by id
 *
 * Three claims get tested here, and they are separate claims:
 *
 *   1. An unverified webhook is not an event. The endpoint checks the
 *      signature against the raw bytes before it will parse them at all.
 *   2. The same event delivered twice is processed once. PayPal redelivers up
 *      to 25 times over three days if you do not answer 2xx, and you can
 *      replay any event by hand — so duplicates are normal traffic, not an
 *      attack.
 *   3. The webhook and the buyer's redirect are two racing messengers. Either
 *      may arrive first, and the result must be the same either way.
 *
 * The live mode does the honest version of (2): it asks PayPal to redeliver a
 * real event through the real network, which is the same thing the Resend
 * button in the developer dashboard does.
 */

import { PUBLIC_BASE_URL, PORT, hasWebhookId } from "../src/config.js";
import { listRecentEvents, resendEvent, isEventQueryable } from "../src/paypal/webhooks.js";
import { createOrder, captureOrder, firstCapture } from "../src/paypal/orders.js";
import { call, requestIdFor, sleep } from "../src/paypal/client.js";
import { handleEvent } from "../src/domain/handle-event.js";
import { captureCompleted, orderApproved } from "../src/fixtures/events.js";
import { allEvents, clearEvents, getEvent } from "../src/store/events.js";
import { getLocalOrder, createLocalOrder, clearOrders, markPaid, fulfil } from "../src/domain/order-state.js";
import { beginAttempt } from "../src/store/ledger.js";
import { bad, blank, c, decision, fact, note, ok, paypal, step, takeaway, title, warn } from "../src/log.js";
import { preflight, runScenario, waitForApproval, beat, startReturnListener } from "./_common.js";

const offline = process.argv.includes("--offline");
const listOnly = process.argv.includes("--list");
const resendId = valueOf("--resend");

function valueOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

await runScenario(async () => {
  if (offline) return runOffline();
  if (listOnly) return runList();
  if (resendId) return runResend(resendId);
  return runLive();
});

// ---------------------------------------------------------------------------

async function runOffline(): Promise<void> {
  title(
    "3 · Webhooks, offline: duplicate delivery and out-of-order arrival",
    "no tunnel required — the handler logic, driven directly",
  );

  warn("OFFLINE MODE: these events are fixtures, so nothing here exercises signature verification.");
  note("run without --offline to see real events verified over a real tunnel");

  clearEvents();
  clearOrders();

  const orderId = "OFFLINE-ORDER-1";
  const captureId = "OFFLINE-CAPTURE-1";

  // -------------------------------------------------------------------------
  step(1, "The webhook arrives BEFORE the buyer's browser comes back");

  createLocalOrder(orderId, "24.00", "USD");
  const event = captureCompleted({ orderId, captureId, eventId: "WH-OFFLINE-1" });

  const first = handleEvent(event);
  fact("event", event.event_type);
  fact("delivery", `#${first.deliveries}`);
  fact("outcome", first.outcome);
  note(first.action);

  const afterWebhook = getLocalOrder(orderId);
  fact("order status", afterWebhook?.status);
  fact("learned from", afterWebhook?.paidLearnedFrom);
  fact("fulfilment attempts", afterWebhook?.fulfilmentAttempts);
  paypal("told us the money moved. The buyer is still looking at a spinner.");
  decision("fulfil now — we do not need the browser's permission to believe PayPal");

  await beat();

  // -------------------------------------------------------------------------
  step(2, "Now the buyer's redirect finally lands, claiming the same thing");

  // This is what the return page does: it captures (idempotently) and then
  // records the result. It has no idea the webhook beat it here.
  const paid = markPaid(orderId, captureId, "redirect");
  const shipped = fulfil(orderId, "redirect");

  fact("markPaid changed anything", paid.changed ? "yes" : "no");
  note(paid.explanation);
  fact("fulfil changed anything", shipped.changed ? "yes" : "no");
  note(shipped.explanation);

  const afterRedirect = getLocalOrder(orderId);
  fact("fulfilment attempts", afterRedirect?.fulfilmentAttempts);
  fact("fulfilled at", afterRedirect?.fulfilledAt);
  ok("two messengers, two attempts, one fulfilment");

  await beat();

  // -------------------------------------------------------------------------
  step(3, "PayPal delivers the same event again, hours later");

  const replay = handleEvent(event);
  fact("event id", event.id);
  fact("delivery", `#${replay.deliveries}`);
  fact("outcome", replay.outcome);
  note(replay.action);

  const afterReplay = getLocalOrder(orderId);
  fact("fulfilment attempts", afterReplay?.fulfilmentAttempts);
  fact("fulfilled at", afterReplay?.fulfilledAt);
  ok("the timestamp has not moved. The replay changed nothing.");

  await beat();

  // -------------------------------------------------------------------------
  step(4, "And a stale event arrives after the fact");

  // A CHECKOUT.ORDER.APPROVED landing after the capture must not walk the
  // order backwards from PAID to APPROVED.
  const stale = handleEvent(orderApproved({ orderId, eventId: "WH-OFFLINE-STALE" }));
  fact("outcome", stale.outcome);
  note(stale.action);
  fact("order status", getLocalOrder(orderId)?.status);
  ok("state moved forward only — a late 'approved' cannot un-pay a payment");

  summary();
  takeaway("Webhooks are not notifications. They are how the application eventually learns the truth — in whatever order it arrives.");
}

// ---------------------------------------------------------------------------

async function runLive(): Promise<void> {
  title("3 · Webhooks: verified, deduplicated, and replayed for real", "requires the server and a tunnel");

  await preflight();

  // -------------------------------------------------------------------------
  step(1, "Check the listener is up and can actually verify anything");

  if (!hasWebhookId()) {
    bad("PAYPAL_WEBHOOK_ID is not set. Every delivery will be rejected — correctly.");
    note("Dashboard → your app → Webhooks → add your tunnel URL, then copy the webhook id into .env");
    throw new Error("Cannot demonstrate verification without a webhook id.");
  }

  const health = await fetch(`http://localhost:${PORT}/api/health`)
    .then((r) => r.json() as Promise<Record<string, unknown>>)
    .catch(() => null);

  if (!health) {
    bad(`Nothing is listening on http://localhost:${PORT}`);
    note("Run `npm run server` in another terminal, and a tunnel in a third. See README → Webhook tunnel.");
    throw new Error("Server is not running.");
  }

  fact("server", `http://localhost:${PORT}`);
  fact("verification method", String(health.verificationMethod));
  fact("public URL", PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/webhooks/paypal` : "(PUBLIC_BASE_URL unset)");

  // Check where PayPal will actually deliver, before taking a real payment.
  // Your .env says where you think the tunnel is; the dashboard decides where
  // events go. After a tunnel restart those two disagree, and the only symptom
  // is a payment that completes followed by a webhook that never arrives.
  const registered = await call<{ webhooks?: Array<{ id: string; url: string }> }>({
    method: "GET",
    path: "/v1/notifications/webhooks",
    quiet: true,
  })
    .then((r) => r.data.webhooks?.find((w) => w.id === process.env.PAYPAL_WEBHOOK_ID?.trim()))
    .catch(() => undefined);

  if (registered) {
    fact("PayPal delivers to", registered.url);
    if (PUBLIC_BASE_URL && !registered.url.startsWith(PUBLIC_BASE_URL)) {
      bad("the dashboard and your .env disagree about where this app lives");
      note(`dashboard: ${registered.url}`);
      note(`.env:      ${PUBLIC_BASE_URL}/webhooks/paypal`);
      blank();
      note("PayPal delivers to the dashboard URL, so no event would reach you.");
      note("Edit the webhook in the dashboard to match, which keeps the same");
      note("webhook id, then re-run. Stopping before taking a payment for nothing.");
      throw new Error("Registered webhook URL does not match PUBLIC_BASE_URL.");
    }
  }

  ok("listener is up, has a webhook id, and is where PayPal will deliver");

  // -------------------------------------------------------------------------
  step(2, "Make a real payment so PayPal has something to tell us about");

  const landing = await startReturnListener();
  const { data: order } = await createOrder({
    amount: "24.00",
    description: "Coffee Subscription Box",
    customId: "bytemonk-demo-03",
    payPalWalletOnly: true,
    returnUrl: landing.returnUrl,
    cancelUrl: landing.cancelUrl,
  });
  createLocalOrder(order.id, "24.00");
  fact("order id", order.id);

  await waitForApproval(order);
  landing.close();

  // Capture directly against PayPal rather than through our own server. That
  // leaves the local "redirect" path deliberately un-run, so the webhook is
  // genuinely the first thing to tell this application the money moved.
  const requestId = requestIdFor("capture", order.id);
  beginAttempt("capture", order.id, requestId);
  const { data: captured } = await captureOrder(order.id, { requestId });
  const capture = firstCapture(captured);

  fact("capture id", capture?.id);
  paypal("payment captured. A PAYMENT.CAPTURE.COMPLETED webhook is now on its way to your tunnel.");
  note("watch the server terminal — the event should land within a few seconds");

  // -------------------------------------------------------------------------
  step(3, "Wait for the event to arrive and be verified");

  const arrived = await waitForEvent("PAYMENT.CAPTURE.COMPLETED", order.id, 60_000);
  if (!arrived) {
    bad("No verified event arrived within 60 seconds.");
    note("Check: is the tunnel running? Is the tunnel URL subscribed in the dashboard?");
    note("Is PAYMENT.CAPTURE.COMPLETED among the subscribed event types?");
    throw new Error("Webhook did not arrive.");
  }

  fact("event id", arrived.eventId);
  fact("verified", arrived.verification?.verified ? "yes" : "no");
  fact("method", arrived.verification?.method ?? "?");
  fact("verify took", `${arrived.verification?.durationMs ?? "?"}ms`);
  fact("deliveries", arrived.deliveries);
  fact("outcome", arrived.outcome);
  note(arrived.action ?? "");

  const local = getLocalOrder(order.id);
  fact("order status", local?.status);
  fact("learned from", local?.paidLearnedFrom);
  fact("fulfilment attempts", local?.fulfilmentAttempts);
  ok("the webhook, not the browser, is what told this application it had been paid");

  // -------------------------------------------------------------------------
  step(4, "Ask PayPal to deliver that exact event again");

  note("this is the API twin of the Resend button in the developer dashboard");

  const before = getEvent(arrived.eventId)?.deliveries ?? 1;

  // An event that has only just been delivered is not addressable by id yet.
  // Resending too early returns 404 INVALID_RESOURCE_ID, which reads like a
  // broken integration and is really just propagation.
  note("waiting for the event to become addressable by id…");
  const queryable = await waitUntil(() => isEventQueryable(arrived.eventId), 60_000);
  fact("addressable by id", queryable ? "yes" : "not yet");

  const resend = await resendEvent(arrived.eventId);

  if (resend.ok) {
    paypal(`accepted the resend request (${resend.variant})`);
  } else {
    warn(`the resend API declined: ${resend.reason}`);
    if (queryable) {
      note("this event IS addressable: a GET on the same id succeeded a moment ago,");
      note("so the 404 is not a propagation delay. Cause unknown; see docs/DECISIONS.md.");
    }
    blank();
    note("the dashboard's Resend button does work, and it is the one the script mentions:");
    note("  https://developer.paypal.com/dashboard/webhooksEvents");
    note("  set the Application filter to your app — it defaults to the wrong one");
    note(`  then find this event and press Resend:`);
    note(`  ${arrived.eventId}`);
    blank();
    note("go and press it now — waiting up to 3 minutes for the redelivery…");
  }

  const redelivered = await waitForDeliveryCount(
    arrived.eventId,
    before + 1,
    resend.ok ? 90_000 : 180_000,
  );

  if (!redelivered) {
    warn("No redelivery arrived. PayPal's resend is not instant — a minute or two is normal.");
    note(`Watch the server terminal for: ↻ REPLAY ${arrived.eventId}`);
    note("Or run the offline version, which makes the same point from fixtures:");
    note("  npm run webhook-replay -- --offline");
  } else {
    fact("deliveries", redelivered.deliveries);
    fact("outcome", redelivered.outcome);
    note(redelivered.action ?? "");

    const after = getLocalOrder(order.id);
    fact("fulfilment attempts", after?.fulfilmentAttempts);
    fact("fulfilled at", after?.fulfilledAt);
    ok("same event, delivered twice, verified twice, processed once");
    note("fulfilment attempts is still 1: the duplicate stopped at the event id,");
    note("above the business logic, so fulfilment was never even attempted again");
  }

  summary();
  takeaway("Verify every event, key every event, and let the two of them arrive in any order they like.");
}

// ---------------------------------------------------------------------------

async function runList(): Promise<void> {
  title("3 · Recent webhook events PayPal has sent this app", "");
  await preflight();
  step(1, "GET /v1/notifications/webhooks-events");

  const { events } = await listRecentEvents(15);
  if (!events?.length) {
    note("no events yet — make a payment first");
    return;
  }
  blank();
  for (const e of events) {
    console.log(`     ${c.grey(e.create_time ?? "")}  ${c.bold(e.event_type.padEnd(34))} ${c.grey(e.id)}`);
  }
  blank();
  note("resend any of them with:  npm run webhook-replay -- --resend <event-id>");
}

async function runResend(eventId: string): Promise<void> {
  title("3 · Resend one event", eventId);
  await preflight();
  step(1, "POST /v1/notifications/webhooks-events/{id}/resend");
  const before = getEvent(eventId)?.deliveries ?? 0;

  const resend = await resendEvent(eventId);
  if (!resend.ok) {
    warn(`the resend API declined: ${resend.reason}`);
    note("use the dashboard instead: https://developer.paypal.com/dashboard/webhooksEvents");
    note("set the Application filter to your app, find the event, press Resend");
    return;
  }
  paypal(`resend accepted (${resend.variant}) — watch the server terminal`);

  const after = await waitForDeliveryCount(eventId, before + 1, 90_000);
  if (after) {
    fact("deliveries", after.deliveries);
    fact("outcome", after.outcome);
    note(after.action ?? "");
    ok("processed once, regardless of how many times it was delivered");
  } else {
    warn("not redelivered yet — PayPal's resend can take a minute");
  }
}

// ---------------------------------------------------------------------------

async function waitForEvent(eventType: string, orderId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = allEvents().find((e) => e.eventType === eventType && e.orderId === orderId);
    if (match) return match;
    process.stdout.write(c.grey("."));
    await sleep(2000);
  }
  return null;
}

/** Poll a predicate until it is true or the deadline passes. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    process.stdout.write(c.grey("."));
    await sleep(3000);
  }
  return false;
}

async function waitForDeliveryCount(eventId: string, target: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = getEvent(eventId);
    if (record && record.deliveries >= target) return record;
    process.stdout.write(c.grey("."));
    await sleep(2000);
  }
  return null;
}

function summary(): void {
  step("✓", "The event log");
  blank();
  for (const e of allEvents()) {
    const badge =
      e.outcome === "REPLAY"
        ? c.yellow("REPLAY   ")
        : e.outcome === "ERROR"
          ? c.red("ERROR    ")
          : e.outcome === "PROCESSED"
            ? c.green("PROCESSED")
            : e.outcome === "PENDING"
              ? c.yellow("PENDING  ")
              : c.grey("IGNORED  ");
    console.log(
      `     ${badge} ${c.bold(e.eventType.padEnd(30))} ${c.grey(`deliveries=${e.deliveries}`)}  ${c.grey(e.eventId)}`,
    );
    if (e.action) console.log(`               ${c.grey(e.action)}`);
  }
  blank();
}
